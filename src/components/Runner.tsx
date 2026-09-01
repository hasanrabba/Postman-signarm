"use client";

import { useState } from "react";
import { useStore, mergeVars } from "@/lib/store";
import { executeRequest } from "@/lib/executor";
import { secretsAsVars } from "@/lib/vault";
import type { SignalResponse, SignalRequest, TestResult } from "@/lib/types";

/**
 * Collection runner: sequentially executes every request in a collection and
 * aggregates test results. State mutations performed by scripts (sg.env.set,
 * sg.globals.set, sg.collection.set) are threaded into each subsequent
 * request so a login request can capture a token and the next request can
 * use it — matching Postman's runner semantics.
 */
export function Runner({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const { collections, environments, activeEnvId, globals, secrets } = useStore();
  const col = collections[collectionId];
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<{ name: string; response?: SignalResponse; tests: TestResult[] }[]>([]);

  if (!col) return null;

  const run = async () => {
    setRunning(true);
    setRows([]);

    const envOverrides: Record<string, string> = {};
    const globalOverrides: Record<string, string> = {};
    const collectionOverrides: Record<string, string> = {};

    const requests = flatten(col);
    for (const r of requests) {
      const scope = {
        global: mergeVars(globals, globalOverrides),
        environment: mergeVars(
          activeEnvId ? environments[activeEnvId]?.variables : undefined,
          envOverrides
        ),
        collection: mergeVars(col.variables, collectionOverrides),
        secrets: secretsAsVars(secrets),
      };
      const res = await executeRequest(r, { scope });
      Object.assign(envOverrides, res.envUpdates);
      Object.assign(globalOverrides, res.globalUpdates);
      Object.assign(collectionOverrides, res.collectionUpdates);
      setRows((prev) => [...prev, { name: r.name || r.url, response: res.response, tests: res.tests }]);
    }
    setRunning(false);
  };

  const passed = rows.flatMap((r) => r.tests).filter((t) => t.passed).length;
  const failed = rows.flatMap((r) => r.tests).filter((t) => !t.passed).length;

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center">
      <div className="w-[680px] bg-signal-panel border border-signal-border rounded shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center px-3 py-2 border-b border-signal-border">
          <div className="font-medium">Run collection: {col.name}</div>
          <button className="ml-auto btn" onClick={run} disabled={running}>{running ? "Running…" : "Run"}</button>
          <button className="ml-2 btn" onClick={onClose}>Close</button>
        </div>
        <div className="px-3 py-1 text-xs text-signal-muted border-b border-signal-border">
          {rows.length} requests · {passed} passed · {failed} failed
        </div>
        <div className="overflow-auto">
          {rows.map((r, i) => (
            <div key={i} className="px-3 py-2 border-b border-signal-border">
              <div className="flex items-center gap-2 text-sm">
                <span className={r.response && r.response.status > 0 && r.response.status < 400 ? "text-signal-ok" : "text-signal-err"}>
                  {r.response?.status ?? "—"}
                </span>
                <span className="flex-1 truncate">{r.name}</span>
                <span className="text-signal-muted text-xs">{r.response?.elapsedMs}ms</span>
              </div>
              {r.tests.map((t, k) => (
                <div key={k} className={`text-xs pl-4 ${t.passed ? "text-signal-ok" : "text-signal-err"}`}>
                  {t.passed ? "✓" : "✗"} {t.name} {t.error && <span className="text-signal-muted">— {t.error}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


function flatten(col: ReturnType<typeof useStore.getState>["collections"][string]): SignalRequest[] {
  const out: SignalRequest[] = [];
  const visit = (folderId: string) => {
    const f = col.folders[folderId];
    if (!f) return;
    for (const rid of f.requestIds) {
      const r = col.requests[rid];
      if (r) out.push(r);
    }
    for (const child of f.folderIds) visit(child);
  };
  visit(col.rootFolderId);
  return out;
}
