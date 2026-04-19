"use client";

import { useMemo, useState } from "react";
import type { TabState } from "@/lib/store";

type ResponseTab = "body" | "headers" | "tests" | "console";

export function ResponseViewer({ tab }: { tab: TabState }) {
  const [view, setView] = useState<ResponseTab>("body");
  const [pretty, setPretty] = useState(true);
  const [showBinaryAsText, setShowBinaryAsText] = useState(false);

  const resp = tab.response;
  const formatted = useMemo(() => {
    if (!resp) return "";
    if (resp.bodyIsBase64 && !showBinaryAsText) return "";
    if (!pretty) return resp.bodyIsBase64 ? decodeBase64ToText(resp.body) : resp.body;
    const body = resp.bodyIsBase64 ? decodeBase64ToText(resp.body) : resp.body;
    const ct = (resp.contentType || "").toLowerCase();
    if (ct.includes("json") || looksLikeJson(body)) {
      try { return JSON.stringify(JSON.parse(body), null, 2); } catch { /* noop */ }
    }
    if (ct.includes("xml") || ct.includes("html")) {
      try { return prettyXml(body); } catch { /* noop */ }
    }
    return body;
  }, [resp, pretty, showBinaryAsText]);

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

  const downloadBinary = () => {
    if (!resp.bodyIsBase64) return;
    const bin = atob(resp.body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: resp.contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = inferFilename(resp);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="flex-1 flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-signal-border bg-signal-panel text-xs">
        <span className={`font-bold ${statusClass}`}>
          {resp.status || "—"} {resp.statusText}
        </span>
        <span className="text-signal-muted">Time: {resp.elapsedMs}ms</span>
        <span className="text-signal-muted">Size: {formatBytes(resp.sizeBytes)}</span>
        {resp.finalUrl && (
          <span className="text-signal-muted truncate max-w-md" title={resp.finalUrl}>
            → {resp.finalUrl}
          </span>
        )}
        {resp.error && <span className="text-signal-err truncate max-w-md">{resp.error}</span>}
        <div className="ml-auto flex gap-1">
          {(["body", "headers", "tests", "console"] as ResponseTab[]).map((t) => (
            <button key={t} className={`tab ${view === t ? "tab-active" : ""}`} onClick={() => setView(t)}>
              {t}
              {t === "tests" && tab.tests?.length ? <span className="ml-1 text-[10px] text-signal-muted">({tab.tests.length})</span> : null}
              {t === "headers" && Object.keys(resp.headers).length ? <span className="ml-1 text-[10px] text-signal-muted">({Object.keys(resp.headers).length})</span> : null}
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
              {resp.bodyIsBase64 && (
                <>
                  <label className="flex items-center gap-1 text-signal-muted">
                    <input type="checkbox" checked={showBinaryAsText} onChange={(e) => setShowBinaryAsText(e.target.checked)} /> show as text
                  </label>
                  <button className="btn" onClick={downloadBinary}>Download</button>
                </>
              )}
              <button
                className="text-signal-muted hover:text-white ml-auto"
                onClick={() => navigator.clipboard.writeText(resp.body)}
              >Copy raw</button>
            </div>
            {resp.bodyIsBase64 && !showBinaryAsText ? (
              <div className="p-4 text-xs text-signal-muted">
                Binary response ({formatBytes(resp.sizeBytes)}, content-type: <code>{resp.contentType || "?"}</code>).
                Use <strong>Download</strong> to save, or toggle <em>show as text</em> to preview.
              </div>
            ) : (
              <pre className="font-mono text-xs p-3 whitespace-pre-wrap break-words">{formatted}</pre>
            )}
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
function decodeBase64ToText(s: string): string {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return s; }
}
function inferFilename(resp: { contentType?: string }): string {
  const ct = (resp.contentType || "").split(";")[0].trim();
  const ext = ({
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "application/pdf": "pdf", "application/zip": "zip",
    "application/octet-stream": "bin",
  } as Record<string, string>)[ct] ?? "bin";
  return `signal-response.${ext}`;
}

function prettyXml(xml: string): string {
  const tab = "  ";
  let formatted = "";
  let pad = 0;
  xml = xml.replace(/>\s*</g, ">\n<");
  for (const line of xml.split("\n")) {
    if (/^<\/\w/.test(line)) pad = Math.max(0, pad - 1);
    formatted += tab.repeat(pad) + line + "\n";
    if (/^<\w[^>]*[^\/]>.*$/.test(line) && !/^<\w[^>]*\/>$/.test(line) && !line.includes("</")) pad++;
  }
  return formatted.trim();
}
