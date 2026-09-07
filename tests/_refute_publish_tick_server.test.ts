// @vitest-environment node
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

describe("what the real handlers hold after a publish", () => {
  test("no re-publish means the old body still answers and the new path 404s", async () => {
    const r = await post({
      mockId: "tick1",
      routes: [{ id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "first" }],
    });
    expect(r.status).toBe(200);

    // The user now edits body -> "second" and path -> "/moved" in the panel,
    // but never presses Publish again: nothing reaches the handler.
    const old = await hit("tick1", ["z"]);
    expect(old.status).toBe(200);
    expect(await old.text()).toBe("first");

    const moved = await hit("tick1", ["moved"]);
    expect(moved.status).toBe(404);

    // And one more publish does make it live -- nothing is wedged.
    await post({
      mockId: "tick1",
      routes: [{ id: "1", method: "GET", path: "/moved", status: 200, headers: {}, body: "second" }],
    });
    const after = await hit("tick1", ["moved"]);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe("second");
  });
});
