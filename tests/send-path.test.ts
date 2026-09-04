import { describe, test, expect, vi, afterEach } from "vitest";
import { applyAuth } from "@/lib/auth";
import { executeRequest } from "@/lib/executor";
import { emptyRequest } from "@/lib/defaults";
import type { SignalRequest } from "@/lib/types";

const scope = { global: [], environment: [], collection: [], secrets: [], data: {} };
afterEach(() => vi.unstubAllGlobals());

/** Run a request through the real serialisation path, capturing the payload. */
async function capture(req: SignalRequest) {
  let sent: { method: string; url: string; headers: Record<string, string>; body?: string } | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return { json: async () => ({ status: 200, statusText: "OK", headers: {}, body: "", sizeBytes: 0, elapsedMs: 0 }) };
  }));
  const result = await executeRequest(req, { scope, proxyUrl: "http://proxy.test/" });
  return { sent: sent!, result };
}

function basicHeader(username: string, password: string): string {
  const req = emptyRequest({ auth: { type: "basic", basic: { username, password } } });
  return applyAuth(req).headers.find((h) => h.key === "Authorization")!.value;
}
const decode = (h: string) => Buffer.from(h.replace("Basic ", ""), "base64").toString("utf8");

/* btoa() throws above U+00FF and silently emits Latin-1 bytes below it.
   RFC 7617 requires the credentials to be UTF-8 before base64. */
describe("basic auth credential encoding", () => {
  test("a Cyrillic password does not throw", () => {
    expect(() => basicHeader("user", "пароль")).not.toThrow();
    expect(decode(basicHeader("user", "пароль"))).toBe("user:пароль");
  });

  test("an emoji in the password does not throw", () => {
    expect(() => basicHeader("user", "pw🔑")).not.toThrow();
    expect(decode(basicHeader("user", "pw🔑"))).toBe("user:pw🔑");
  });

  test("a Latin-1 password is sent as UTF-8, not as Latin-1 bytes", () => {
    const raw = Buffer.from(basicHeader("user", "pässword").replace("Basic ", ""), "base64");
    expect(raw.toString("hex")).toContain("c3a4");   // ä as UTF-8
    expect(raw.toString("hex")).not.toContain("70e4"); // not "p" + Latin-1 ä
    expect(decode(basicHeader("user", "pässword"))).toBe("user:pässword");
  });

  test("a plain ASCII password is unchanged", () => {
    expect(decode(basicHeader("user", "hunter2"))).toBe("user:hunter2");
  });

  test("a non-ASCII username is handled too", () => {
    expect(decode(basicHeader("ユーザー", "pw"))).toBe("ユーザー:pw");
  });
});

describe("serialising the request for the proxy", () => {
  test("repeated header names are combined, not dropped", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      headers: [
        { id: "h1", key: "X-Multi", value: "one", enabled: true },
        { id: "h2", key: "x-multi", value: "two", enabled: true },
      ],
    }));
    expect(sent.headers["X-Multi"]).toBe("one, two");
  });

  test("repeated Cookie headers use the cookie separator", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      headers: [
        { id: "h1", key: "Cookie", value: "a=1", enabled: true },
        { id: "h2", key: "Cookie", value: "b=2", enabled: true },
      ],
    }));
    expect(sent.headers["Cookie"]).toBe("a=1; b=2");
  });

  test("a disabled duplicate is still ignored", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      headers: [
        { id: "h1", key: "X-Multi", value: "one", enabled: true },
        { id: "h2", key: "X-Multi", value: "two", enabled: false },
      ],
    }));
    expect(sent.headers["X-Multi"]).toBe("one");
  });

  test("params go before the fragment, not after it", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/page#section",
      params: [{ id: "p1", key: "a", value: "1", enabled: true }],
    }));
    expect(sent.url).toBe("http://example.com/page?a=1#section");
  });

  test("params still append correctly with an existing query and a fragment", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/page?x=0#frag",
      params: [{ id: "p1", key: "a", value: "1", enabled: true }],
    }));
    expect(sent.url).toBe("http://example.com/page?x=0&a=1#frag");
  });

  test("a URL with no fragment is unaffected", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/page",
      params: [{ id: "p1", key: "a", value: "1", enabled: true }],
    }));
    expect(sent.url).toBe("http://example.com/page?a=1");
  });

  test("malformed GraphQL variables are reported instead of silently dropped", async () => {
    const { result } = await capture(emptyRequest({
      url: "http://example.com/",
      body: { mode: "graphql", graphql: { query: "{ me }", variables: "{ oops: }" } },
    }));
    expect(result.logs.join("\n")).toMatch(/GraphQL variables are not valid JSON/i);
  });

  test("valid GraphQL variables produce no warning", async () => {
    const { sent, result } = await capture(emptyRequest({
      url: "http://example.com/",
      body: { mode: "graphql", graphql: { query: "{ me }", variables: '{"id":1}' } },
    }));
    expect(result.logs.join("\n")).not.toMatch(/not valid JSON/i);
    expect(JSON.parse(sent.body!).variables).toEqual({ id: 1 });
  });

  test("a quote in a form-data field name cannot forge a second name", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      body: { mode: "form-data", formdata: [
        { id: "f1", key: 'a"; name="injected', value: "v", enabled: true },
      ] },
    }));
    expect(sent.body).not.toContain('name="injected"');
    expect(sent.body).toContain('name="a%22; name=%22injected"');
  });

  test("a newline in a form-data field name cannot inject a part header", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      body: { mode: "form-data", formdata: [
        { id: "f1", key: "a\r\nX-Injected: yes", value: "v", enabled: true },
      ] },
    }));
    expect(sent.body).not.toMatch(/^X-Injected:/m);
  });

  test("an ordinary form-data field is untouched", async () => {
    const { sent } = await capture(emptyRequest({
      url: "http://example.com/",
      body: { mode: "form-data", formdata: [
        { id: "f1", key: "file", value: "hello", enabled: true },
      ] },
    }));
    expect(sent.body).toContain('name="file"');
    expect(sent.body).toContain("hello");
  });
});
