import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isBlockedHostname, isBlockedIp, normalizeHostname } from "@/lib/ssrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProxyPayload {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const MAX_REDIRECTS = 10;
/** Largest response we will buffer. The whole body is read into memory to
 *  base64/decode it, so without a ceiling one huge download exhausts the
 *  server's heap. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB

/** Set SIGNAL_PROXY_ALLOW_LOCAL=1 to reach localhost/private ranges. */
function allowLocal(): boolean {
  return process.env.SIGNAL_PROXY_ALLOW_LOCAL === "1";
}

/**
 * Decide whether `target` is safe to connect to.
 *
 * A hostname is not evidence of where a request lands, so anything that
 * isn't already a blocked literal gets resolved and every returned address
 * is checked. A name that resolves to loopback or RFC1918 space is refused
 * exactly like the literal address would be.
 *
 * Residual risk: between this lookup and the one the HTTP stack performs
 * there is a small DNS-rebinding window. Closing it entirely means pinning
 * the connection to the address validated here, which needs a custom
 * dispatcher; the check below stops every non-adversarial case and all
 * static bypasses (encoded literals, redirects, names pointing inward).
 */
async function checkTarget(target: URL): Promise<string | null> {
  if (allowLocal()) return null;
  if (!/^https?:$/.test(target.protocol)) {
    return `Only http/https are allowed (got ${target.protocol}).`;
  }
  const host = normalizeHostname(target.hostname);
  if (isBlockedHostname(host)) {
    return `Host ${target.hostname} is blocked by the proxy.`;
  }
  // Already a public IP literal — nothing to resolve.
  if (isBlockedIp(host) === false && /^[0-9a-f:.]+$/.test(host) && (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host))) {
    return null;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return `Could not resolve host ${target.hostname}.`;
  }
  if (addrs.length === 0) return `Could not resolve host ${target.hostname}.`;
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return `Host ${target.hostname} resolves to a blocked address (${a.address}).`;
    }
  }
  return null;
}

// Headers the client must not set on the outgoing request. `fetch` forbids most
// of these and throws; we strip them silently so a leftover header from a
// previous edit doesn't break the send.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers",
  "access-control-request-method", "connection", "content-length", "cookie",
  "date", "dnt", "expect", "host", "keep-alive", "origin", "permissions-policy",
  "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
]);

// Hop-by-hop headers and framing headers we must not forward back to the
// browser verbatim. `fetch`/undici already decompressed the body, so
// `content-encoding` and `content-length` would confuse the caller.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "upgrade",
]);

function filterRequestHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || v === undefined || v === null) continue;
    const lk = k.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lk)) continue;
    if (lk.startsWith("proxy-")) continue;
    if (lk.startsWith("sec-")) continue;
    out[k] = String(v);
  }
  return out;
}

function dropAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "cookie") continue;
    out[k] = v;
  }
  return out;
}

function blocked(error: string, elapsedMs = 0, statusText = "Blocked") {
  return NextResponse.json({
    status: 0, statusText, headers: {}, body: "", sizeBytes: 0, elapsedMs, error,
  });
}

/**
 * Read a response body, giving up once it passes `limit`. A missing or lying
 * content-length must not be able to push us past the ceiling, so this
 * streams and counts rather than trusting the header.
 */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
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
    return blocked(`Invalid URL: ${payload.url}`, 0, "Invalid URL");
  }

  if (!/^https?:$/.test(target.protocol)) {
    return blocked(`Only http/https are allowed (got ${target.protocol}).`);
  }
  const firstHopError = await checkTarget(target);
  if (firstHopError) return blocked(firstHopError, Date.now() - started);

  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 30_000, 1_000), 120_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let method = (payload.method || "GET").toUpperCase();
    let outHeaders = filterRequestHeaders(payload.headers ?? {});
    let body =
      !["GET", "HEAD"].includes(method) && payload.body !== undefined && payload.body !== ""
        ? payload.body
        : undefined;

    // Follow redirects by hand so the SSRF guard runs on every hop. `fetch`
    // with redirect:"follow" would validate only the first URL and then
    // happily land on 127.0.0.1.
    let current = target;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current.toString(), {
        method,
        headers: outHeaders,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      const isRedirect = res.status >= 300 && res.status < 400 && location;
      if (!isRedirect) break;
      if (hop === MAX_REDIRECTS) {
        return blocked(`Too many redirects (>${MAX_REDIRECTS}).`, Date.now() - started, "Error");
      }
      let next: URL;
      try { next = new URL(location, current); }
      catch { return blocked(`Invalid redirect target: ${location}`, Date.now() - started); }

      const hopError = await checkTarget(next);
      if (hopError) {
        return blocked(`Redirect ${res.status} to ${next.href} refused — ${hopError}`, Date.now() - started);
      }
      // Credentials must not follow a redirect to another origin.
      if (next.origin !== current.origin) outHeaders = dropAuthHeaders(outHeaders);
      // 303, and 301/302 on a non-GET/HEAD, degrade to GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && !["GET", "HEAD"].includes(method))) {
        method = "GET";
        body = undefined;
      }
      current = next;
    }

    if (!res) return blocked("No response from upstream.", Date.now() - started, "Error");

    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      return blocked(
        `Response too large (${declared} bytes > ${MAX_RESPONSE_BYTES} limit).`,
        Date.now() - started,
        "Payload Too Large"
      );
    }
    const buf = await readCapped(res, MAX_RESPONSE_BYTES);
    if (!buf) {
      return blocked(
        `Response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`,
        Date.now() - started,
        "Payload Too Large"
      );
    }
    const ct = res.headers.get("content-type") || "";
    const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|vnd\.api\+json))/i.test(ct) || !ct;
    let respBody = "";
    let bodyIsBase64 = false;
    if (isText) {
      respBody = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } else {
      respBody = Buffer.from(buf).toString("base64");
      bodyIsBase64 = true;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    });
    const finalUrl = current.toString();
    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      headers,
      body: respBody,
      bodyIsBase64,
      elapsedMs: Date.now() - started,
      sizeBytes: buf.byteLength,
      contentType: ct,
      finalUrl: finalUrl !== target.toString() ? finalUrl : undefined,
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
      error: err.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : err.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}
