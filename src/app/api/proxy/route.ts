import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProxyPayload {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

// Block SSRF to loopback/private networks at the proxy boundary.
// Set SIGNAL_PROXY_ALLOW_LOCAL=1 to permit localhost/private ranges for
// development or self-hosting against internal services.
function isBlockedHost(hostname: string): boolean {
  if (process.env.SIGNAL_PROXY_ALLOW_LOCAL === "1") return false;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".localhost")) return true;
  // IPv4 private ranges
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 ULA
  if (h.startsWith("fe80")) return true;                     // link-local
  return false;
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  let payload: ProxyPayload;
  try {
    payload = (await req.json()) as ProxyPayload;
  } catch {
    return NextResponse.json(
      { status: 0, statusText: "Bad Request", headers: {}, body: "", sizeBytes: 0, elapsedMs: 0, error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  let target: URL;
  try { target = new URL(payload.url); }
  catch {
    return NextResponse.json({
      status: 0, statusText: "Invalid URL", headers: {}, body: "", sizeBytes: 0, elapsedMs: 0,
      error: `Invalid URL: ${payload.url}`,
    });
  }

  if (!/^https?:$/.test(target.protocol)) {
    return NextResponse.json({
      status: 0, statusText: "Blocked", headers: {}, body: "", sizeBytes: 0, elapsedMs: 0,
      error: `Only http/https are allowed (got ${target.protocol}).`,
    });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({
      status: 0, statusText: "Blocked", headers: {}, body: "", sizeBytes: 0, elapsedMs: 0,
      error: `Host ${target.hostname} is blocked by the proxy.`,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const method = (payload.method || "GET").toUpperCase();
    const hasBody = !["GET", "HEAD"].includes(method) && payload.body !== undefined;
    const res = await fetch(target.toString(), {
      method,
      headers: payload.headers ?? {},
      body: hasBody ? payload.body : undefined,
      redirect: "follow",
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "";
    const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql))/.test(ct) || !ct;
    let body = "";
    let bodyIsBase64 = false;
    if (isText) {
      body = new TextDecoder("utf-8").decode(buf);
    } else {
      body = Buffer.from(buf).toString("base64");
      bodyIsBase64 = true;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bodyIsBase64,
      elapsedMs: Date.now() - started,
      sizeBytes: buf.byteLength,
      contentType: ct,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({
      status: 0,
      statusText: err.name === "AbortError" ? "Timeout" : "Error",
      headers: {},
      body: "",
      sizeBytes: 0,
      elapsedMs: Date.now() - started,
      error: err.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}
