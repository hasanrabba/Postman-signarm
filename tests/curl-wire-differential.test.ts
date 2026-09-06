/**
 * Differential harness: for each cURL command, compare what REAL curl sends
 * against what Signal sends after parseCurl -> executeRequest. Both hit the
 * same local echo server, which records the wire-level request, so a failure
 * here is a genuine difference in the bytes a user's server would receive.
 *
 * Skipped unless ECHO_OUT is set, because it needs a real curl binary and a
 * live echo server. To run it:
 *
 *   node tests/support/echo-server.cjs &          # ECHO_PORT/ECHO_OUT to taste
 *   ECHO_OUT=/tmp/echo.jsonl npx vitest run tests/curl-wire-differential.test.ts
 *
 * Every case here should match exactly. The one known divergence from curl is
 * kept in its own block at the bottom, asserted rather than ignored, so that a
 * NEW difference is always a real signal.
 */
import { describe, test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const OUT = process.env.ECHO_OUT || "";
const BASE = process.env.ECHO_BASE || "http://127.0.0.1:8899";

vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn((payload: { method: string; url: string; headers: Record<string, string>; body?: string }) =>
    new Promise((resolve, reject) => {
      const u = new URL(payload.url);
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: payload.method, headers: payload.headers },
        (res) => {
          const c: Buffer[] = [];
          res.on("data", (d) => c.push(d));
          res.on("end", () => resolve({
            status: res.statusCode, statusText: "OK", headers: {},
            body: Buffer.concat(c).toString(), elapsedMs: 1, sizeBytes: 2,
          }));
        }
      );
      req.on("error", reject);
      if (payload.body !== undefined) req.write(payload.body);
      req.end();
    })
  ),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

import { parseCurl } from "@/lib/curl";
import { executeRequest } from "@/lib/executor";

const IGNORE = new Set([
  "host", "user-agent", "accept", "accept-encoding", "connection",
  "content-length", "x-qa-tag", "expect", "transfer-encoding",
]);

type Rec = { method: string; url: string; headers: Record<string, string>; body: string };

function clear() { fs.writeFileSync(OUT, ""); }
function last(): Rec | null {
  const lines = fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

function normalize(r: Rec | null) {
  if (!r) return null;
  const headers: Record<string, string> = {};
  let boundary = "";
  for (const [k, v] of Object.entries(r.headers)) {
    if (IGNORE.has(k.toLowerCase())) continue;
    let val = String(v);
    const m = /boundary=(.+)$/.exec(val);
    if (m) { boundary = m[1]; val = val.replace(m[1], "<B>"); }
    headers[k.toLowerCase()] = val;
  }
  let body = r.body;
  if (boundary) body = body.split(boundary).join("<B>");
  return { method: r.method, url: r.url, headers, body };
}

function viaCurl(cmd: string) {
  clear();
  execFileSync("sh", ["-c", cmd], { stdio: "pipe" });
  return normalize(last());
}

async function viaSignal(cmd: string) {
  clear();
  const req = parseCurl(cmd);
  if (!req) return { PARSE_FAILED: true } as unknown as ReturnType<typeof normalize>;
  await executeRequest(req, { scope: {} });
  return normalize(last());
}

export async function compare(cmd: string) {
  return { curl: viaCurl(cmd), signal: await viaSignal(cmd) };
}



const CASES: [string, string][] = [
  ["plain GET", `curl ${BASE}/a`],
  ["explicit method", `curl -X DELETE ${BASE}/a`],
  ["json body", `curl ${BASE}/a -H 'Content-Type: application/json' -d '{"a":1}'`],
  ["repeated -d", `curl ${BASE}/a -d 'a=1' -d 'b=2'`],
  ["-G with data", `curl -G ${BASE}/a -d 'q=hello'`],
  ["form fields", `curl ${BASE}/a -F 'x=1' -F 'y=2'`],
  ["basic auth", `curl -u 'alice:s3cr3t' ${BASE}/a`],
  ["query in url", `curl '${BASE}/a?x=1&y=2'`],
  ["encoded query", `curl '${BASE}/a?q=a%20b&r=c%2Bd'`],
  ["plus in query", `curl '${BASE}/a?q=a+b'`],
  ["duplicate header", `curl ${BASE}/a -H 'X-A: 1' -H 'X-A: 2'`],
  ["cookie flag", `curl ${BASE}/a -b 'a=1; b=2'`],
  ["HEAD via -I", `curl -I ${BASE}/a`],
  ["empty value param", `curl '${BASE}/a?x=&y=2'`],
  ["bare param no equals", `curl '${BASE}/a?flag&y=2'`],
  ["semicolon in query", `curl '${BASE}/a?x=1;y=2'`],
  ["urlencoded content-type", `curl ${BASE}/a -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1&b=2'`],
  ["xml body", `curl ${BASE}/a -H 'Content-Type: application/xml' -d '<a>1</a>'`],
];

describe.skipIf(!OUT)("real curl vs Signal, on the wire", () => {
  for (const [name, cmd] of CASES) {
    test(name, async () => {
      const { curl, signal } = await compare(cmd);
      expect({ name, ...signal }).toEqual({ name, ...curl });
    }, 20_000);
  }
});

/*
 * Accepted divergence, asserted so it cannot drift unnoticed: in an
 * x-www-form-urlencoded body curl writes a space as `+` and Signal writes it
 * as `%20`. Both decode to a space in every form parser — the WHATWG decoder
 * maps `+` to a space and percent-decodes `%20` — so no server sees a
 * different value. Left alone because changing it would alter the bytes of
 * every hand-built form request to fix nothing a user can observe.
 */
describe.skipIf(!OUT)("known divergences", () => {
  test("a space in a --data-urlencode body", async () => {
    const cmd = `curl ${BASE}/a --data-urlencode 'q=a b&c'`;
    const { curl, signal } = await compare(cmd);
    expect(curl!.body).toBe("q=a+b%26c");
    expect(signal!.body).toBe("q=a%20b%26c");
    // Everything else about the request is identical.
    expect({ ...signal, body: "" }).toEqual({ ...curl, body: "" });
  }, 20_000);
});
