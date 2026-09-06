/**
 * Execution differential for the Snippets tab: generate the snippet, RUN it,
 * and compare what the server received against what the app itself sends.
 *
 * A snippet that merely looks right is worth nothing — the user copies it into
 * a terminal or a file and runs it, so that is what gets tested here.
 *
 * Skipped unless ECHO_OUT is set; it needs curl, python3 + requests, go, node
 * (with node-fetch installed: npm i --no-save node-fetch)
 * and httpie, plus a live echo server:
 *
 *   ECHO_PORT=8899 ECHO_OUT=/tmp/echo.jsonl node tests/support/echo-server.cjs &
 *   ECHO_OUT=/tmp/echo.jsonl npx vitest run tests/snippet-execution.test.ts
 */
import { describe, test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = process.env.ECHO_OUT || "";
const BASE = process.env.ECHO_BASE || "http://127.0.0.1:8899";

vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn((p: { method: string; url: string; headers: Record<string, string>; body?: string }) =>
    new Promise((resolve, reject) => {
      const u = new URL(p.url);
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: p.method, headers: p.headers },
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
      if (p.body !== undefined) req.write(p.body);
      req.end();
    })
  ),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

import { executeRequest } from "@/lib/executor";
import { generateSnippet, type SnippetLang } from "@/lib/snippets";
import { emptyAuth } from "@/lib/auth";
import type { SignalRequest } from "@/lib/types";

type Rec = { method: string; url: string; headers: Record<string, string>; body: string };

const clear = () => fs.writeFileSync(OUT, "");
function last(): Rec | null {
  const lines = fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

/** Headers every client sets for itself; not the app's to match. */
const CLIENT_DEFAULTS = new Set([
  "host", "user-agent", "accept-encoding", "connection", "content-length",
  "transfer-encoding", "accept-language", "sec-fetch-mode", "expect",
]);

function shape(r: Rec | null) {
  if (!r) return null;
  const headers: Record<string, string> = {};
  let boundary = "";
  for (const [k, v] of Object.entries(r.headers)) {
    const key = k.toLowerCase();
    if (CLIENT_DEFAULTS.has(key)) continue;
    let val = String(v);
    const m = /boundary=(.+)$/.exec(val);
    if (m) { boundary = m[1]; val = val.replace(m[1], "<B>"); }
    headers[key] = val;
  }
  let body = r.body;
  if (boundary) {
    body = body.split(boundary).join("<B>");
    // RFC 2046 makes the CRLF after a multipart close-delimiter optional, and
    // node-fetch leaves it out. Not a difference worth failing on.
    body = body.replace(/\r\n$/, "");
  }
  return { method: r.method, url: r.url, headers, body };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "snip-"));
// node resolves imports from the file's own directory upwards, so a snippet
// that imports node-fetch has to sit inside this repo to find node_modules.
const NODE_TMP = fs.mkdtempSync(path.join(process.cwd(), ".snip-"));
function run(lang: SnippetLang, code: string) {
  clear();
  if (lang === "curl" || lang === "httpie") {
    execFileSync("bash", ["-c", code], { stdio: "pipe", timeout: 60_000 });
  } else if (lang === "fetch" || lang === "node-fetch") {
    const f = path.join(NODE_TMP, "s.mjs");
    fs.writeFileSync(f, code);
    execFileSync("node", [f], { stdio: "pipe", cwd: process.cwd(), timeout: 60_000 });
  } else if (lang === "python-requests") {
    const f = path.join(TMP, "s.py");
    fs.writeFileSync(f, code);
    execFileSync("python3", [f], { stdio: "pipe", timeout: 60_000 });
  } else {
    const dir = fs.mkdtempSync(path.join(TMP, "go-"));
    fs.writeFileSync(path.join(dir, "main.go"), code);
    execFileSync("go", ["run", "main.go"], { stdio: "pipe", cwd: dir, timeout: 180_000 });
  }
  return shape(last());
}

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });
const request = (over: Partial<SignalRequest>): SignalRequest => ({
  id: "r", name: "n", method: "GET", url: `${BASE}/a`, headers: [], params: [],
  auth: emptyAuth(),
  body: { mode: "none", raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  preRequestScript: "", testScript: "",
  ...over,
} as SignalRequest);

const body = (mode: string, over: Record<string, unknown> = {}) => ({
  mode, raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" }, ...over,
});

const FIXTURES: [string, SignalRequest][] = [
  ["a plain GET", request({})],
  ["params with a space and an ampersand", request({ params: [kv("q", "a b"), kv("r", "x&y"), kv("s", "1")] })],
  ["a JSON body", request({ method: "POST", body: body("json", { raw: '{"a":1,"b":"x y"}' }) as never })],
  ["a JSON body with an explicit Content-Type", request({
    method: "POST", headers: [kv("Content-Type", "application/vnd.api+json")],
    body: body("json", { raw: '{"a":1}' }) as never,
  })],
  ["an XML body", request({ method: "POST", body: body("xml", { raw: "<a>1</a>" }) as never })],
  ["a form-urlencoded body", request({
    method: "POST", body: body("form-urlencoded", { urlencoded: [kv("a", "1"), kv("b", "x y")] }) as never,
  })],
  ["a GraphQL body", request({
    method: "POST", body: body("graphql", { graphql: { query: "{ me { id } }", variables: '{"x":1}' } }) as never,
  })],
  ["custom headers", request({ headers: [kv("X-A", "1"), kv("X-Spaces", "a b c")] })],
  ["a DELETE", request({ method: "DELETE" })],
  ["a header value with a quote", request({ headers: [kv("X-Q", `he said "hi"`)] })],
  ["a body with quotes and a newline", request({
    method: "POST", body: body("text", { raw: 'say "hi"\nand bye' }) as never,
  })],
  ["basic auth", request({ auth: { type: "basic", basic: { username: "alice", password: "s3cr3t" } } as never })],
  ["bearer auth", request({ auth: { type: "bearer", bearer: { token: "TOK123" } } as never })],
  // A body is data, not code. `echo "..."` in the httpie snippet ran a
  // backtick and expanded $VAR before the request ever left.
  ["a body holding shell metacharacters", request({
    method: "POST", body: body("text", { raw: '{"home":"$HOME","who":"`id -u`","cost":"$5"}' }) as never,
  })],
  ["a body holding a single quote", request({
    method: "POST", body: body("text", { raw: "it's a test" }) as never,
  })],
  // A header value beyond latin-1 cannot go on the wire at all: fetch throws
  // "Cannot convert argument to a ByteString", requests raises
  // UnicodeEncodeError, and the app's own proxy reports the same. Only the
  // BODY is exercised here, where the encoding is UTF-8 and well defined.
  ["a unicode body", request({
    method: "POST", headers: [kv("X-Name", "Cafe")],
    body: body("json", { raw: '{"name":"Café ☕"}' }) as never,
  })],
  ["a multipart body of text fields", request({
    method: "POST",
    body: body("form-data", { formdata: [
      { ...kv("a", "1"), type: "text" as const },
      { ...kv("b", "x y"), type: "text" as const },
    ] }) as never,
  })],
  ["a header value containing a colon", request({ headers: [kv("X-When", "12:30:00")] })],
  ["params with an equals and an ampersand in the value", request({
    params: [kv("sig", "a=b"), kv("q", "x&y")],
  })],
  ["a POST with no body at all", request({ method: "POST" })],
  ["a URL with a fragment", request({ url: `${BASE}/a#frag`, params: [kv("x", "1")] })],
  ["disabled rows are left out", request({
    headers: [kv("X-On", "1"), { id: "off", key: "X-Off", value: "2", enabled: false }],
    params: [kv("p", "1"), { id: "poff", key: "q", value: "2", enabled: false }],
  })],
  ["a PATCH", request({ method: "PATCH", body: body("json", { raw: '{"a":1}' }) as never })],
  ["a header value with padding spaces", request({ headers: [kv("X-Pad", " padded ")] })],
  ["an api key in the query", request({
    auth: { type: "apikey", apikey: { key: "api_key", value: "K123", in: "query" } } as never,
  })],
];

const LANGS: SnippetLang[] = ["curl", "fetch", "node-fetch", "python-requests", "go", "httpie"];

describe.skipIf(!OUT)("a generated snippet sends what the app sends", () => {
  for (const [name, req] of FIXTURES) {
    describe(name, () => {
      for (const lang of LANGS) {
        test(lang, async () => {
          clear();
          await executeRequest(req, { scope: {} });
          const app = shape(last());
          const snippetRan = run(lang, generateSnippet(req, lang));

          expect(snippetRan, "the snippet made no request at all").not.toBeNull();
          expect(snippetRan!.method).toBe(app!.method);
          expect(snippetRan!.url).toBe(app!.url);
          expect(snippetRan!.body).toBe(app!.body);
          // Every header the app sends must arrive; a client's own defaults may
          // be extra.
          for (const [k, v] of Object.entries(app!.headers)) {
            expect(snippetRan!.headers[k], `header ${k}`).toBe(v);
          }
        }, 200_000);
      }
    });
  }
});
