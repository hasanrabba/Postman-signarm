/**
 * The UI half of the restart claim: after a reload from persisted state the
 * mocks panel still lists the server, its routes and its URL, and the app
 * never re-publishes on its own.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const calls = vi.hoisted(() => [] as { mockId: string; routes: unknown[] }[]);
vi.mock("@/lib/transport", () => ({
  sendProxy: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 }),
  mockBaseUrl: async () => "http://localhost",
  registerMock: async (mockId: string, routes: unknown[]) => {
    calls.push({ mockId, routes });
    return { ok: true, count: routes.length };
  },
}));

const SEED = JSON.stringify({
  state: {
    collections: {}, collectionOrder: [], environments: {}, globals: [], history: [],
    mocks: { m1: { id: "m1", name: "my-mock", routes: [
      { id: "r1", method: "GET", path: "/z", status: 200, headers: {}, body: "z-body" },
    ] } },
    activeEnvId: undefined,
  },
  version: 0,
});

beforeEach(async () => {
  cleanup();
  calls.length = 0;
  localStorage.clear();
  // Reset the heap the way a restart does, THEN put back what disk still
  // holds (setState itself re-writes the snapshot, so order matters).
  useStore.setState({
    collections: {}, collectionOrder: [], environments: {}, globals: [],
    history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  });
  localStorage.setItem("signal.state.v1", SEED);
  await useStore.persist.rehydrate();
});

describe("what the UI shows after a restart", () => {
  test("the mock, its URL and its routes are all still listed, and nothing re-publishes", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => expect(useStore.getState().mocks.m1).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /^Mocks$/i }));

    // The server is listed with its name...
    await waitFor(() => expect(screen.getByDisplayValue("my-mock")).toBeInTheDocument());
    // ...and the URL the user is told to call.
    expect(screen.getByText(/\/api\/mock\/m1\//)).toBeInTheDocument();

    // Expand: the routes are listed exactly as before the restart.
    await user.click(screen.getByText("▸"));
    expect(screen.getByDisplayValue("/z")).toBeInTheDocument();
    expect(screen.getByDisplayValue("z-body")).toBeInTheDocument();

    // The app never called registerMock on its own.
    expect(calls).toEqual([]);

    // Nothing in the panel says the routes are unpublished / stale.
    const panel = screen.getByDisplayValue("my-mock").closest("div")!.parentElement!;
    expect(panel.textContent).not.toMatch(/unpublish|not published|publish again|stale|restart/i);
    // The Publish button reads exactly "Publish" — no warning state.
    expect(screen.getByRole("button", { name: /Publish/ }).textContent).toBe("Publish");
  });
});
