// @vitest-environment node
/**
 * REFUTATION of "a path the URL layer rewrites is published and then 404s for ever".
 *
 * The matcher compares the stored path to "/" + DECODED segments joined. That is
 * exactly why these routes are reachable: the request whose encoded form decodes
 * to the stored string matches it. Segment arrays below are the ones a live
 * `next dev` 16.3.4 on port 3591 actually handed the handler (curl transcript in
 * the report: each of these returned 200 and the route's own body).
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import * as mockRoute from "@/app/api/mock/[mockId]/[[...path]]/route";

const post = (body: unknown) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never);

const call = (mockId: string, path: string[]) => {
  const req = new Request(`http://localhost/api/mock/${mockId}/x`, { method: "GET" }) as never;
  const ctx = { params: Promise.resolve({ mockId, path }) } as never;
  return mockRoute.GET(req, ctx);
};

const route = (over: Record<string, unknown> = {}) => ({
  id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x", ...over,
});

describe("routes the finder called dead for ever are reachable", () => {
  test('"/q?x=1" answers at GET /api/mock/r1/q%3Fx=1', async () => {
    expect((await post({ mockId: "r1", routes: [route({ path: "/q?x=1", body: "QUERY-ROUTE" })] })).status).toBe(200);
    const r = await call("r1", ["q?x=1"]); // what Next hands over for /q%3Fx=1
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("QUERY-ROUTE");
  });

  test('"/a%20b" answers at GET /api/mock/r2/a%2520b', async () => {
    expect((await post({ mockId: "r2", routes: [route({ path: "/a%20b", body: "ENCODED-ROUTE" })] })).status).toBe(200);
    const r = await call("r2", ["a%20b"]); // what Next hands over for /a%2520b
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ENCODED-ROUTE");
  });

  test('"//z" answers at GET /api/mock/r3/%2Fz', async () => {
    expect((await post({ mockId: "r3", routes: [route({ path: "//z", body: "DOUBLESLASH-ROUTE" })] })).status).toBe(200);
    const r = await call("r3", ["/z"]); // what Next hands over for /%2Fz
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("DOUBLESLASH-ROUTE");
  });

  test('"/users/:id" answers at GET /api/mock/r4/users/:id', async () => {
    expect((await post({ mockId: "r4", routes: [route({ path: "/users/:id", body: "PATHVAR-ROUTE" })] })).status).toBe(200);
    const r = await call("r4", ["users", ":id"]);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("PATHVAR-ROUTE");
  });
});
