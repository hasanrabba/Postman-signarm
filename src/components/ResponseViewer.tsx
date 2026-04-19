"use client";

import { useMemo, useState } from "react";
import type { TabState } from "@/lib/store";

type ResponseTab = "body" | "headers" | "tests" | "console";

export function ResponseViewer({ tab }: { tab: TabState }) {
  const [view, setView] = useState<ResponseTab>("body");
  const [pretty, setPretty] = useState(true);

  const resp = tab.response;
  const formatted = useMemo(() => {
    if (!resp) return "";
    if (!pretty) return resp.body;
    const ct = (resp.contentType || "").toLowerCase();
    if (ct.includes("json") || looksLikeJson(resp.body)) {
      try { return JSON.stringify(JSON.parse(resp.body), null, 2); } catch { /* noop */ }
    }
    return resp.body;
  }, [resp, pretty]);

  if (!resp) {
    return (
      <div className="flex-1 flex items-center justify-center text-signal-muted text-sm">
        Send a request to see the response here.
      </div>
    );
  }

  const statusClass =
    resp.status === 0 ? "text-signal-err"
    : resp.status < 300 ? "text-signal-ok"
    : resp.status < 400 ? "text-signal-warn"
    : "text-signal-err";

  return (
    <div className="flex-1 flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-signal-border bg-signal-panel text-xs">
        <span className={`font-bold ${statusClass}`}>
          {resp.status || "—"} {resp.statusText}
        </span>
        <span className="text-signal-muted">Time: {resp.elapsedMs}ms</span>
        <span className="text-signal-muted">Size: {formatBytes(resp.sizeBytes)}</span>
        {resp.error && <span className="text-signal-err">{resp.error}</span>}
        <div className="ml-auto flex gap-1">
          {(["body", "headers", "tests", "console"] as ResponseTab[]).map((t) => (
            <button key={t} className={`tab ${view === t ? "tab-active" : ""}`} onClick={() => setView(t)}>
              {t}
              {t === "tests" && tab.tests?.length ? <span className="ml-1 text-[10px] text-signal-muted">({tab.tests.length})</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {view === "body" && (
          <div className="p-0">
            <div className="flex items-center gap-2 px-3 py-1 border-b border-signal-border text-xs">
              <label className="flex items-center gap-1 text-signal-muted">
                <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> pretty
              </label>
              <button className="text-signal-muted hover:text-white ml-auto" onClick={() => navigator.clipboard.writeText(resp.body)}>Copy raw</button>
            </div>
            <pre className="font-mono text-xs p-3 whitespace-pre-wrap break-words">{formatted}</pre>
          </div>
        )}
        {view === "headers" && (
          <table className="w-full text-xs font-mono">
            <tbody>
              {Object.entries(resp.headers).map(([k, v]) => (
                <tr key={k} className="border-b border-signal-border">
                  <td className="px-3 py-1 text-signal-muted align-top">{k}</td>
                  <td className="px-3 py-1 break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === "tests" && (
          <div className="p-3 space-y-1">
            {!tab.tests?.length && <div className="text-xs text-signal-muted">No tests ran. Add assertions in the Tests tab.</div>}
            {tab.tests?.map((t, i) => (
              <div key={i} className={`text-xs ${t.passed ? "text-signal-ok" : "text-signal-err"}`}>
                {t.passed ? "✓" : "✗"} {t.name} {t.error ? <span className="text-signal-muted">— {t.error}</span> : null}
              </div>
            ))}
          </div>
        )}
        {view === "console" && (
          <pre className="p-3 text-xs font-mono whitespace-pre-wrap">
            {(tab.logs || []).join("\n") || "(no logs)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
