// @vitest-environment node
/**
 * Sending a request at a mock you just published came back "Host localhost is
 * blocked by the proxy" — the SSRF guard doing its job on the one address it
 * should not. The allowance is narrow, and these pin how narrow.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { POST as proxy } from "@/app/api/proxy/route";
import { POST as configure } from "@/app/api/mock-config/route";

const rq = (b: unknown, url = "http://localhost:3000/api/proxy") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) as never;

beforeEach(() => { delete process.env.SIGNAL_PROXY_ALLOW_LOCAL; });

async function publish(mockId: string) {
  await configure(new Request("http://localhost:3000/api/mock-config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mockId, routes: [{ id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "hi" }] }),
  }) as never);
}

/** A stand-in for the app's own server, so the whole path can be exercised
 *  rather than only the guard's verdict. */
async function selfServer(): Promise<{ origin: string; close: () => void }> {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hi");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("a published mock can be called from the app", () => {
  test("the request reaches the app's own mock dispatcher", async () => {
    await publish("r1");
    const self = await selfServer();
    try {
      const res = await proxy(rq(
        { method: "GET", url: `${self.origin}/api/mock/r1/z`, headers: {} },
        `${self.origin}/api/proxy`
      ));
      const j = await res.json();
      expect(j.error, `proxy refused its own mock: ${j.error}`).toBeUndefined();
      expect(j.status).toBe(200);
      expect(j.body).toBe("hi");
    } finally { self.close(); }
  });

  test("but only under /api/mock/ on that same origin", async () => {
    const self = await selfServer();
    try {
      const j = await (await proxy(rq(
        { method: "GET", url: `${self.origin}/something-else`, headers: {} },
        `${self.origin}/api/proxy`
      ))).json();
      expect(j.error).toMatch(/blocked by the proxy/);
    } finally { self.close(); }
  });
});

describe("the allowance stays narrow", () => {
  test("another path on the same origin is still blocked", async () => {
    const j = await (await proxy(rq({ method: "GET", url: "http://localhost:3000/api/proxy", headers: {} }))).json();
    expect(j.error).toMatch(/blocked by the proxy/);
  });

  test("a mock path on a DIFFERENT loopback port is still blocked", async () => {
    const j = await (await proxy(rq({ method: "GET", url: "http://localhost:9999/api/mock/r1/z", headers: {} }))).json();
    expect(j.error).toMatch(/blocked by the proxy/);
  });

  test("a mock path on another host is still blocked", async () => {
    const j = await (await proxy(rq({ method: "GET", url: "http://127.0.0.1:3000/api/mock/r1/z", headers: {} }))).json();
    expect(j.error).toMatch(/blocked by the proxy/);
  });

  test("a path that only looks like the dispatcher is still blocked", async () => {
    const j = await (await proxy(rq({ method: "GET", url: "http://localhost:3000/api/mockery/x", headers: {} }))).json();
    expect(j.error).toMatch(/blocked by the proxy/);
  });
});
