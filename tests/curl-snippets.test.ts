import { describe, test, expect } from "vitest";
import { parseCurl, toCurl } from "@/lib/curl";
import { generateSnippet } from "@/lib/snippets";
import { emptyRequest } from "@/lib/defaults";
import { appendQuery } from "@/lib/url";

const decode = (h: string) => Buffer.from(h.replace("Basic ", ""), "base64").toString("utf8");

describe("importing a cURL command", () => {
  test("-u with a non-ASCII password does not abort the import", () => {
    const req = parseCurl(`curl -u 'user:пароль' https://x.test/`)!;
    expect(req).not.toBeNull();
    const auth = req.headers.find((h) => h.key === "Authorization")!;
    expect(decode(auth.value)).toBe("user:пароль");
  });

  test("-u without a password still gets the trailing colon (control)", () => {
    const req = parseCurl(`curl -u alice https://x.test/`)!;
    expect(decode(req.headers.find((h) => h.key === "Authorization")!.value)).toBe("alice:");
  });

  test("a fragment stays on the URL instead of leaking into a param", () => {
    const req = parseCurl(`curl 'https://x.test/a?b=1#section'`)!;
    expect(req.params.map((p) => [p.key, p.value])).toEqual([["b", "1"]]);
    expect(req.url).toBe("https://x.test/a#section");
  });

  test("a second question mark stays in the query value", () => {
    const req = parseCurl(`curl 'https://x.test/a?b=1?2'`)!;
    expect(req.params.map((p) => [p.key, p.value])).toEqual([["b", "1?2"]]);
  });

  test("-G moves the data into the query string", () => {
    const req = parseCurl(`curl -G -d 'a=b' -d 'c=d' https://x.test/`)!;
    expect(req.method).toBe("GET");
    expect(req.params.map((p) => [p.key, p.value])).toEqual([["a", "b"], ["c", "d"]]);
    expect(req.body.mode).toBe("none");
    expect(req.body.raw).toBe("");
  });

  test("-d without -G is still a body (control)", () => {
    const req = parseCurl(`curl -d 'a=b' https://x.test/`)!;
    expect(req.method).toBe("POST");
    expect(req.body.raw).toBe("a=b");
  });

  test("a flag whose value looks like a URL does not steal the URL", () => {
    const req = parseCurl(`curl --proxy http://proxy.test:8080 https://real.test/path`)!;
    expect(req.url).toBe("https://real.test/path");
  });

  test("-x is handled the same way", () => {
    const req = parseCurl(`curl -x http://proxy.test:8080 https://real.test/`)!;
    expect(req.url).toBe("https://real.test/");
  });

  test("an ordinary command still imports (control)", () => {
    const req = parseCurl(`curl -X POST -H 'Accept: application/json' https://x.test/v1`)!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://x.test/v1");
    expect(req.headers.find((h) => h.key === "Accept")?.value).toBe("application/json");
  });
});

describe("exporting to cURL", () => {
  test("a quote in a header key cannot break out of the argument", () => {
    const out = toCurl(emptyRequest({
      url: "https://x.test/",
      headers: [{ id: "h", key: "X-A'B", value: "v", enabled: true }],
    }));
    expect(out).toContain(`-H 'X-A'\\''B: v'`);
  });

  test("params go before the fragment", () => {
    const out = toCurl(emptyRequest({
      url: "https://x.test/p#frag",
      params: [{ id: "p", key: "a", value: "1", enabled: true }],
    }));
    expect(out).toContain("https://x.test/p?a=1#frag");
  });

  test("a form-data key containing a quote is quoted", () => {
    const out = toCurl(emptyRequest({
      url: "https://x.test/",
      body: { mode: "form-data", formdata: [{ id: "f", key: "a'b", value: "v", enabled: true }] },
    }));
    expect(out).toContain(`-F 'a'\\''b=v'`);
  });

  test("an ordinary header is quoted but otherwise untouched (control)", () => {
    const out = toCurl(emptyRequest({
      url: "https://x.test/",
      headers: [{ id: "h", key: "Accept", value: "application/json", enabled: true }],
    }));
    // The "key: value" form always contains a space, so it is always quoted.
    expect(out).toContain(`-H 'Accept: application/json'`);
    // A URL with nothing special in it still needs no quotes.
    expect(out).toContain("curl \\\n  https://x.test/");
  });
});

describe("round-tripping through cURL", () => {
  test("params, headers and body survive export then import", () => {
    const original = emptyRequest({
      method: "POST",
      url: "https://x.test/api",
      params: [{ id: "p", key: "q", value: "a b&c", enabled: true }],
      headers: [{ id: "h", key: "X-Trace", value: "it's here", enabled: true }],
      body: { mode: "json", raw: '{"n":1}' },
    });
    const back = parseCurl(toCurl(original))!;
    expect(back.params.map((p) => [p.key, p.value])).toEqual([["q", "a b&c"]]);
    expect(back.headers.find((h) => h.key === "X-Trace")?.value).toBe("it's here");
    expect(back.body.raw).toBe('{"n":1}');
  });

  test("a fragment survives the round trip", () => {
    const original = emptyRequest({
      url: "https://x.test/p#frag",
      params: [{ id: "p", key: "a", value: "1", enabled: true }],
    });
    const back = parseCurl(toCurl(original))!;
    expect(back.url).toBe("https://x.test/p#frag");
    expect(back.params.map((p) => [p.key, p.value])).toEqual([["a", "1"]]);
  });
});

describe("generated snippets", () => {
  test("httpie quotes a header value containing spaces", () => {
    const out = generateSnippet(emptyRequest({
      url: "https://x.test/",
      headers: [{ id: "h", key: "User-Agent", value: "My App/1.0", enabled: true }],
    }), "httpie");
    expect(out).toContain(`'User-Agent:My App/1.0'`);
  });

  test("httpie leaves a simple header bare (control)", () => {
    const out = generateSnippet(emptyRequest({
      url: "https://x.test/",
      headers: [{ id: "h", key: "Accept", value: "application/json", enabled: true }],
    }), "httpie");
    expect(out).toContain("Accept:application/json");
    expect(out).not.toContain("'Accept:application/json'");
  });

  test("every generator puts params before the fragment", () => {
    const req = emptyRequest({
      url: "https://x.test/p#frag",
      params: [{ id: "p", key: "a", value: "1", enabled: true }],
    });
    for (const lang of ["curl", "fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
      const out = generateSnippet(req, lang);
      expect(out, lang).toContain("https://x.test/p?a=1#frag");
      expect(out, lang).not.toContain("#frag?a=1");
    }
  });
});

describe("appendQuery", () => {
  test("no query returns the url unchanged", () => {
    expect(appendQuery("http://x/#f", "")).toBe("http://x/#f");
  });
  test("inserts before a fragment", () => {
    expect(appendQuery("http://x/p#f", "a=1")).toBe("http://x/p?a=1#f");
  });
  test("uses & when a query already exists", () => {
    expect(appendQuery("http://x/p?z=0#f", "a=1")).toBe("http://x/p?z=0&a=1#f");
  });
  test("plain url", () => {
    expect(appendQuery("http://x/p", "a=1")).toBe("http://x/p?a=1");
  });
});
