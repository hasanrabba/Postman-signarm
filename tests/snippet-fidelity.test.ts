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
