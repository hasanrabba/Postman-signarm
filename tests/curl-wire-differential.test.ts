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
const PORT = new URL(BASE).port;

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

import { parseCurl, toCurl } from "@/lib/curl";
import { emptyAuth } from "@/lib/auth";
import type { SignalRequest } from "@/lib/types";
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
  execFileSync("bash", ["-c", cmd], { stdio: "pipe" });
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
  // flag and tokenizer fidelity
  ["attached -X value", `curl -XPOST ${BASE}/a`],
  ["attached -H value", `curl -H'X-A: 1' ${BASE}/a`],
  ["a windows path in double quotes", `curl ${BASE}/a -d "C:\\temp\\news"`],
  ["ansi-c body", `curl ${BASE}/a --data-raw $'line1\\nline2'`],
  ["ansi-c header", `curl ${BASE}/a -H $'X-Trace: 1'`],
  ["ansi-c url", `curl $'${BASE}/a'`],
  ["--json", `curl --json '{"a":1}' ${BASE}/a`],
  ["--oauth2-bearer", `curl --oauth2-bearer TOK123 ${BASE}/a`],
  ["credentials in the url", `curl http://user:pass@127.0.0.1:${PORT}/a`],
  ["a scheme-less host", `curl 127.0.0.1:${PORT}/a`],
  ["an unknown no-arg flag before a scheme-less host", `curl -4 127.0.0.1:${PORT}/a`],
  ["--data-raw keeps a leading @", `curl ${BASE}/a --data-raw '@channel deploy'`],
  ["--form-string keeps a leading @", `curl ${BASE}/a --form-string 'x=@data.json'`],
  // form / -G round-trip fidelity
  ["-G with a valueless field", `curl -G ${BASE}/a -d 'flag' -d 'y=2'`],
  ["-G with a plus in a value", `curl -G ${BASE}/a -d 'q=a+b'`],
  ["a plus in a form body value", `curl ${BASE}/a -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1+2'`],
  ["a semicolon in a form body value", `curl ${BASE}/a -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1;b=2'`],
  ["an equals in a form body value", `curl ${BASE}/a -H 'Content-Type: application/x-www-form-urlencoded' -d 'jwt=a.b=c'`],
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
  /*
   * A JSON-looking -d body with no Content-Type header: curl labels it
   * application/x-www-form-urlencoded like every other -d body, Signal treats
   * it as JSON. Deliberate — a real command that meant a form would not be
   * carrying JSON — and pinned in tests/curl-import-fidelity.test.ts. The
   * bytes of the body itself are identical.
   */
  for (const [name, cmd] of [
    ["an attached -d JSON value", `curl -d'{"a":1}' ${BASE}/a`],
    ["a JSON body quoted for the shell", `curl ${BASE}/a -d "{\\"text\\":\\"a\\nb\\"}"`],
  ] as [string, string][]) {
    test(name, async () => {
      const { curl, signal } = await compare(cmd);
      expect(curl!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(signal!.headers["content-type"]).toBe("application/json");
      expect(signal!.body).toBe(curl!.body);
      expect({ ...signal, headers: {} }).toEqual({ ...curl, headers: {} });
    }, 20_000);
  }

  /*
   * A non-ASCII header value cannot be compared here. curl puts the shell's
   * UTF-8 bytes on the wire; this harness sends through node:http, which
   * encodes header values as latin-1, so the difference measured would be the
   * harness's, not Signal's. That $'X-Name: Caf\xc3\xa9' decodes to the
   * characters "Café" is asserted in tests/curl-import-flags.test.ts instead.
   */

  test("a space in a --data-urlencode body", async () => {
    const cmd = `curl ${BASE}/a --data-urlencode 'q=a b&c'`;
    const { curl, signal } = await compare(cmd);
    expect(curl!.body).toBe("q=a+b%26c");
    expect(signal!.body).toBe("q=a%20b%26c");
    // Everything else about the request is identical.
    expect({ ...signal, body: "" }).toEqual({ ...curl, body: "" });
  }, 20_000);
});

/*
 * The other direction: what the app sends, against what the command shown in
 * the cURL tab sends when a person pastes it into their terminal. A request
 * that worked in Signal came back 415 from the same API, because the exported
 * command carried no Content-Type and curl labelled the body as form data.
 */
function request(over: Partial<SignalRequest>): SignalRequest {
  return {
    id: "r", name: "n", method: "GET", url: `${BASE}/a`, headers: [], params: [],
    auth: emptyAuth(),
    body: { mode: "none", raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    preRequestScript: "", testScript: "",
    ...over,
  } as SignalRequest;
}
const hdr = (key: string, value: string) => ({ id: key, key, value, enabled: true });

describe.skipIf(!OUT)("the app and its exported command send the same thing", () => {
  const cases: [string, SignalRequest][] = [
    ["a JSON body with no explicit Content-Type", request({
      method: "POST", body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    })],
    ["an XML body", request({
      method: "POST", body: { mode: "xml", raw: "<a>1</a>", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    })],
    ["a GraphQL body", request({
      method: "POST", body: { mode: "graphql", raw: "", urlencoded: [], formdata: [], graphql: { query: "{ me { id } }", variables: '{"x":1}' } },
    })],
    ["a form-urlencoded body", request({
      method: "POST",
      body: { mode: "form-urlencoded", raw: "", urlencoded: [hdr("a", "1"), hdr("b", "2")], formdata: [], graphql: { query: "", variables: "" } },
    })],
    ["a HEAD request", request({ method: "HEAD" })],
    ["a header sent deliberately empty", request({ headers: [hdr("X-Trace", "")] })],
    ["an explicit Content-Type is not doubled", request({
      method: "POST", headers: [hdr("Content-Type", "application/vnd.api+json")],
      body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    })],
    ["params and a fragment", request({ url: `${BASE}/a#frag`, params: [hdr("x", "1"), hdr("y", "a b")] })],
  ];

  for (const [name, req] of cases) {
    test(name, async () => {
      clear();
      await executeRequest(req, { scope: {} });
      const app = normalize(last());
      const exported = viaCurl(toCurl(req));
      expect({ name, ...app }).toEqual({ name, ...exported });
    }, 20_000);
  }
});
