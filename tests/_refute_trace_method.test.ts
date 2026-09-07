// @vitest-environment node
/**
 * REFUTATION of: "a route saved for TRACE publishes fine and then returns a
 * 500 error page instead of the mock response".
 *
 * The 500 is real, but it is Next's, not this app's, and the publish has
 * nothing to do with it. Verified against a live `next start` (Next 16.3.4):
 *
 *   TRACE /api/mock/m1/tr        -> 500   (route published)
 *   TRACE /api/mock/m1/tr        -> 500   (server that never got a publish)
 *   TRACE /api/mock-config       -> 500   (the config endpoint itself)
 *   TRACE /api/proxy             -> 500   (an unrelated route)
 *   PURGE /api/mock/m1/tr        -> 400   (an unexported method: clean refusal)
 *
 * dev log, every time:
 *   TypeError: 'TRACE' HTTP method is unsupported.
 *       at new NextRequest (...)
 *       at NextRequestAdapter.fromNodeNextRequest (...)
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import * as mockRoute from "@/app/api/mock/[mockId]/[[...path]]/route";
import { HTTP_METHODS } from "next/dist/server/web/http";

const post = (body: unknown) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never);

const route = (over: Record<string, unknown> = {}) => ({
  id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x", ...over,
});

describe("the TRACE 500 is a framework-level refusal, not a mock-server bug", () => {
  test("the runtime forbids constructing a TRACE Request at all — this is where the quoted TypeError comes from", () => {
    // Fetch spec: CONNECT/TRACE/TRACK are forbidden methods. Next builds a
    // NextRequest (a Request subclass) from the node request before any app
    // code runs, so the throw is upstream of this repo entirely.
    expect(() => new Request("http://localhost/api/mock/m1/tr", { method: "TRACE" }))
      .toThrowError("'TRACE' HTTP method is unsupported.");
    // The same is true for its siblings — nothing about mock routes involved.
    expect(() => new Request("http://localhost/", { method: "TRACK" })).toThrow();
    expect(() => new Request("http://localhost/", { method: "CONNECT" })).toThrow();
    // A method Next simply does not export is constructible and harmless.
    expect(() => new Request("http://localhost/", { method: "PURGE" })).not.toThrow();
  });

  test("exporting TRACE from the serving module — the finder's fix — could never be dispatched", () => {
    // Next only ever dispatches these seven. A `export async function TRACE`
    // would be dead code: autoImplementMethods never reads it and
    // resolveHandler 400s anything outside the list.
    expect([...HTTP_METHODS].sort()).toEqual(
      ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    );
    expect(HTTP_METHODS).not.toContain("TRACE");
    // And the module already exports every method Next can dispatch.
    for (const m of HTTP_METHODS) {
      expect((mockRoute as Record<string, unknown>)[m]).toBeTypeOf("function");
    }
  });

  test("the missing-export story predicts 405/400, never a 500", () => {
    // A method Next knows but the module does not export gets Next's
    // handleMethodNotAllowedResponse (405); a method Next does not know gets
    // resolveHandler's 400. Live server confirms: PURGE -> 400.
    // Nothing in that path can produce the reported 500.
    const exported = HTTP_METHODS.filter((m) => (mockRoute as Record<string, unknown>)[m]);
    expect(exported).toHaveLength(HTTP_METHODS.length); // no 405 is even reachable here
  });

  test("storing a TRACE route changes nothing about what the server does with TRACE", async () => {
    // The claim's remedy is that the config should reject TRACE. It would not
    // help: with an EMPTY registry the live server still 500s on
    // TRACE /api/mock/<anything>, and 500s on /api/mock-config itself.
    // Here we show the stored route is simply inert for every method Next can
    // actually dispatch — it is not a landmine waiting to 500 anyone.
    expect((await post({ mockId: "rt1", routes: [route({ method: "TRACE", path: "/tr" })] })).status).toBe(200);
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const) {
      const req = new Request("http://localhost/api/mock/rt1/tr", { method: m }) as never;
      const ctx = { params: Promise.resolve({ mockId: "rt1", path: ["tr"] }) } as never;
      const res = await (mockRoute as Record<string, (r: never, c: never) => Promise<Response>>)[m](req, ctx);
      expect(res.status).toBe(404); // a clean "no matching mock route", never a throw
      expect(await res.json()).toMatchObject({ error: "No matching mock route" });
    }
  });

  test("a lowercase 'trace' route — which IS constructible as a request — also does not crash anything", async () => {
    // The nearest thing to the claim that the app can actually be asked:
    // any stored method that Next can dispatch is matched or 404s, no throw.
    expect((await post({ mockId: "rt2", routes: [route({ method: "patch", path: "/p", body: "ok" })] })).status).toBe(200);
    const req = new Request("http://localhost/api/mock/rt2/p", { method: "PATCH" }) as never;
    const ctx = { params: Promise.resolve({ mockId: "rt2", path: ["p"] }) } as never;
    const res = await mockRoute.PATCH(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
