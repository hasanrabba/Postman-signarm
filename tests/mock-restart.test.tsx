/**
 * Mocks are persisted, but the server that answers them is not: the registry
 * is in memory. Nothing re-registered on load, so after a restart the sidebar
 * listed a mock and all its routes while every request to it 404'd — and the
 * UI looked exactly like a working one.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const registerMock = vi.fn(async (_id: string, _routes: unknown[]) => ({ ok: true, count: 1 }));
vi.mock("@/lib/transport", () => ({
  registerMock: (id: string, routes: unknown[]) => registerMock(id, routes),
  mockUrlFor: vi.fn(async (id: string) => `http://localhost:3000/api/mock/${id}`),
  sendProxy: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 })),
  mockBaseUrl: vi.fn(async () => "http://localhost:3000"),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); registerMock.mockClear(); cleanup(); });
afterEach(() => vi.unstubAllGlobals());

describe("a mock survives a restart", () => {
  test("routes the app remembers are re-registered when it loads", async () => {
    const id = useStore.getState().createMock("Billing API");
    useStore.getState().updateMock(id, {
      routes: [{ id: "r1", method: "GET", path: "/z", status: 200, headers: {}, body: "hi" }],
    });

    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });

    await waitFor(() => expect(registerMock).toHaveBeenCalled(), { timeout: 5000 });
    const [calledId, routes] = registerMock.mock.calls[0];
    expect(calledId).toBe(id);
    expect(routes).toHaveLength(1);
  }, 30_000);

  test("every remembered mock is re-registered, not just the first", async () => {
    const a = useStore.getState().createMock("A");
    const b = useStore.getState().createMock("B");
    useStore.getState().updateMock(a, { routes: [{ id: "1", method: "GET", path: "/a", status: 200, headers: {}, body: "" }] });
    useStore.getState().updateMock(b, { routes: [{ id: "2", method: "GET", path: "/b", status: 200, headers: {}, body: "" }] });

    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(registerMock.mock.calls.map((c) => c[0]).sort())
      .toEqual([a, b].sort());
  }, 30_000);

  test("a mock with no routes is left alone", async () => {
    useStore.getState().createMock("Empty");
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    await new Promise((r) => setTimeout(r, 300));
    expect(registerMock).not.toHaveBeenCalled();
  }, 30_000);
});
