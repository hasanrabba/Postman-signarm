import type { SignalResponse } from "./types";

interface ProxyPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Detect whether we're running inside the Tauri desktop shell. The shell
 * injects `window.__TAURI_INTERNALS__`; the web build never has it.
 */
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** Lazy dynamic import so the web bundle doesn't pull in @tauri-apps/api. */
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

export async function sendProxy(payload: ProxyPayload): Promise<SignalResponse> {
  if (inTauri()) {
    const resp = await tauriInvoke<RustProxyResponse>("proxy_fetch", { payload: toSnake(payload) });
    return fromRust(resp);
  }
  const res = await fetch("/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as SignalResponse;
}

export async function registerMock(mockId: string, routes: unknown[]): Promise<{ ok: boolean; count?: number; error?: string }> {
  if (inTauri()) {
    try {
      const count = await tauriInvoke<number>("mock_register", { mockId, routes });
      return { ok: true, count };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  try {
    const res = await fetch("/api/mock-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mockId, routes }),
    });
    return await res.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

export async function mockBaseUrl(): Promise<string | undefined> {
  if (inTauri()) {
    try { return await tauriInvoke<string>("mock_base_url", {}); }
    catch { return undefined; }
  }
  return typeof window !== "undefined" ? window.location.origin : undefined;
}

// ---- shape translation between JS (camelCase) and Rust (snake_case) ----
interface RustProxyResponse {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body: string;
  body_is_base64?: boolean;
  elapsed_ms: number;
  size_bytes: number;
  error?: string;
  content_type?: string;
  final_url?: string;
}
function fromRust(r: RustProxyResponse): SignalResponse {
  return {
    status: r.status,
    statusText: r.status_text,
    headers: r.headers,
    body: r.body,
    bodyIsBase64: r.body_is_base64,
    elapsedMs: r.elapsed_ms,
    sizeBytes: r.size_bytes,
    error: r.error,
    contentType: r.content_type,
    finalUrl: r.final_url,
  };
}
function toSnake(p: ProxyPayload): Record<string, unknown> {
  return {
    method: p.method,
    url: p.url,
    headers: p.headers,
    body: p.body,
    timeout_ms: p.timeoutMs,
  };
}
