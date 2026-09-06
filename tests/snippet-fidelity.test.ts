/**
 * What the Snippets tab generates has to be what the app sends. Each of these
 * was found by generating the snippet, RUNNING it, and comparing what the
 * server received — see tests/snippet-execution.test.ts.
 */
import { describe, test, expect } from "vitest";
import { generateSnippet } from "@/lib/snippets";
import { toCurl } from "@/lib/curl";
import { emptyAuth } from "@/lib/auth";
import type { SignalRequest } from "@/lib/types";

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });
const request = (over: Partial<SignalRequest>): SignalRequest => ({
  id: "r", name: "n", method: "GET", url: "http://x.test/a", headers: [], params: [],
  auth: emptyAuth(),
  body: { mode: "none", raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
  preRequestScript: "", testScript: "",
  ...over,
} as SignalRequest);
const withBody = (mode: string, over: Record<string, unknown> = {}) =>
  request({ method: "POST", body: { mode, raw: "", urlencoded: [], formdata: [], graphql: { query: "", variables: "" }, ...over } as never });

/* `echo "..."` appended a newline to every body — enough to break a signed or
   hashed payload — and a double-quoted shell string still expands `$` and
   backticks, so a body holding `id -u` in backticks RAN it. */
describe("the httpie snippet treats the body as data", () => {
  test("no echo, and the body is single-quoted", () => {
    const out = generateSnippet(withBody("json", { raw: '{"a":1}' }), "httpie");
    expect(out).not.toMatch(/^echo /);
    expect(out).toContain(`printf '%s' '{"a":1}'`);
  });

  test("a body holding shell metacharacters cannot be expanded", () => {
    const out = generateSnippet(withBody("text", { raw: '{"h":"$HOME","w":"`id -u`"}' }), "httpie");
    // Inside single quotes the shell reads neither.
    expect(out).toContain(`printf '%s' '{"h":"$HOME","w":"\`id -u\`"}'`);
  });

  test("a single quote in the body is escaped, not left to close the string", () => {
    const out = generateSnippet(withBody("text", { raw: "it's" }), "httpie");
    expect(out).toContain(`printf '%s' 'it'\\''s'`);
  });
});

/* HTTPie reads a non-tty stdin and then refuses to mix it with key=value
   items, so from a script or a CI job the snippet died with a usage error. */
describe("the httpie snippet says whether it wants stdin", () => {
  test("--ignore-stdin when nothing is piped in", () =>
    expect(generateSnippet(request({}), "httpie")).toContain("--ignore-stdin"));
  test("and not when a body is piped in", () =>
    expect(generateSnippet(withBody("json", { raw: "{}" }), "httpie")).not.toContain("--ignore-stdin"));
});

/* `--form` means form-URLENCODED to HTTPie. A multipart request exported that
   way arrived as application/x-www-form-urlencoded with a different body. */
describe("a multipart body exports as multipart", () => {
  const form = withBody("form-data", { formdata: [{ ...kv("a", "1"), type: "text" as const }] });
  test("httpie uses --multipart", () => {
    const out = generateSnippet(form, "httpie");
    expect(out).toContain("--multipart");
    expect(out).not.toMatch(/--form\b/);
  });
});

/* curl encodes a space in --data-urlencode as `+` where the app encodes it as
   `%20`, so the exported command put different bytes on the wire. */
describe("a form-urlencoded body exports byte for byte", () => {
  const form = withBody("form-urlencoded", { urlencoded: [kv("a", "1"), kv("b", "x y")] });
  test("curl sends the already-encoded body", () => {
    const out = toCurl(form);
    expect(out).toContain("--data-raw 'a=1&b=x%20y'");
    expect(out).not.toContain("--data-urlencode");
  });
});

/* Leading and trailing spaces are not part of a header's value, and python's
   requests refuses one that has them — the copied snippet raised. */
describe("a padded header value is trimmed", () => {
  const padded = request({ headers: [kv("X-Pad", "  padded  ")] });
  test("cURL", () => expect(toCurl(padded)).toContain("'X-Pad: padded'"));
  for (const lang of ["fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
    test(lang, () => {
      const out = generateSnippet(padded, lang);
      expect(out).toContain("padded");
      expect(out).not.toContain("  padded  ");
    });
  }
});

/* Found by the sweep, each confirmed against real curl 8.5.0 or the app's own
   sender before being fixed. */
describe("what the sweep turned up", () => {
  test("a lone surrogate in a param does not take the app down", () => {
    // Half an emoji is what a truncated paste leaves behind, and
    // encodeURIComponent throws URIError on it — which threw while the
    // Snippets panel was rendering and whited out the whole app.
    const r = request({ params: [kv("q", "hi \uD83D")] });
    for (const lang of ["curl", "fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
      expect(() => generateSnippet(r, lang), lang).not.toThrow();
    }
    expect(toCurl(r)).toContain("q=hi%20%EF%BF%BD");
  });

  test("two rows with the same header name both survive into the snippet", () => {
    const r = request({ headers: [kv("X-A", "one"), { id: "2", key: "X-A", value: "two", enabled: true }] });
    for (const lang of ["fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
      expect(generateSnippet(r, lang), lang).toContain("one, two");
    }
    // curl carries them as two -H lines, which a server joins the same way.
    expect(toCurl(r)).toContain("'X-A: one'");
    expect(toCurl(r)).toContain("'X-A: two'");
  });

  test("two Cookie rows are joined with a semicolon", () => {
    const r = request({ headers: [kv("Cookie", "a=1"), { id: "2", key: "Cookie", value: "b=2", enabled: true }] });
    expect(generateSnippet(r, "python-requests")).toContain("a=1; b=2");
  });

  /* The app's proxy drops the body of a GET or a HEAD outright, so a snippet
     that sends one does something the app never does — and fetch and
     node-fetch refuse to run at all with one. */
  test("a GET does not export a body the app would drop", () => {
    const r = request({ method: "GET", body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } as never });
    const out = toCurl(r);
    expect(out).not.toContain("--data-raw");
    // and so no data flag to make curl default to POST
    expect(out).not.toContain("-X GET");
  });

  test("a HEAD does not export one either", () => {
    const r = request({ method: "HEAD", body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } as never });
    expect(toCurl(r)).not.toContain("--data-raw");
  });

  for (const lang of ["fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
    test(`the ${lang} snippet drops a GET body too`, () => {
      const r = request({ method: "GET", body: { mode: "json", raw: '{"MARKER":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } as never });
      expect(generateSnippet(r, lang)).not.toContain("MARKER");
    });
  }

  test("a POST still keeps its body (control)", () => {
    const r = request({ method: "POST", body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } as never });
    expect(toCurl(r)).toContain("--data-raw");
  });

  /* Every client falls back to its own default for an unlabelled string body —
     curl called it a form post, HTTPie called it JSON — so the type the app
     sends is stated explicitly. */
  test("a text body carries the type the app sends", () => {
    const r = request({ method: "POST", body: { mode: "text", raw: "hello", urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } as never });
    expect(toCurl(r)).toContain("Content-Type: text/plain;charset=UTF-8");
    for (const lang of ["fetch", "python-requests", "go", "httpie"] as const) {
      expect(generateSnippet(r, lang), lang).toContain("text/plain;charset=UTF-8");
    }
  });

  test("a form text value starting with @ is not read off the user's disk", () => {
    const r = request({ method: "POST", body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ ...kv("msg", "@channel deploy is green"), type: "text" as const }],
      graphql: { query: "", variables: "" } } as never });
    // `-F` made curl try to open a file called "channel deploy is green",
    // fail, and send nothing at all.
    expect(toCurl(r)).toContain("--form-string 'msg=@channel deploy is green'");
  });

  test("a file field still uses -F", () => {
    const r = request({ method: "POST", body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ ...kv("f", ""), type: "file" as const, fileName: "a.bin" }],
      graphql: { query: "", variables: "" } } as never });
    expect(toCurl(r)).toContain("-F f=@a.bin");
  });
});

/* HTTPie reads the first separator it finds: `=` a data field, `:` a header,
   `==` a query parameter, `:=` raw JSON, `=@` a FILE off disk. */
describe("httpie request items are escaped", () => {
  test("a form value starting with @ is not read off disk", () => {
    const r = request({ method: "POST", body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ ...kv("msg", "@channel deploy"), type: "text" as const }],
      graphql: { query: "", variables: "" } } as never });
    expect(generateSnippet(r, "httpie")).toContain("msg=\\@channel deploy");
  });

  test("a header value starting with = does not become a JSON body", () =>
    expect(generateSnippet(request({ headers: [kv("X-Expr", "=1+1")] }), "httpie"))
      .toContain("X-Expr:\\=1+1"));

  test("a field name holding a separator is escaped", () => {
    const r = request({ method: "POST", body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ ...kv("a:b", "1"), type: "text" as const }],
      graphql: { query: "", variables: "" } } as never });
    expect(generateSnippet(r, "httpie")).toContain("a\\:b=1");
  });

  test("an empty header uses the spelling that sends it", () =>
    expect(generateSnippet(request({ headers: [kv("X-Trace", "")] }), "httpie"))
      .toContain("X-Trace;"));

  test("an ordinary header is untouched", () =>
    expect(generateSnippet(request({ headers: [kv("X-A", "1")] }), "httpie")).toContain("X-A:1"));
});
