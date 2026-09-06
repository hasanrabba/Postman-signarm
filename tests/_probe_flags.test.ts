/**
 * LENS: cURL FLAG COVERAGE.
 *
 * Differential harness: for each cURL command, compare what REAL curl sends
 * against what Signal sends after parseCurl -> executeRequest. Both hit the
 * same local echo server, which records the wire-level request.
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const OUT = process.env.ECHO_OUT!;
const BASE = process.env.ECHO_BASE || "http://127.0.0.1:8901";
const FX = "/tmp/claude-0/-home-user-Postman-signarm/41ef053a-65df-5ab7-9885-a7167f0623c8/scratchpad/curlqa/fx";

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
function records(): Rec[] {
  const lines = fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}
function last(): Rec | null {
  const r = records();
  return r.length ? r[r.length - 1] : null;
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
function viaCurlAll(cmd: string) {
  clear();
  execFileSync("sh", ["-c", cmd], { stdio: "pipe" });
  return records().map((r) => normalize(r)!);
}

async function viaSignal(cmd: string) {
  clear();
  const req = parseCurl(cmd);
  if (!req) return { PARSE_FAILED: true } as unknown as ReturnType<typeof normalize>;
  await executeRequest(req, { scope: {} });
  return normalize(last());
}
async function viaSignalAll(cmd: string) {
  clear();
  const req = parseCurl(cmd);
  if (!req) return [];
  await executeRequest(req, { scope: {} });
  return records().map((r) => normalize(r)!);
}

async function compare(cmd: string) {
  return { curl: viaCurl(cmd), signal: await viaSignal(cmd) };
}

beforeAll(() => {
  expect(OUT, "set ECHO_OUT to the echo server's jsonl path").toBeTruthy();
});

/* ------------------------------------------------------------------ *
 * Wire-level differential cases
 * ------------------------------------------------------------------ */
const CASES: [string, string][] = [
  // --- controls that should already agree ---
  ["control: combined -sLX POST", `curl -sLX POST ${BASE}/c1 -d 'a=1' -H 'Content-Type: application/json'`],
  ["control: combined -ksS", `curl -ksS ${BASE}/c2`],
  ["control: -o with a URL", `curl -s -o /dev/null ${BASE}/c3`],
  ["control: -X with a lowercase known method", `curl -s -X PUT ${BASE}/c4`],

  // --- candidates ---
  ["-T uploads as PUT", `curl -s -T ${FX}/upload.txt ${BASE}/up`],
  ["--upload-file uploads as PUT", `curl -s --upload-file ${FX}/upload.txt ${BASE}/up2`],
  ["--json sets body + content-type", `curl -s --json '{"a":1}' ${BASE}/j`],
  ["-X PURGE", `curl -s -X PURGE ${BASE}/purge`],
  ["-X LOCK with a body", `curl -s -X LOCK -d 'x=1' ${BASE}/lock`],
  ["-XPOST attached value", `curl -s -XPOST ${BASE}/xp`],
  ["-d @file reads the file", `curl -s -d @${FX}/payload.json ${BASE}/df`],
  ["--data-raw does not treat @ specially", `curl -s --data-raw '@notafile' ${BASE}/dr`],
  ["-d with an attached value", `curl -s -d'{"a":1}' -H 'Content-Type: application/json' ${BASE}/att`],
  ["--url alongside a positional URL", `curl -s --url ${BASE}/viaflag`],
  ["-H with no colon is ignored", `curl -s -H 'X-Bad' ${BASE}/h1`],
  ["-H 'X-Empty:' removes the header", `curl -s -H 'X-Empty:' ${BASE}/h2`],
  ["-H 'X-Kill;' sends an empty header", `curl -s -H 'X-Kill;' ${BASE}/h3`],
  ["--oauth2-bearer", `curl -s --oauth2-bearer TOK123 ${BASE}/oauth`],
  ["-F with ;type=image/png", `curl -s -F 'f=@${FX}/x.png;type=image/png' ${BASE}/f1`],
  ["-F with <file is a plain field", `curl -s -F 'f=<${FX}/msg.txt' ${BASE}/f2`],
  ["-b pointing at a cookie file", `curl -s -b ${FX}/cookies.txt ${BASE}/ck`],
];

describe("real curl vs Signal, on the wire (flags lens)", () => {
  for (const [name, cmd] of CASES) {
    test(name, async () => {
      const { curl, signal } = await compare(cmd);
      expect({ name, ...signal }).toEqual({ name, ...curl });
    }, 20_000);
  }
});

/* ------------------------------------------------------------------ *
 * Cases the table cannot express
 * ------------------------------------------------------------------ */
describe("multi-request and no-request commands (flags lens)", () => {
  test("--next: the second request's method and body must not land on the first URL", async () => {
    const cmd = `curl -s ${BASE}/first --next -X POST -d 'danger=1' ${BASE}/second`;
    const curl = viaCurlAll(cmd);
    const signal = await viaSignalAll(cmd);
    // real curl: GET /first (no body), then POST /second
    expect(curl.map((r) => [r.method, r.url, r.body])).toEqual([
      ["GET", "/first", ""],
      ["POST", "/second", "danger=1"],
    ]);
    // Signal must NOT send a POST with a body to /first.
    expect(signal.map((r) => [r.method, r.url, r.body])).not.toContainEqual(["POST", "/first", "danger=1"]);
  }, 20_000);

  test("--next: a DELETE meant for /items/1 must not be aimed at /items", async () => {
    const cmd = `curl -s ${BASE}/items --next -X DELETE ${BASE}/items/1`;
    const curl = viaCurlAll(cmd);
    const signal = await viaSignalAll(cmd);
    expect(curl.map((r) => [r.method, r.url])).toEqual([["GET", "/items"], ["DELETE", "/items/1"]]);
    expect(signal.map((r) => [r.method, r.url])).not.toContainEqual(["DELETE", "/items"]);
  }, 20_000);

  test("--data-binary @- reads stdin, not a literal placeholder", async () => {
    const curlCmd = `printf 'abc=1' | curl -s --data-binary @- ${BASE}/db`;
    const signalCmd = `curl -s --data-binary @- ${BASE}/db`;
    clear();
    execFileSync("sh", ["-c", curlCmd], { stdio: "pipe" });
    const curl = normalize(last())!;
    expect(curl.body).toBe("abc=1");
    const signal = (await viaSignal(signalCmd))!;
    expect(signal.body, "Signal put a placeholder string on the wire").not.toMatch(/^\[file:/);
  }, 20_000);

  test("-O before a scheme-less URL must not eat the URL", async () => {
    const dir = "/tmp/claude-0/-home-user-Postman-signarm/41ef053a-65df-5ab7-9885-a7167f0623c8/scratchpad/curlqa/dl";
    fs.mkdirSync(dir, { recursive: true });
    const signalCmd = `curl -s -O 127.0.0.1:8901/file.zip`;
    clear();
    execFileSync("sh", ["-c", `cd ${dir} && ${signalCmd}`], { stdio: "pipe" });
    expect(records().map((r) => r.url)).toEqual(["/file.zip"]);
    expect(parseCurl(signalCmd)!.url, "-O swallowed the URL").not.toBe("");
  }, 20_000);

  test("other unknown no-arg flags before a scheme-less URL", () => {
    for (const flag of ["-O", "-4", "-6", "--http2", "--path-as-is", "--no-progress-meter"]) {
      expect(parseCurl(`curl ${flag} localhost:3000/api`)!.url, flag).not.toBe("");
    }
  });

  test("two positional URLs: curl issues both requests", async () => {
    const cmd = `curl -s ${BASE}/one ${BASE}/two`;
    const curl = viaCurlAll(cmd);
    const signal = await viaSignalAll(cmd);
    expect(curl.map((r) => r.url)).toEqual(["/one", "/two"]);
    expect(signal.map((r) => r.url)).toEqual(["/one", "/two"]);
  }, 20_000);

  test("an unknown no-arg flag before a scheme-less URL must not eat the URL", async () => {
    const cmd = `curl -s -4 127.0.0.1:8901/four`;
    const curl = viaCurlAll(cmd);
    expect(curl.map((r) => r.url)).toEqual(["/four"]);
    const req = parseCurl(cmd)!;
    expect(req.url, "URL was swallowed by the unknown-flag heuristic").not.toBe("");
  }, 20_000);

  test("-K/--config: the URL from the config file is not lost", async () => {
    const cmd = `curl -s -K ${FX}/conf.txt`;
    const curl = viaCurlAll(cmd);
    expect(curl.map((r) => r.url)).toEqual(["/fromconfig"]);
    const req = parseCurl(cmd)!;
    expect(req.url, "-K swallowed the config path and left no URL").not.toBe("");
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * --aws-sigv4: the signature is deterministic only per-day, so assert on
 * the property that matters instead of on the exact bytes.
 * ------------------------------------------------------------------ */
describe("--aws-sigv4 (flags lens)", () => {
  test("the AWS secret key is never put on the wire", async () => {
    const cmd = `curl -s --aws-sigv4 'aws:amz:us-east-1:s3' -u 'AKIDEXAMPLE:wJalrXUtnFEMI' ${BASE}/aws`;
    const curl = viaCurl(cmd)!;
    const signal = (await viaSignal(cmd))!;
    // real curl: an AWS4-HMAC-SHA256 signature; the secret itself never leaves.
    expect(curl.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    const decodeAuth = (v = "") =>
      v.startsWith("Basic ") ? Buffer.from(v.slice(6), "base64").toString("utf8") : v;
    expect(decodeAuth(curl.headers["authorization"])).not.toContain("wJalrXUtnFEMI");
    expect(
      decodeAuth(signal.headers["authorization"]),
      "Signal sent the AWS secret access key to the server"
    ).not.toContain("wJalrXUtnFEMI");
  }, 20_000);
});
