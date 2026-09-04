// @vitest-environment node
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";
import { GET as serve } from "@/app/api/mock/[mockId]/[[...path]]/route";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  configure(new Request("http://localhost/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as never);

const hit = (mockId: string, path: string[]) =>
  serve(new Request(`http://localhost/api/mock/${mockId}/${path.join("/")}`) as never,
        { params: Promise.resolve({ mockId, path }) } as never);

const route = (over: Record<string, unknown> = {}) => ({
  id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x", ...over,
});

describe("mock-config validates what it stores", () => {
  test("an out-of-range status is refused (control — this check exists)", async () => {
    const r = await post({ mockId: "c1", routes: [route({ status: 999 })] });
    expect(r.status).toBe(400);
  });

  test("a delay long enough to pin a connection is refused", async () => {
    const r = await post({ mockId: "c2", routes: [route({ delayMs: 600_000 })] });
    expect(r.status).toBe(400);
  });

  test("a non-string method is refused rather than 500ing on every hit", async () => {
    const r = await post({ mockId: "c3", routes: [route({ method: null })] });
    expect(r.status).toBe(400);
  });

  test("a header value containing CRLF is refused", async () => {
    const r = await post({ mockId: "c4", routes: [route({ headers: { "X-A": "a\r\nX-Injected: yes" } })] });
    expect(r.status).toBe(400);
  });

  test("a valid route is still accepted (control)", async () => {
    const r = await post({ mockId: "c5", routes: [route()] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, count: 1 });
  });
});

describe("mock-config is not writable from another origin", () => {
  test("a cross-origin POST cannot overwrite a user's mock", async () => {
    await post({ mockId: "x1", routes: [route({ body: "mine" })] });
    const attacker = await post(
      { mockId: "x1", routes: [route({ body: "theirs" })] },
      { origin: "https://evil.example.com", "content-type": "text/plain;charset=UTF-8" }
    );
    // Either the write is refused outright...
    if (attacker.status === 200) {
      // ...or, if it is accepted, the user's route has been replaced — which
      // is the defect: one simple no-preflight request rewrites local state.
      const served = await (await hit("x1", ["z"])).text();
      expect(served).toBe("mine");
    }
  });
});

describe("serving a mock", () => {
  test("a registered route is served (control)", async () => {
    await post({ mockId: "s1", routes: [route({ body: "hello" })] });
    const r = await hit("s1", ["z"]);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("hello");
  });

  test("an unregistered path gives a clear 404 (control)", async () => {
    await post({ mockId: "s2", routes: [route()] });
    const r = await hit("s2", ["nope"]);
    expect(r.status).toBe(404);
  });

  test("a reserved mockId is refused (control)", async () => {
    const r = await post({ mockId: "__proto__", routes: [route()] });
    expect(r.status).toBe(400);
  });
});
