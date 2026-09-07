// @vitest-environment node
/**
 * REFUTATION of "mock routes are accepted but can never be hit".
 *
 * The claim rests on one assumption: that a stored path or mockId containing
 * "?", "/" or a trailing "/" can never appear in a request. It can — that is
 * what percent-encoding is for. Next matches the route on the *encoded*
 * pathname (so %2F is not a segment separator) and then decodes each param,
 * so the handler receives exactly the stored string.
 *
 * `decodeParams` below is what Next does to a pathname; the same four URLs were
 * also driven against a real `next dev` server and returned the mock bodies.
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import { GET as serve } from "@/app/api/mock/[mockId]/[[...path]]/route";

const post = (body: unknown) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never);

/** Split an /api/mock/... pathname the way the router does, then decode. */
function decodeParams(pathname: string) {
  const segs = pathname.replace(/^\/api\/mock\//, "").split("/").map(decodeURIComponent);
  return { mockId: segs[0], path: segs.slice(1) };
}

const request = (url: string) =>
  serve(new Request(url) as never, { params: Promise.resolve(decodeParams(new URL(url).pathname)) } as never);

const route = (over: Record<string, unknown> = {}) => ({
  id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x", ...over,
});

describe("the 'unreachable' routes are reachable", () => {
  test.each([
    ["a path with a query string", "q1", "/z?a=1", "http://localhost/api/mock/q1/z%3Fa=1", "HIT-QUERY"],
    ["a path with a trailing slash", "trail", "/z/", "http://localhost/api/mock/trail/z%2F", "HIT-TRAILING"],
    ["a path with a leading double slash", "ev", "//evil", "http://localhost/api/mock/ev/%2Fevil", "HIT-DOUBLE"],
  ])("%s is stored and then served", async (_label, mockId, path, url, body) => {
    expect((await post({ mockId, routes: [route({ path, body })] })).status).toBe(200);
    const served = await request(url);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(body);
  });

  test("a mockId containing a slash is stored and then served", async () => {
    expect((await post({ mockId: "a/b", routes: [route({ body: "HIT-SLASH-ID" })] })).status).toBe(200);
    const served = await request("http://localhost/api/mock/a%2Fb/z");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("HIT-SLASH-ID");
  });
});
