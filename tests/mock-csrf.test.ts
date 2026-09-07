// @vitest-environment node
/**
 * The guard has to refuse another site while letting through the app itself —
 * at whatever address the user typed. Next builds req.url from the hostname
 * the server was started on, so comparing against that refused every address
 * bar except localhost.
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";

const post = (headers: Record<string, string>) =>
  configure(new Request("http://localhost:3000/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ mockId: "csrf", routes: [] }),
  }) as never);

const ok = async (h: Record<string, string>) => (await post(h)).status === 200;

describe("the app itself may publish, from any address bar", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "192.0.2.2:3000", "my-laptop.local:3000"]) {
    test(host, async () =>
      expect(await ok({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin" })).toBe(true));
  }
  test("a native caller, which sends neither header", async () =>
    expect(await ok({ host: "localhost:3000" })).toBe(true));
});

describe("another site may not", () => {
  test("an origin that does not match the host", async () =>
    expect(await ok({ host: "localhost:3000", origin: "https://evil.example.com" })).toBe(false));
  test("a host-shaped lookalike", async () =>
    expect(await ok({ host: "localhost:3000", origin: "http://localhost.evil.com" })).toBe(false));
  test("the same name on another port", async () =>
    expect(await ok({ host: "localhost:3000", origin: "http://localhost:9999" })).toBe(false));
  test("a cross-site fetch that sends no Origin but says so", async () =>
    expect(await ok({ host: "localhost:3000", "sec-fetch-site": "cross-site" })).toBe(false));
  test("a form post, which cannot set a JSON content type", async () => {
    const res = await configure(new Request("http://localhost:3000/api/mock-config", {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ mockId: "csrf", routes: [] }),
    }) as never);
    expect(res.status).toBe(400);
  });
});
