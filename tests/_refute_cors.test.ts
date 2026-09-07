// @vitest-environment node
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import * as mockRoute from "@/app/api/mock/[mockId]/[[...path]]/route";
import { validateRoutes } from "@/lib/mock";

const post = (body: unknown) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as never);

const call = (method: string, mockId: string, path: string[], headers: Record<string, string> = {}) => {
  const req = new Request(`http://localhost/api/mock/${mockId}/${path.join("/")}`, { method, headers }) as never;
  const ctx = { params: Promise.resolve({ mockId, path }) } as never;
  return (mockRoute as Record<string, (r: never, c: never) => Promise<Response>>)[method](req, ctx);
};

test("REFUTES 'no response carries ACAO' + 'cannot register an OPTIONS route'", async () => {
  const cfg = await post({ mockId: "cors", routes: [
    { id:"1", method:"OPTIONS", path:"/z", status:200, headers:{
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":"content-type,authorization",
        "Access-Control-Max-Age":"600" }, body:"" },
    { id:"2", method:"GET", path:"/z", status:200, headers:{
        "content-type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Expose-Headers":"*" }, body:'{"ok":true}' },
  ]});
  expect(cfg.status).toBe(200);                                   // OPTIONS route publishes

  // The exact preflight the finder issued, against a mock that declares one:
  const pre = await call("OPTIONS", "cors", ["z"], {
    origin: "http://localhost:5173", "access-control-request-method": "GET" });
  expect(pre.status).toBe(200);                                   // not 404
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
  expect(pre.headers.get("access-control-max-age")).toBe("600");

  // The exact GET the finder issued:
  const g = await call("GET", "cors", ["z"], { origin: "http://localhost:5173" });
  expect(g.headers.get("access-control-allow-origin")).toBe("*"); // finder said "grep found none"
  expect(await g.text()).toBe('{"ok":true}');
});

test("the matcher matching on method is WHAT MAKES an OPTIONS route work, not what blocks it", () => {
  const v = validateRoutes([{ id:"1", method:"OPTIONS", path:"/z", status:200,
    headers:{ "Access-Control-Allow-Origin":"*" }, body:"" }]);
  expect(v.ok).toBe(true);
});

test("HEAD too — the 'missing' methods are all served by the same matcher", async () => {
  await post({ mockId: "hd", routes: [
    { id:"1", method:"HEAD", path:"/z", status:200, headers:{ "Access-Control-Allow-Origin":"*" }, body:"" }]});
  const r = await call("HEAD", "hd", ["z"]);
  expect(r.status).toBe(200);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
});

test("REFUTES 'a web page cannot call the mock at all': same-origin pages need no CORS", async () => {
  await post({ mockId: "so", routes: [
    { id:"1", method:"GET", path:"/z", status:200, headers:{"content-type":"application/json"}, body:'{"a":1}' }]});
  // The app itself is served from the same origin as /api/mock/*, so its own
  // pages (and any page on that origin) read this response with no CORS at all.
  const r = await call("GET", "so", ["z"], { origin: "http://localhost" });
  expect(r.status).toBe(200);
  expect(await r.text()).toBe('{"a":1}');
});
