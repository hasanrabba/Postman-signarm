"use client";

import { useMemo, useState } from "react";
import type { TabState } from "@/lib/store";
import { prettyJson, prettyXml } from "@/lib/pretty";

type ResponseTab = "body" | "headers" | "tests" | "console";

export function ResponseViewer({ tab }: { tab: TabState }) {
  const [view, setView] = useState<ResponseTab>("body");
  const [pretty, setPretty] = useState(true);
  const [showBinaryAsText, setShowBinaryAsText] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const [downloadError, setDownloadError] = useState("");

  const resp = tab.response;

  // Revealing one binary response as text used to arm the toggle for every
  // later response too: a 24MB zip fetched afterwards decoded itself into the
  // DOM with no click, and the checkbox was already ticked so nothing said
  // why. It is an opt-in for the response it was ticked on, and nothing else.
  // (page.tsx keys this component by tab, which handles the across-tabs half.)
  const [seenResponse, setSeenResponse] = useState(resp);
  if (seenResponse !== resp) {
    setSeenResponse(resp);
    setShowBinaryAsText(false);
    // A tab's first response goes to the body. It used to land on whichever
    // pane was last selected anywhere in the app, so a 500's
    // {"error":"database is down"} was replaced by "No tests ran."
    if (!seenResponse) setView("body");
  }

  const decoded = useMemo(() => {
    if (!resp) return "";
    if (!resp.bodyIsBase64) return resp.body;
    return showBinaryAsText ? decodeBase64ToText(resp.body) : "";
  }, [resp, showBinaryAsText]);

  const formatted = useMemo<{ text: string; note?: string }>(() => {
    if (!resp) return { text: "" };
    if (resp.bodyIsBase64 && !showBinaryAsText) return { text: "" };
    if (!pretty) return { text: decoded };
    const ct = (resp.contentType || "").toLowerCase();
    if (ct.includes("json") || looksLikeJson(decoded)) return prettyJson(decoded);
    if (ct.includes("xml") || ct.includes("html")) return prettyXml(decoded);
    return { text: decoded };
  }, [resp, pretty, showBinaryAsText, decoded]);

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

  // One row per header line the server sent. A plain map cannot hold two
  // Set-Cookie headers, and the one it dropped was the session cookie.
  const rows: Array<[string, string]> =
    resp.headerList ?? Object.entries(resp.headers);

  const downloadBinary = () => {
    if (!resp.bodyIsBase64) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(resp.body);
    } catch {
      // atob throws on anything that is not strict base64, and this ran with
      // nothing around it — the click threw out of the handler and the user
      // got no file and no explanation.
      setDownloadError("This response could not be decoded, so there is nothing to save.");
      return;
    }
    setDownloadError("");
    const blob = new Blob([bytes], { type: resp.contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = inferFilename(resp);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  // What is on screen, not what is in the field behind it: on a binary
  // response shown as text, "Copy raw" used to hand over base64.
  const copyText = () =>
    resp.bodyIsBase64 && !showBinaryAsText ? resp.body : (pretty ? formatted.text : decoded);

  const copy = async () => {
    try {
      // Undefined outside a secure context and in several embedded webviews;
      // the promise was neither awaited nor caught, so a failed copy looked
      // exactly like a successful one.
      await navigator.clipboard?.writeText(copyText());
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(""), 2_000);
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
        {/* Clipped to keep the bar on one line, so the full reason has to be
            reachable some other way — hover, and the body pane below. */}
        {resp.error && <span className="text-signal-err truncate max-w-md" title={resp.error}>{resp.error}</span>}
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Response">
          {(["body", "headers", "tests", "console"] as ResponseTab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={view === t}
              className={`tab ${view === t ? "tab-active" : ""}`}
              onClick={() => setView(t)}
            >
              {t}
              {t === "tests" && tab.tests?.length ? <span className="ml-1 text-[10px] text-signal-muted">({tab.tests.length})</span> : null}
              {t === "headers" && rows.length ? <span className="ml-1 text-[10px] text-signal-muted">({rows.length})</span> : null}
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
              <button className="text-signal-muted hover:text-white ml-auto" onClick={copy}>
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy raw"}
              </button>
            </div>
            {/* A request that never reached a server has no body to show, and
                the reason was only in a clipped span in the bar above. */}
            {resp.error && !resp.body && (
              <div className="px-3 py-3 text-xs text-signal-err whitespace-pre-wrap break-words">{resp.error}</div>
            )}
            {resp.bodyTruncated !== undefined && (
              <div className="px-3 py-1 text-xs text-signal-warn border-b border-signal-border">
                Reopened from history: only the first {formatBytes(resp.body.length)} of{" "}
                {formatBytes(resp.bodyTruncated)} was kept. Send again for the whole body.
              </div>
            )}
            {downloadError && (
              <div className="px-3 py-1 text-xs text-signal-err border-b border-signal-border">{downloadError}</div>
            )}
            {formatted.note && (
              <div className="px-3 py-1 text-xs text-signal-warn border-b border-signal-border">{formatted.note}</div>
            )}
            {resp.bodyIsBase64 && !showBinaryAsText ? (
              <div className="p-4 text-xs text-signal-muted">
                Binary response ({formatBytes(resp.sizeBytes)}, content-type: <code>{resp.contentType || "?"}</code>).
                Use <strong>Download</strong> to save, or toggle <em>show as text</em> to preview.
              </div>
            ) : (
              <pre className="font-mono text-xs p-3 whitespace-pre-wrap break-words">{formatted.text}</pre>
            )}
          </div>
        )}
        {view === "headers" && (
          <table className="w-full text-xs font-mono">
            <tbody>
              {rows.map(([k, v], i) => (
                <tr key={`${k}-${i}`} className="border-b border-signal-border">
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
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  // Rounded before the unit is chosen: 1048575 divided by 1024 is 1023.999,
  // which printed as "1024.0 KB" — a size that should have read 1.00 MB.
  const kb = n / 1024;
  if (kb < 1023.95) return `${kb.toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function decodeBase64ToText(s: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(s));
  } catch { return s; }
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
  "image/x-icon": "ico", "image/tiff": "tif", "image/avif": "avif",
  "application/pdf": "pdf", "application/zip": "zip", "application/gzip": "gz",
  "application/x-tar": "tar", "application/x-7z-compressed": "7z",
  "application/octet-stream": "bin", "application/wasm": "wasm",
  "application/xml": "xml", "text/xml": "xml", "text/csv": "csv",
  "text/plain": "txt", "text/html": "html", "application/json": "json",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
  "video/mp4": "mp4", "video/webm": "webm",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/**
 * The name to save a download under.
 *
 * The server usually says, in Content-Disposition, and that header is sitting
 * in the viewer's own Headers pane — so the user could read "Q3-revenue.xlsx"
 * on screen while the file saved as "signal-response.bin". Worse, the constant
 * name meant three different downloads in one session all collided.
 */
export function inferFilename(resp: { contentType?: string; headers?: Record<string, string>; headerList?: Array<[string, string]> }): string {
  const fromServer = dispositionFilename(resp);
  if (fromServer) return fromServer;
  const ct = (resp.contentType || "").split(";")[0].trim().toLowerCase();
  const suffix = ct.slice(ct.lastIndexOf("+") + 1);
  const ext = EXT_BY_TYPE[ct]
    ?? (ct.endsWith("+xml") || suffix === "xml" ? "xml" : undefined)
    ?? (ct.endsWith("+json") || suffix === "json" ? "json" : undefined)
    ?? "bin";
  return `signal-response.${ext}`;
}

function dispositionFilename(resp: { headers?: Record<string, string>; headerList?: Array<[string, string]> }): string {
  const pairs = resp.headerList ?? Object.entries(resp.headers ?? {});
  const hit = pairs.find(([k]) => k.toLowerCase() === "content-disposition");
  if (!hit) return "";
  const value = hit[1];
  // filename* (RFC 5987) wins: it is the one that can carry non-ASCII.
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  let raw = "";
  if (star) {
    try { raw = decodeURIComponent(star[2]); } catch { raw = star[2]; }
  } else {
    const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(value);
    raw = (plain?.[2] ?? plain?.[3] ?? "").trim();
  }
  return sanitizeFilename(raw);
}

/**
 * A server picks this string, and it reaches `a.download`. Path separators and
 * leading dots are the parts that would let it name something other than a
 * plain file in the downloads folder.
 */
function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return base.slice(0, 200);
}
