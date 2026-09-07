import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [], history: [], mocks: {},
  tabs: [], activeTabId: undefined, activeEnvId: undefined, commandPaletteOpen: false,
  secrets: [], vaultUnlocked: false, vaultError: undefined, runnerCollectionId: undefined,
};

let posts: Array<{ url: string; body: any }>;

beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  cleanup();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify({ ok: true, count: 1 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("independent check of the Publish tick", () => {
  test("one keystroke after publishing: tick, store and a second publish", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: "mocks" }));
    await user.click(screen.getByRole("button", { name: "+ New mock server" }));
    await user.click(screen.getByText("▸"));
    await user.click(screen.getByRole("button", { name: "+ Route" }));

    const path = await screen.findByPlaceholderText("/path");
    await user.clear(path); await user.type(path, "/z");
    const body = screen.getByPlaceholderText("response body");
    await user.clear(body); await user.type(body, "first");
    await user.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Publish ✓/ })).toBeInTheDocument());

    // A single keystroke is enough.
    await user.type(screen.getByPlaceholderText("response body"), "X");
    console.log("BUTTON AFTER 1 KEYSTROKE:", JSON.stringify(
      screen.getByRole("button", { name: /^Publish/ }).textContent));
    console.log("POSTS:", posts.length);

    // The edit is not lost -- the store holds it.
    const server: any = Object.values(useStore.getState().mocks)[0];
    console.log("STORE BODY:", JSON.stringify(server.routes[0].body));

    // And pressing Publish again pushes the new routes.
    await user.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    console.log("SECOND POST ROUTES:", JSON.stringify(posts[1].body.routes));
  });
});
