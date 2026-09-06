/**
 * The command in the cURL tab is meant to be pasted into a terminal, so what
 * matters is what the SHELL does with it, not how it reads.
 * tests/curl-wire-differential.test.ts runs each of these through real curl
 * and compares against what the app itself sends.
 */
import { describe, test, expect } from "vitest";
import { toCurl } from "@/lib/curl";
import { generateSnippet } from "@/lib/snippets";
import { emptyAuth } from "@/lib/auth";
import { resolveRequest } from "@/lib/executor";
import type { SignalRequest } from "@/lib/types";

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });
const request = (over: Partial<SignalRequest>): SignalRequest => ({
  id: "r", name: "n", method: "GET", url: "http://x.test/a", headers: [], params: [],
  auth: emptyAuth(),
  body: { mode: "none", raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  preRequestScript: "", testScript: "",
  ...over,
} as SignalRequest);

/* `curl http://x/a?x=1&y=2` pasted into a shell runs curl on `?x=1` in the
   BACKGROUND and reads `y=2` as a variable assignment, so every parameter
   after the first vanishes without a word. */
describe("the exported command survives a shell", () => {
  test("a URL with two params is quoted", () => {
    const out = toCurl(request({ params: [kv("x", "1"), kv("y", "2")] }));
    expect(out).toContain("'http://x.test/a?x=1&y=2'");
  });
  test("a URL with a fragment is quoted", () => {
    expect(toCurl(request({ url: "http://x.test/a#frag" }))).toContain("'http://x.test/a#frag'");
  });
  test("a URL with a glob character is quoted", () => {
    expect(toCurl(request({ params: [kv("q", "a[1]")] }))).toContain("'http://x.test/a?q=a%5B1%5D'");
  });
  test("a plain URL is still left bare", () => {
    expect(toCurl(request({}))).toContain("curl \\\n  http://x.test/a");
  });
  test("the httpie snippet quotes it too", () => {
    expect(generateSnippet(request({ params: [kv("x", "1"), kv("y", "2")] }), "httpie"))
      .toContain("'http://x.test/a?x=1&y=2'");
  });
});

/* `-X HEAD` makes curl wait for a body a HEAD response never sends, so the
   command sat in the terminal until the user killed it. */
describe("a HEAD request exports as -I", () => {
  test("-I, not -X HEAD", () => {
    const out = toCurl(request({ method: "HEAD" }));
    expect(out).toContain("-I");
    expect(out).not.toContain("-X HEAD");
  });
});

/* `-H 'X: '` makes curl DROP the header rather than send it empty. */
describe("a deliberately empty header is still sent", () => {
  test("the trailing-semicolon spelling", () => {
    expect(toCurl(request({ headers: [kv("X-Trace", "")] }))).toContain("'X-Trace;'");
  });
  test("an ordinary header is unaffected", () => {
    expect(toCurl(request({ headers: [kv("X-Trace", "1")] }))).toContain("'X-Trace: 1'");
  });
});

/* The app labels a JSON body application/json; curl labels every --data-raw
   body as form data, so the same request came back 415 in the terminal. */
describe("the exported command carries the Content-Type the app sends", () => {
  const json = request({
    method: "POST",
    body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  });

  test("cURL", () => expect(toCurl(json)).toContain("'Content-Type: application/json'"));
  test("xml", () => expect(toCurl(request({
    method: "POST",
    body: { mode: "xml", raw: "<a>1</a>", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  }))).toContain("'Content-Type: application/xml'"));
  test("graphql", () => expect(toCurl(request({
    method: "POST",
    body: { mode: "graphql", raw: "", urlencoded: [], formdata: [], graphql: { query: "{ me }", variables: "" } },
  }))).toContain("'Content-Type: application/json'"));

  test("an explicit Content-Type is not doubled", () => {
    const out = toCurl(request({
      method: "POST", headers: [kv("Content-Type", "application/vnd.api+json")],
      body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    }));
    expect(out).toContain("application/vnd.api+json");
    expect(out).not.toContain("'Content-Type: application/json'");
  });

  for (const lang of ["fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
    test(`the ${lang} snippet carries it too`, () =>
      expect(generateSnippet(json, lang)).toContain("application/json"));
  }

  test("a multipart body does not get a hand-written Content-Type", () => {
    const form = request({
      method: "POST",
      body: {
        mode: "form-data", raw: "", urlencoded: [],
        formdata: [{ ...kv("f", "1"), type: "text" as const }],
        graphql: { query: "", variables: "" },
      },
    });
    expect(generateSnippet(form, "fetch")).not.toContain("multipart/form-data");
  });
});

/* A command still carrying {{version}} in its URL is one real curl refuses to
   run ("nested brace in URL"); one carrying {{token}} in a header sends that
   literal text and comes back 401. */
describe("a snippet is generated from the resolved request", () => {
  const scope = {
    global: [kv("host", "api.example.com")],
    environment: [kv("token", "s3cr3t")],
    collection: [kv("version", "v2")],
  };

  test("the URL's variables are substituted", () => {
    const req = request({ url: "https://{{host}}/{{version}}/users" });
    expect(toCurl(resolveRequest(req, scope))).toContain("https://api.example.com/v2/users");
  });

  test("a header's variables are substituted", () => {
    const req = request({ headers: [kv("X-Token", "{{token}}")] });
    expect(toCurl(resolveRequest(req, scope))).toContain("'X-Token: s3cr3t'");
  });

  test("every generator resolves them", () => {
    const req = request({ url: "https://{{host}}/x", headers: [kv("X-Token", "{{token}}")] });
    for (const lang of ["fetch", "python-requests", "go", "httpie"] as const) {
      const out = generateSnippet(resolveRequest(req, scope), lang);
      expect(out, lang).not.toContain("{{");
      expect(out, lang).toContain("api.example.com");
    }
  });

  // A copied snippet goes to a clipboard, a chat window or a bug report, and a
  // secret that leaves the vault that way cannot be called back.
  test("a vault secret is left as a placeholder", () => {
    const req = request({ headers: [kv("Authorization", "{{vaultKey}}")] });
    expect(toCurl(resolveRequest(req, scope))).toContain("{{vaultKey}}");
  });
});
