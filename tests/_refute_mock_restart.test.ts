// @vitest-environment node
/**
 * Refutation attempt: "after restarting the dev server every mock URL 404s,
 * and the 404 is indistinguishable from a mistyped path."
 *
 * Driven through the real handlers. A process restart is modelled by emptying
 * the shared registry object the two route modules captured at import time —
 * a fresh process has no globalThis.__signalMocks at all, and nothing on the
 * server ever repopulates it except POST /api/mock-config.
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

const hit = (mockId: string, path: string[]) =>
  serve(new Request(`http://localhost/api/mock/${mockId}/${path.join("/")}`) as never,
        { params: Promise.resolve({ mockId, path }) } as never);

const zRoute = {
  id: "r1", method: "GET", path: "/z", status: 200,
  headers: { "content-type": "text/plain" }, body: "z-body",
};

/** Empty the process-wide registry, as a server restart does. */
function restartServer() {
  const reg = (globalThis as { __signalMocks?: Record<string, unknown> }).__signalMocks;
  if (reg) for (const k of Object.keys(reg)) delete reg[k];
}

describe("mock registry across a server restart", () => {
  test("a published route serves, then 404s after the process restarts", async () => {
    expect((await post({ mockId: "m1", routes: [zRoute] })).status).toBe(200);
    const before = await hit("m1", ["z"]);
    expect(before.status).toBe(200);
    expect(await before.text()).toBe("z-body");

    restartServer();

    const after = await hit("m1", ["z"]);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({
      error: "No matching mock route", method: "GET", path: "/z", mockId: "m1",
    });
  });

  test("nothing on the server re-registers routes on its own", async () => {
    await post({ mockId: "m2", routes: [zRoute] });
    restartServer();
    // Several requests, in case something lazily rehydrates. Nothing does.
    for (let i = 0; i < 3; i++) expect((await hit("m2", ["z"])).status).toBe(404);
    const reg = (globalThis as { __signalMocks?: Record<string, unknown> }).__signalMocks;
    expect(Object.keys(reg ?? {})).toEqual([]);
  });

  test("all three failures are byte-identical apart from the mockId echo", async () => {
    // 1. never published in this process (post-restart, or never at all)
    restartServer();
    const neverPublished = await (await hit("m1", ["z"])).text();
    // 2. a mockId that has never existed
    const neverSeen = await (await hit("neverseen", ["z"])).text();
    // 3. published, then emptied
    expect(await (await post({ mockId: "m1", routes: [] })).json())
      .toEqual({ ok: true, count: 0 });
    const emptied = await (await hit("m1", ["z"])).text();
    // 4. a genuinely mistyped path on a live mock
    await post({ mockId: "m1", routes: [zRoute] });
    const mistyped = await (await hit("m1", ["zz"])).text();

    expect(neverPublished).toBe(emptied);
    expect(neverPublished).toBe(neverSeen.replace('"neverseen"', '"m1"'));
    expect(mistyped).toBe(neverPublished.replace('"/z"', '"/zz"'));
    // No field anywhere distinguishes "this mock was never published".
    for (const body of [neverPublished, neverSeen, emptied, mistyped]) {
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(["error", "method", "mockId", "path"]);
    }
  });
});
