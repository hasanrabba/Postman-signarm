/**
 * What a user pastes into "Import cURL" must go on the wire the way curl would
 * have sent it. Each case here was checked against real curl 8.5.0 first.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn(async (p: never) => {
    sent.push(p);
    return { status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 };
  }),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

import { parseCurl } from "@/lib/curl";
import { executeRequest } from "@/lib/executor";

beforeEach(() => { sent.length = 0; });

/** parse a command and return the bytes Signal would put on the wire */
async function wire(cmd: string) {
  const req = parseCurl(cmd);
  if (!req) throw new Error("parseCurl returned null");
  await executeRequest(req, { scope: {} });
  const p = sent.at(-1)!;
  const ct = Object.entries(p.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return { method: p.method, url: p.url, contentType: ct, body: p.body };
}

/* `curl -I https://x/` is the ordinary way to ask for headers only. It
   imported as a GET, so the request downloaded the whole body. */
describe("-I and --head import as HEAD", () => {
  test("-I", async () => expect((await wire("curl -I http://x.test/a")).method).toBe("HEAD"));
  test("--head", async () => expect((await wire("curl --head http://x.test/a")).method).toBe("HEAD"));
  test("combined short flags keep it", async () =>
    expect((await wire("curl -sI http://x.test/a")).method).toBe("HEAD"));

  // -X wins over -I in real curl, whichever order they appear in.
  test("-X GET after -I stays GET", async () =>
    expect((await wire("curl -I -X GET http://x.test/a")).method).toBe("GET"));
  test("-X GET before -I stays GET", async () =>
    expect((await wire("curl -X GET -I http://x.test/a")).method).toBe("GET"));
});

/* Real curl gives every -d body `application/x-www-form-urlencoded`. Signal
   sent no Content-Type at all, so servers that dispatch on it saw nothing. */
describe("-d supplies the Content-Type curl would have sent", () => {
  test("a form body", async () => {
    const w = await wire("curl http://x.test/a -d 'a=1' -d 'b=2'");
    expect(w.contentType).toBe("application/x-www-form-urlencoded");
    expect(w.body).toBe("a=1&b=2");
  });

  test("a body that is not a form still gets it, and its bytes are untouched", async () => {
    const w = await wire("curl http://x.test/a -d 'plaintext'");
    expect(w.contentType).toBe("application/x-www-form-urlencoded");
    // Splitting this into key/value rows would re-serialise it as `plaintext=`.
    expect(w.body).toBe("plaintext");
  });

  test("an explicit header is not overridden", async () => {
    const w = await wire("curl http://x.test/a -H 'Content-Type: text/plain' -d 'a=1'");
    expect(w.contentType).toBe("text/plain");
    expect(w.body).toBe("a=1");
  });

  // Deliberate divergence from curl, pinned so it cannot change by accident:
  // a JSON-looking body with no header is treated as JSON, which is what the
  // user meant and what Postman does.
  test("a JSON body with no header is still detected as JSON", async () => {
    const w = await wire(`curl http://x.test/a -d '{"a":1}'`);
    expect(w.contentType).toBe("application/json");
    expect(w.body).toBe('{"a":1}');
  });

  test("--data-urlencode keeps its own form content type", async () => {
    const w = await wire("curl http://x.test/a --data-urlencode 'q=a b'");
    expect(w.contentType).toBe("application/x-www-form-urlencoded");
  });
});

/* `-G` moves the data into the query string, so there is no body left to
   label — real curl sends no Content-Type at all for it. */
describe("-G sends no body and so no Content-Type", () => {
  test("-G -d", async () => {
    const w = await wire("curl -G http://x.test/a -d 'q=hello'");
    expect(w.method).toBe("GET");
    expect(w.url).toBe("http://x.test/a?q=hello");
    expect(w.contentType).toBeUndefined();
    expect(w.body).toBeUndefined();
  });
});

/* An imported request must put the query on the wire the way curl did. The
   query used to be lifted into the params table unconditionally and rebuilt
   from there on every send, which rewrote it. */
describe("the query survives import byte for byte", () => {
  const cases: [string, string][] = [
    ["a plus means a space to a form parser", "http://x.test/a?q=a+b"],
    ["a valueless param has no equals sign", "http://x.test/a?flag&y=2"],
    ["a semicolon is legal in a value", "http://x.test/a?x=1;y=2"],
    ["an undecodable escape is passed through", "http://x.test/a?bad=%zz"],
    ["a second equals stays in the value", "http://x.test/a?sig=abc=def&b=1"],
    ["a second question mark stays in the value", "http://x.test/a?b=1?2"],
    ["an already-encoded space stays encoded", "http://x.test/a?q=a%20b"],
    ["an ordinary query is unchanged", "http://x.test/a?x=1&y=2"],
  ];
  for (const [name, url] of cases) {
    test(name, async () => expect((await wire(`curl '${url}'`)).url).toBe(url));
  }
});

/* Whatever the app sends, the cURL command and code snippets it shows for the
   same request must send too — three copies of this had drifted before. */
describe("what is exported matches what is sent", () => {
  test("an equals in a param value is not re-encoded on export", async () => {
    const { toCurl } = await import("@/lib/curl");
    const { generateSnippet } = await import("@/lib/snippets");
    const req = parseCurl("curl 'http://x.test/a?sig=abc=def'")!;
    const onTheWire = (await wire("curl 'http://x.test/a?sig=abc=def'")).url;
    expect(toCurl(req)).toContain(onTheWire);
    expect(generateSnippet(req, "python-requests")).toContain(onTheWire);
  });
});
