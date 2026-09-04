// @vitest-environment node
import { test, expect, vi, beforeEach, describe } from "vitest";
import { POST } from "@/app/api/proxy/route";

// Public IP literals skip DNS in checkTarget, so these tests need no resolver.
const PUB = "http://93.184.216.34";
const PUB2 = "http://23.215.0.136";

function req(body: unknown) {
  return new Request("http://proxy.test/api/proxy", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}
const calls: { url: string; headers: Record<string, string>; method: string }[] = [];
function mockFetch(steps: (() => Response)[]) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => {
    calls.push({ url: String(u), headers: (init.headers ?? {}) as Record<string,string>, method: String(init.method) });
    return steps[Math.min(i++, steps.length - 1)]();
  }));
}
const redirect = (to: string, status = 302) =>
  () => new Response(null, { status, headers: { location: to } });
const ok = (body = "fine", headers: Record<string,string> = {}) =>
  () => new Response(body, { status: 200, headers: { "content-type": "text/plain", ...headers } });

beforeEach(() => { calls.length = 0; vi.unstubAllGlobals(); });

describe("redirects are re-validated on every hop", () => {
  test("X1: a redirect to loopback is refused", async () => {
    mockFetch([redirect("http://127.0.0.1:8080/admin"), ok()]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X1:", r.status, "|", r.error);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/refused/i);
    expect(calls).toHaveLength(1);   // never fetched the loopback URL
  });

  test("X2: a redirect to link-local metadata is refused", async () => {
    mockFetch([redirect("http://169.254.169.254/latest/meta-data/"), ok()]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X2:", r.status, "|", r.error);
    expect(r.status).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("X3: a relative redirect that lands on the same public host is followed", async () => {
    mockFetch([redirect("/next"), ok("arrived")]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X3:", r.status, r.body, "| hops:", calls.length);
    expect(r.status).toBe(200);
    expect(r.body).toBe("arrived");
  });

  test("X4: a redirect chain longer than the cap is stopped", async () => {
    mockFetch([redirect(PUB + "/loop")]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X4:", r.status, "|", r.error, "| hops:", calls.length);
    expect(r.error).toMatch(/too many redirects/i);
    expect(calls.length).toBeLessThanOrEqual(11);
  });
});

describe("credentials do not leak across a redirect", () => {
  test("X5: Authorization is dropped when the origin changes", async () => {
    mockFetch([redirect(PUB2 + "/elsewhere"), ok()]);
    await POST(req({ method: "GET", url: PUB + "/", headers: { Authorization: "Bearer SECRET", "X-Keep": "yes" } }));
    console.log("  X5 hop1:", JSON.stringify(calls[0].headers));
    console.log("  X5 hop2:", JSON.stringify(calls[1].headers));
    expect(JSON.stringify(calls[1].headers)).not.toContain("SECRET");
    expect(JSON.stringify(calls[1].headers)).toContain("X-Keep");
  });

  test("X6: Authorization survives a same-origin redirect", async () => {
    mockFetch([redirect(PUB + "/same"), ok()]);
    await POST(req({ method: "GET", url: PUB + "/", headers: { Authorization: "Bearer SECRET" } }));
    console.log("  X6 hop2:", JSON.stringify(calls[1].headers));
    expect(JSON.stringify(calls[1].headers)).toContain("SECRET");
  });
});

describe("response size ceiling", () => {
  test("X7: a body past the cap is refused even with no content-length", async () => {
    const huge = "x".repeat(33 * 1024 * 1024);
    mockFetch([ok(huge)]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X7:", r.status, "|", r.error);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/limit/i);
  }, 60_000);

  test("X8: a lying content-length does not get past the stream counter", async () => {
    const huge = "y".repeat(33 * 1024 * 1024);
    mockFetch([ok(huge, { "content-length": "10" })]);
    const r = await (await POST(req({ method: "GET", url: PUB + "/" }))).json();
    console.log("  X8:", r.status, "|", r.error);
    expect(r.status).toBe(0);
  }, 60_000);
});

describe("method degradation", () => {
  test("X9: a 303 turns a POST into a GET with no body", async () => {
    mockFetch([redirect(PUB + "/after", 303), ok()]);
    await POST(req({ method: "POST", url: PUB + "/", body: "a=1" }));
    console.log("  X9 methods:", calls.map(c => c.method).join(" -> "));
    expect(calls[1].method).toBe("GET");
  });
});
