// @vitest-environment node
/**
 * What the proxy hands the viewer.
 *
 * Three decisions used to destroy data before anything was rendered: which
 * content types count as text, which charset to decode in, and what to do when
 * the server names no type at all.
 */
import { test, expect, vi, beforeEach, describe } from "vitest";
import { POST } from "@/app/api/proxy/route";

const PUB = "http://93.184.216.34";

function req(body: unknown) {
  return new Request("http://proxy.test/api/proxy", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}
function serve(make: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async () => make()));
}
const send = async () => (await (await POST(req({ method: "GET", url: PUB + "/" }))).json());

beforeEach(() => vi.unstubAllGlobals());

describe("which bodies are readable as text", () => {
  // Every SOAP endpoint, every HAL API, every RSS feed. These came back
  // base64 and hid behind the "Binary response" card.
  const TEXT = [
    ["application/soap+xml; charset=utf-8", "<Envelope/>"],
    ["application/hal+json", '{"_links":{}}'],
    ["application/atom+xml", "<feed/>"],
    ["application/rss+xml", "<rss/>"],
    ["application/xhtml+xml", "<html/>"],
    ["application/vnd.github.v3+json", '{"a":1}'],
    ["image/svg+xml", "<svg/>"],
    ["application/yaml", "a: 1"],
    ["application/x-ndjson", '{"a":1}\n{"a":2}'],
    ["text/csv", "a,b\n1,2"],
  ] as const;

  for (const [ct, body] of TEXT) {
    test(`${ct} arrives as text`, async () => {
      serve(() => new Response(body, { status: 200, headers: { "content-type": ct } }));
      const r = await send();
      expect(r.bodyIsBase64).toBeFalsy();
      expect(r.body).toBe(body);
    });
  }

  for (const ct of ["image/png", "application/zip", "video/mp4", "application/octet-stream"]) {
    test(`${ct} is still kept as bytes`, async () => {
      serve(() => new Response(new Uint8Array([0, 1, 2, 255]), { status: 200, headers: { "content-type": ct } }));
      const r = await send();
      expect(r.bodyIsBase64).toBe(true);
      expect([...Buffer.from(r.body, "base64")]).toEqual([0, 1, 2, 255]);
    });
  }
});

describe("a server that names no content-type", () => {
  test("a PNG is kept as bytes rather than mangled into mojibake", async () => {
    // An empty type used to count as text, so the PNG went through a lossy
    // UTF-8 decode: 0x89 became U+FFFD, the bytes were gone, and because
    // bodyIsBase64 was never set the Download button never appeared.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    serve(() => new Response(png, { status: 200 }));
    const r = await send();
    expect(r.bodyIsBase64).toBe(true);
    expect([...Buffer.from(r.body, "base64")]).toEqual([...png]);
  });

  test("actual text is still shown as text", async () => {
    serve(() => new Response("plain words", { status: 200 }));
    const r = await send();
    expect(r.bodyIsBase64).toBeFalsy();
    expect(r.body).toBe("plain words");
  });
});

describe("the charset the server declared is the one used", () => {
  test("iso-8859-1 accents survive", async () => {
    // Everything was decoded as UTF-8, so 0xE9 became U+FFFD and no path in
    // the app could get the real character back.
    serve(() => new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
      status: 200, headers: { "content-type": "text/plain; charset=iso-8859-1" },
    }));
    expect((await send()).body).toBe("café");
  });

  test("windows-1252 smart quotes survive", async () => {
    serve(() => new Response(new Uint8Array([0x69, 0x74, 0x92, 0x73]), {
      status: 200, headers: { "content-type": 'text/plain; charset="windows-1252"' },
    }));
    expect((await send()).body).toBe("it’s");
  });

  test("shift_jis is decoded, not replaced with diamonds", async () => {
    const bytes = new Uint8Array([0x82, 0xa0, 0x82, 0xa2]); // あい
    serve(() => new Response(bytes, {
      status: 200, headers: { "content-type": "text/plain; charset=shift_jis" },
    }));
    expect((await send()).body).toBe("あい");
  });

  test("a UTF-16 JSON body is not a string full of invisible NULs", async () => {
    const json = '{"a":1}';
    const le = new Uint8Array(json.length * 2);
    for (let i = 0; i < json.length; i++) { le[i * 2] = json.charCodeAt(i); le[i * 2 + 1] = 0; }
    serve(() => new Response(le, {
      status: 200, headers: { "content-type": "application/json; charset=utf-16le" },
    }));
    const r = await send();
    expect(r.body).toBe(json);
    expect(() => JSON.parse(r.body)).not.toThrow();
  });

  test("a UTF-8 BOM does not survive to break JSON.parse", async () => {
    serve(() => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const r = await send();
    expect(r.body).toBe("{}");
    expect(() => JSON.parse(r.body)).not.toThrow();
  });
});

describe("every header line the server sent", () => {
  test("a login that sets two cookies shows both", async () => {
    // Headers.forEach yields set-cookie once per cookie, so writing into a
    // plain object kept only the last — and the one that survived was the
    // CSRF cookie, not the session cookie.
    serve(() => {
      const h = new Headers({ "content-type": "text/plain" });
      h.append("set-cookie", "session=abc123; Path=/; HttpOnly");
      h.append("set-cookie", "csrf=zzz999; Path=/");
      return new Response("ok", { status: 200, headers: h });
    });
    const r = await send();
    const cookies = (r.headerList as [string, string][])
      .filter(([k]) => k.toLowerCase() === "set-cookie")
      .map(([, v]) => v);
    expect(cookies).toEqual([
      "session=abc123; Path=/; HttpOnly",
      "csrf=zzz999; Path=/",
    ]);
    // And a script reading the flat map can still find both.
    expect(r.headers["set-cookie"]).toContain("session=abc123");
    expect(r.headers["set-cookie"]).toContain("csrf=zzz999");
  });

  test("repeated ordinary headers are joined, not dropped", async () => {
    serve(() => {
      const h = new Headers({ "content-type": "text/plain" });
      h.append("x-dup", "one");
      h.append("x-dup", "two");
      return new Response("ok", { status: 200, headers: h });
    });
    const r = await send();
    expect(r.headers["x-dup"]).toBe("one, two");
  });

  test("a server-chosen status text cannot push the status bar off screen", async () => {
    serve(() => new Response("ok", { status: 200, statusText: "A".repeat(5000) }));
    expect((await send()).statusText.length).toBeLessThanOrEqual(120);
  });
});

describe("why a request failed", () => {
  test("the reason is more than the words 'fetch failed'", async () => {
    // undici says "fetch failed" for a refused connection, a socket hung up
    // mid-response and a TLS error alike; the reason lives on `cause`, which
    // was thrown away, so all three reached the user identically.
    const e = new TypeError("fetch failed");
    (e as Error & { cause?: unknown }).cause =
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw e; }));
    const r = await send();
    expect(r.error).toContain("fetch failed");
    expect(r.error).toContain("ECONNREFUSED");
  });

  test("a cause chain that loops does not hang", async () => {
    const a = new Error("outer");
    const b = new Error("inner");
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    vi.stubGlobal("fetch", vi.fn(async () => { throw a; }));
    expect((await send()).error).toBe("outer — inner");
  });
});
