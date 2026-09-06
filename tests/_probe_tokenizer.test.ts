/**
 * Lens: tokenize() in src/lib/curl.ts.
 *
 * Differential half is the shared harness, with ONE change: the oracle shell
 * is `bash`, not `sh`. /bin/sh here is dash, which has no ANSI-C quoting
 * ($'...'), and the commands under test are exactly what Chrome's
 * "Copy as cURL (bash)" and a bash/zsh terminal produce. For every case that
 * does not involve $'...' dash and bash agree byte for byte.
 *
 * Unit half covers pastes that a POSIX shell cannot run at all (a shell
 * prompt, a cmd.exe caret, a truncated flag) — there the oracle is the
 * documented behaviour of the shell the user copied from.
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const OUT = process.env.ECHO_OUT!;
const BASE = process.env.ECHO_BASE || "http://127.0.0.1:8902";

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

async function compare(cmd: string) {
  return { curl: viaCurl(cmd), signal: await viaSignal(cmd) };
}

beforeAll(() => {
  expect(OUT, "set ECHO_OUT to the echo server's jsonl path").toBeTruthy();
});

// ---------------------------------------------------------------------------
// Differential cases: what bash+curl actually put on the wire vs what Signal
// puts on the wire after importing the same pasted text.
// ---------------------------------------------------------------------------
const CASES: [string, string][] = [
  // Chrome DevTools "Copy as cURL (bash)" emits $'...' whenever a value has a
  // newline, a CR or a non-ASCII byte.
  ["chrome ansi-c body", String.raw`curl ${BASE}/a --data-raw $'line1\nline2'`],
  ["chrome ansi-c header", String.raw`curl ${BASE}/a -H $'X-Trace: 1'`],
  ["chrome ansi-c non-ascii", String.raw`curl ${BASE}/a -H $'X-Name: Caf\xc3\xa9'`],
  // A double-quoted argument: the shell keeps a backslash that is not before
  // $ ` " \ or newline. JSON escapes and Windows paths live here.
  ["json escape in double quotes", String.raw`curl ${BASE}/a -H 'Content-Type: application/json' -d "{\"text\":\"a\nb\"}"`],
  ["backslash-t in double quotes", String.raw`curl ${BASE}/a -H 'Content-Type: application/json' -d "{\"t\":\"a\tb\"}"`],
  ["windows path in double quotes", String.raw`curl ${BASE}/a -d "C:\temp\news"`],
  // Trailing shell comment.
  ["trailing # comment", `curl ${BASE}/a # -H 'X-Debug: 1'`],
  // --- controls: these should already agree, and do ---
  ["ctl escaped apostrophe idiom", String.raw`curl ${BASE}/a -d 'it'\''s'`],
  ["ctl multiline quoted body", `curl ${BASE}/a -H 'Content-Type: application/json' -d '{\n  "a": 1\n}'`],
  ["ctl tabs as separators", `curl\t${BASE}/a\t-H\t'X-A: 1'`],
  ["ctl crlf continuation", `curl ${BASE}/a \\\r\n  -H 'X-A: 1'`],
  ["ctl escaped quotes in double quotes", String.raw`curl ${BASE}/a -H 'Content-Type: application/json' -d "{\"a\":\"b\"}"`],
  ["ctl backslash-escaped space", String.raw`curl ${BASE}/a -H X-A:\ 1`],
  ["ctl adjacent quoting", `curl ${BASE}/a -H 'X-A: '"1"''`],
];

describe("tokenizer: real curl (bash) vs Signal, on the wire", () => {
  for (const [name, cmd] of CASES) {
    test(name, async () => {
      const { curl, signal } = await compare(cmd);
      expect({ name, ...signal }).toEqual({ name, ...curl });
    }, 20_000);
  }
});

// ---------------------------------------------------------------------------
// Unit cases: pastes a POSIX shell cannot run, so the oracle is the shell the
// text was copied from (cmd.exe, PowerShell) or the importer's own contract.
// ---------------------------------------------------------------------------
describe("tokenizer: pastes that never reach a shell", () => {
  test("a copied shell prompt still imports", () => {
    // Every docs site prints the prompt; users select the whole line.
    expect(parseCurl(`$ curl ${BASE}/a`), "$ prompt").not.toBeNull();
    expect(parseCurl(`# curl ${BASE}/a`), "# root prompt").not.toBeNull();
    expect(parseCurl(`> curl ${BASE}/a`), "> continuation prompt").not.toBeNull();
  });

  test("a leading comment line still imports", () => {
    expect(parseCurl(`# Fetch the current user\ncurl ${BASE}/a`)).not.toBeNull();
  });

  test("curl.exe imports (PowerShell / Windows docs)", () => {
    expect(parseCurl(`curl.exe ${BASE}/a`)).not.toBeNull();
  });

  test("cmd.exe caret continuation keeps the real URL", () => {
    const r = parseCurl(`curl -X POST ^\n  -H "X-A: 1" ^\n  "${BASE}/a"`)!;
    expect(r).not.toBeNull();
    expect(r.url).toBe(`${BASE}/a`);
  });

  test("PowerShell backtick continuation keeps the real URL", () => {
    const r = parseCurl("curl `\n  -X POST `\n  \"" + BASE + "/a\"")!;
    expect(r.url).toBe(`${BASE}/a`);
  });

  test("a stray escaped space does not become the URL", () => {
    // A line-continuation backslash followed by a space — very common when a
    // command is copied out of a chat window.
    const r = parseCurl(`curl \\ \n  ${BASE}/a`)!;
    expect(r.url).toBe(`${BASE}/a`);
  });

  test("an unterminated quote does not invent a URL", () => {
    // bash refuses to run this (unexpected EOF). Signal must not silently
    // send it somewhere else.
    const r = parseCurl(`curl -X POST -d '{"name":"O'Brien"}' ${BASE}/a`);
    if (r) expect(r.url).toBe(`${BASE}/a`);
  });

  test("a truncated command returns null instead of throwing", () => {
    // Both call sites (RequestBuilder.tsx:276, CommandPalette.tsx:47) call
    // parseCurl bare and only handle a null return.
    expect(() => parseCurl(`curl ${BASE}/a -H`)).not.toThrow();
    expect(() => parseCurl(`curl ${BASE}/a -F`)).not.toThrow();
    expect(() => parseCurl(`curl ${BASE}/a --data-urlencode`)).not.toThrow();
  });

  test("a truncated -d does not send the string 'undefined'", () => {
    const r = parseCurl(`curl ${BASE}/a -d`)!;
    expect(r.body.raw).not.toBe("undefined");
  });
});

describe("tokenizer: resource limits", () => {
  test("a 200KB command parses in reasonable time", () => {
    const body = "x".repeat(200_000);
    const t0 = performance.now();
    parseCurl(`curl ${BASE}/a -d '${body}'`);
    const oneBig = performance.now() - t0;

    const many = Array.from({ length: 4000 }, (_, i) => `-H 'X-${i}: ${"v".repeat(40)}'`).join(" ");
    const t1 = performance.now();
    parseCurl(`curl ${BASE}/a ${many}`);
    const manyFlags = performance.now() - t1;

    const quotes = "'".repeat(200_000);
    const t2 = performance.now();
    parseCurl(`curl ${BASE}/a -d ${quotes}`);
    const altQuotes = performance.now() - t2;

    const escapes = "\\a".repeat(100_000);
    const t3 = performance.now();
    parseCurl(`curl ${BASE}/a -d "${escapes}"`);
    const manyEscapes = performance.now() - t3;

    console.log(`[perf] oneBig=${oneBig.toFixed(0)}ms manyFlags=${manyFlags.toFixed(0)}ms altQuotes=${altQuotes.toFixed(0)}ms manyEscapes=${manyEscapes.toFixed(0)}ms`);
    expect(Math.max(oneBig, manyFlags, altQuotes, manyEscapes)).toBeLessThan(2000);
  }, 30_000);
});
