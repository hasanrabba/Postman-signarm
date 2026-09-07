// @vitest-environment node
/**
 * Which route answers, and when. An exact match always wins; the relaxations
 * below only ever turn a 404 into an answer.
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import * as mock from "@/app/api/mock/[mockId]/[[...path]]/route";

const publish = (mockId: string, routes: unknown[]) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mockId, routes }),
  }) as never);
const route = (over: Record<string, unknown> = {}) =>
  ({ id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "HIT", ...over });

/** Next hands the handler the DECODED path segments. */
async function hit(mockId: string, segs: string[], method = "GET") {
  const fn = (mock as unknown as Record<string, (rq: unknown, c: unknown) => Promise<Response>>)[method];
  const res = await fn(
    new Request(`http://localhost/api/mock/${mockId}/${segs.join("/")}`, { method }) as never,
    { params: Promise.resolve({ mockId, path: segs }) } as never
  );
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("a trailing slash is not worth a 404", () => {
  test("/z/ finds the route registered as /z", async () => {
    await publish("t1", [route()]);
    expect(await hit("t1", ["z", ""])).toMatchObject({ status: 200, body: "HIT" });
  });
  test("/z finds the route registered as /z/", async () => {
    await publish("t2", [route({ path: "/z/" })]);
    expect(await hit("t2", ["z"])).toMatchObject({ status: 200, body: "HIT" });
  });
  test("an exact match still wins over the relaxed one", async () => {
    await publish("t3", [route({ path: "/z/", body: "SLASH" }), route({ path: "/z", body: "EXACT" })]);
    expect((await hit("t3", ["z"])).body).toBe("EXACT");
  });
  test("the root route is untouched by the trimming", async () => {
    await publish("t4", [route({ path: "/", body: "ROOT" })]);
    expect((await hit("t4", [])).body).toBe("ROOT");
    expect((await hit("t4", [""])).body).toBe("ROOT");
  });
});

/* HTTP says HEAD is answerable wherever GET is — a health check against a
   mocked GET used to come back 404. */
describe("HEAD stands in for GET", () => {
  test("it answers with the GET route's status and headers", async () => {
    await publish("h1", [route({ headers: { "X-Total": "42" } })]);
    const res = await hit("h1", ["z"], "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total")).toBe("42");
  });
  test("and with no body", async () => {
    await publish("h2", [route()]);
    expect((await hit("h2", ["z"], "HEAD")).body).toBe("");
  });
  test("a route registered FOR head still wins", async () => {
    await publish("h3", [route({ method: "HEAD", status: 204 }), route({ status: 200 })]);
    expect((await hit("h3", ["z"], "HEAD")).status).toBe(204);
  });
  test("a GET still gets its body (control)", async () => {
    await publish("h4", [route()]);
    expect((await hit("h4", ["z"])).body).toBe("HIT");
  });
});

describe("what stays strict", () => {
  test("a path's case still matters, as it does in any URL", async () => {
    await publish("s1", [route()]);
    expect((await hit("s1", ["Z"])).status).toBe(404);
  });
  test("a different path is still a 404", async () => {
    await publish("s2", [route()]);
    expect((await hit("s2", ["nope"])).status).toBe(404);
  });
  test("a POST does not answer from a GET route", async () => {
    await publish("s3", [route()]);
    expect((await hit("s3", ["z"], "POST")).status).toBe(404);
  });
  test("the first of two identical routes wins, predictably", async () => {
    await publish("s4", [route({ body: "FIRST" }), route({ body: "SECOND" })]);
    expect((await hit("s4", ["z"])).body).toBe("FIRST");
  });
});
