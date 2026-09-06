/**
 * QA probe — lens: URL and query-param round-tripping.
 * Differential: real curl 8.5.0 vs parseCurl -> executeRequest, both hitting
 * the same local echo server; the recorded wire request is diffed.
 */
import { describe, test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const OUT = process.env.ECHO_OUT || "";
const BASE = process.env.ECHO_BASE || "http://127.0.0.1:8903";

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
  for (const [k, v] of Object.entries(r.headers)) {
    if (IGNORE.has(k.toLowerCase())) continue;
    headers[k.toLowerCase()] = String(v);
  }
  return { method: r.method, url: r.url, headers, body: r.body };
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

async function compare(cmd: string) {
  return { curl: viaCurl(cmd), signal: await viaSignal(cmd) };
}

const CASES: [string, string][] = [
  ["baseline ?x=1&y=2",            `curl '${BASE}/a?x=1&y=2'`],
  ["unicode value, raw",           `curl '${BASE}/a?q=café'`],
  ["unicode key, raw",             `curl '${BASE}/a?ключ=1'`],
  ["unicode value, percent-enc",   `curl '${BASE}/a?q=caf%C3%A9'`],
  ["key with encoded equals",      `curl '${BASE}/a?a%3Db=c'`],
  ["value with unencoded equals",  `curl '${BASE}/a?sig=abc=def'`],
  ["value with encoded ampersand", `curl '${BASE}/a?q=a%26b'`],
  ["malformed escape %zz",         `curl '${BASE}/a?q=%zz'`],
  ["mixed good + malformed",       `curl '${BASE}/a?ok=1&bad=%zz'`],
  ["%2F in path",                  `curl '${BASE}/a%2Fb?x=1'`],
  ["%2F in query value",           `curl '${BASE}/a?p=x%2Fy'`],
  ["literal percent %25",          `curl '${BASE}/a?q=100%25'`],
  ["space as %20",                 `curl '${BASE}/a?q=a%20b'`],
  ["duplicate key",                `curl '${BASE}/a?a=1&a=2'`],
  ["empty query, trailing ?",      `curl '${BASE}/a?'`],
  ["fragment only",                `curl '${BASE}/a#frag'`],
  ["query then fragment",          `curl '${BASE}/a?x=1#frag'`],
  ["userinfo in url",              `curl '${BASE.replace("http://", "http://user:pass@")}/a'`],
  ["userinfo, empty password",     `curl '${BASE.replace("http://", "http://user:@")}/a'`],
  ["encoded CRLF in value",        `curl '${BASE}/a?q=%0D%0AX'`],
  ["plus in key",                  `curl '${BASE}/a?a+b=1'`],
  ["at and colon in value",        `curl '${BASE}/a?e=a@b.com:8080'`],
  ["dot segments in path",         `curl '${BASE}/a/./b?x=1'`],
  ["empty key",                    `curl '${BASE}/a?=v&y=2'`],
  ["trailing ampersand",           `curl '${BASE}/a?x=1&'`],
  ["double ampersand",             `curl '${BASE}/a?x=1&&y=2'`],
  ["square brackets in value",     `curl -g '${BASE}/a?f[0]=1'`],
  ["100 params", `curl '${BASE}/a?${Array.from({length:100},(_,i)=>`k${i}=v${i}`).join("&")}'`],
];

describe.skipIf(!OUT)("query round-trip: real curl vs Signal on the wire", () => {
  for (const [name, cmd] of CASES) {
    test(name, async () => {
      const { curl, signal } = await compare(cmd);
      expect({ name, ...signal }).toEqual({ name, ...curl });
    }, 20_000);
  }
});
