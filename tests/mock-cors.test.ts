// @vitest-environment node
/**
 * A mock server exists to be pointed at from somewhere else — usually a web app
 * on another port. Without CORS the mock answered 200 and the calling app saw
 * a CORS error; a preflight 404'd, so anything with a JSON content type or a
 * custom header could not reach it at all.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import * as mock from "@/app/api/mock/[mockId]/[[...path]]/route";

const ORIGIN = "http://localhost:5173";
const publish = (mockId: string, routes: unknown[]) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mockId, routes }),
  }) as never);

const route = (over: Record<string, unknown> = {}) =>
  ({ id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "hi", ...over });

const ctx = (mockId: string, path: string[]) => ({ params: Promise.resolve({ mockId, path }) }) as never;
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/mock/c/z", { method, headers }) as never;

beforeEach(async () => { await publish("c", [route()]); });

describe("a browser app can call a mock", () => {
  test("the response says which origin may read it", async () => {
    const res = await mock.GET(req("GET", { origin: ORIGIN }), ctx("c", ["z"]));
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(await res.text()).toBe("hi");
  });

  test("custom response headers are readable by the caller", async () => {
    await publish("c", [route({ headers: { "X-Total": "42" } })]);
    const res = await mock.GET(req("GET", { origin: ORIGIN }), ctx("c", ["z"]));
    expect(res.headers.get("access-control-expose-headers")).toBe("*");
    expect(res.headers.get("x-total")).toBe("42");
  });

  test("a preflight is answered instead of 404ing", async () => {
    const res = await mock.OPTIONS(
      req("OPTIONS", { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }),
      ctx("c", ["z"])
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  test("even a 404 carries the headers, so the app sees the 404 and not a CORS error", async () => {
    const res = await mock.GET(req("GET", { origin: ORIGIN }), ctx("c", ["nope"]));
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("a route the user registered FOR options still wins over the preflight answer", async () => {
    await publish("c", [route({ method: "OPTIONS", body: "mine", status: 200 })]);
    const res = await mock.OPTIONS(
      req("OPTIONS", { origin: ORIGIN, "access-control-request-method": "GET" }),
      ctx("c", ["z"])
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mine");
  });

  test("a CORS header the user set themselves is not overridden", async () => {
    await publish("c", [route({ headers: { "Access-Control-Allow-Origin": "https://only.test" } })]);
    const res = await mock.GET(req("GET", { origin: ORIGIN }), ctx("c", ["z"]));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://only.test");
  });

  test("an OPTIONS that is not a preflight is still a plain 404", async () => {
    const res = await mock.OPTIONS(req("OPTIONS", { origin: ORIGIN }), ctx("c", ["z"]));
    expect(res.status).toBe(404);
  });
});
