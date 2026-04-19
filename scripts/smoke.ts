// Smoke test the pure-TS modules. Run with:
//   node --experimental-strip-types --experimental-transform-types scripts/smoke.ts
import { resolveVars } from "../src/lib/variables";
import { parseCurl, toCurl } from "../src/lib/curl";
import { generateSnippet } from "../src/lib/snippets";
import { applyAuth } from "../src/lib/auth";
import { runScript } from "../src/lib/scripting";
import { emptyRequest } from "../src/lib/defaults";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ?? "not equal"}: ${ja} !== ${jb}`);
}

console.log("\nvariables");
test("resolves simple vars", () => {
  const out = resolveVars("hello {{name}}", {
    environment: [{ id: "1", key: "name", value: "world", enabled: true }],
  });
  eq(out, "hello world");
});
test("environment overrides collection", () => {
  const out = resolveVars("{{x}}", {
    collection: [{ id: "1", key: "x", value: "col", enabled: true }],
    environment: [{ id: "2", key: "x", value: "env", enabled: true }],
  });
  eq(out, "env");
});
test("leaves unknown vars in place", () => {
  eq(resolveVars("{{nope}}", {}), "{{nope}}");
});
test("built-in timestamp works", () => {
  const out = resolveVars("{{$timestamp}}", {});
  assert(/^\d+$/.test(out), "not a number");
});
test("built-in randomUUID is v4-ish", () => {
  const out = resolveVars("{{$randomUUID}}", {});
  assert(/[0-9a-f-]{36}/i.test(out), "not uuid");
});
test("disabled vars ignored", () => {
  const out = resolveVars("{{x}}", {
    environment: [{ id: "1", key: "x", value: "env", enabled: false }],
  });
  eq(out, "{{x}}");
});

console.log("\ncurl import/export");
test("parses simple GET", () => {
  const r = parseCurl("curl https://api.example.com/v1/users?limit=10");
  assert(r, "no request");
  eq(r!.method, "GET");
  eq(r!.url, "https://api.example.com/v1/users");
  eq(r!.params.length, 1);
  eq(r!.params[0].key, "limit");
  eq(r!.params[0].value, "10");
});
test("parses -X POST with headers and JSON body", () => {
  const r = parseCurl(`curl -X POST https://api.example.com/x \\
    -H 'content-type: application/json' \\
    -H 'authorization: Bearer tok' \\
    --data-raw '{"a":1}'`);
  assert(r, "no request");
  eq(r!.method, "POST");
  eq(r!.headers.length, 2);
  eq(r!.body.mode, "json");
  eq(r!.body.raw, '{"a":1}');
});
test("POST without -X infers method from -d", () => {
  const r = parseCurl("curl https://example.com -d foo=bar");
  eq(r!.method, "POST");
});
test("round-trips via toCurl", () => {
  const r = emptyRequest({
    method: "POST",
    url: "https://api.example.com/x",
    headers: [{ id: "h", key: "X-Test", value: "1", enabled: true }],
    body: { mode: "json", raw: '{"hi":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  });
  const cmd = toCurl(r);
  assert(cmd.includes("-X POST"), "no method");
  assert(cmd.includes("X-Test"), "no header");
  assert(cmd.includes('--data-raw'), "no body flag");
});
test("rejects non-curl strings", () => {
  eq(parseCurl("wget https://example.com"), null);
  eq(parseCurl(""), null);
});

console.log("\nauth");
test("basic auth adds Authorization header", () => {
  const r = applyAuth(emptyRequest({
    auth: { type: "basic", basic: { username: "u", password: "p" } },
  }));
  const auth = r.headers.find((h) => h.key === "Authorization");
  assert(auth, "no auth header");
  eq(auth!.value, "Basic dTpw");
});
test("bearer adds Bearer token", () => {
  const r = applyAuth(emptyRequest({
    auth: { type: "bearer", bearer: { token: "xyz" } },
  }));
  eq(r.headers.find((h) => h.key === "Authorization")?.value, "Bearer xyz");
});
test("apikey in query moves to params", () => {
  const r = applyAuth(emptyRequest({
    auth: { type: "apikey", apikey: { key: "api_key", value: "secret", in: "query" } },
  }));
  eq(r.params.find((p) => p.key === "api_key")?.value, "secret");
});
test("none auth is noop", () => {
  const before = emptyRequest({ headers: [{ id: "x", key: "X", value: "Y", enabled: true }] });
  const after = applyAuth(before);
  eq(after.headers.length, before.headers.length);
});

console.log("\nsnippets");
test("curl snippet contains URL", () => {
  const s = generateSnippet(emptyRequest({ url: "https://x.com/a", method: "GET" }), "curl");
  assert(s.includes("https://x.com/a"), "missing url");
});
test("fetch snippet is valid JS-shape", () => {
  const s = generateSnippet(emptyRequest({ url: "https://x.com", method: "POST", body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } }), "fetch");
  assert(s.includes("await fetch"), "no fetch call");
  assert(s.includes('"method": "POST"'), "no method");
});
test("python snippet imports requests", () => {
  const s = generateSnippet(emptyRequest({ url: "https://x.com" }), "python-requests");
  assert(s.startsWith("import requests"), "missing import");
});
test("go snippet compiles-shape", () => {
  const s = generateSnippet(emptyRequest({ url: "https://x.com" }), "go");
  assert(s.includes("package main"), "no package");
  assert(s.includes("http.NewRequest"), "no request");
});

console.log("\nscripting");
test("test runner captures pass/fail", () => {
  const out = runScript(
    `sg.test("ok", () => sg.expect(1).toBe(1));
     sg.test("fail", () => sg.expect(1).toBe(2));`,
    { request: emptyRequest(), env: {}, global: {}, collection: {} }
  );
  eq(out.tests.length, 2);
  eq(out.tests[0].passed, true);
  eq(out.tests[1].passed, false);
});
test("sg.env.set captures updates", () => {
  const out = runScript(`sg.env.set("foo", "bar");`, { request: emptyRequest(), env: {}, global: {}, collection: {} });
  eq(out.setEnv.foo, "bar");
});
test("matchers: toEqual / toContain / toBeBetween", () => {
  const out = runScript(`
    sg.test("eq", () => sg.expect({a:1}).toEqual({a:1}));
    sg.test("contain", () => sg.expect("hello").toContain("ell"));
    sg.test("between", () => sg.expect(5).toBeBetween(1,10));
  `, { request: emptyRequest(), env: {}, global: {}, collection: {} });
  eq(out.tests.filter(t => t.passed).length, 3);
});
test("response.json() parses", () => {
  const out = runScript(`
    sg.test("body parses", () => sg.expect(sg.response.json().x).toBe(42));
  `, {
    request: emptyRequest(),
    response: { status: 200, statusText: "OK", headers: {}, body: '{"x":42}', elapsedMs: 1, sizeBytes: 8 },
    env: {}, global: {}, collection: {},
  });
  eq(out.tests[0].passed, true);
});
test("fetch/window unavailable in script", () => {
  const out = runScript(
    `sg.test("no fetch", () => { try { fetch("x"); sg.expect(true).toBe(false); } catch {} sg.expect(typeof fetch).toBe("undefined"); });`,
    { request: emptyRequest(), env: {}, global: {}, collection: {} }
  );
  eq(out.tests[0].passed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
