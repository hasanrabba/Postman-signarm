/**
 * Publishing a mock reported failure as a single ✗ and threw away the server's
 * message — which names the route it refused and why. The validation added
 * with it rejects a good deal more than the old code did, so that message is
 * now the difference between a fixable mistake and a mystery.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const registerMock = vi.fn();
vi.mock("@/lib/transport", () => ({
  registerMock: (...a: unknown[]) => registerMock(...a),
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
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); registerMock.mockReset(); cleanup(); });
afterEach(() => vi.unstubAllGlobals());

/** create a mock server, open it, and press Publish */
async function publish() {
  const user = userEvent.setup();
  useStore.getState().createMock("Billing API");
  render(<Home />);
  // the sidebar opens on collections; mocks are their own panel
  await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
  // and each server's editor starts collapsed
  await user.click(await screen.findByText("▸"));
  await user.click(await screen.findByRole("button", { name: /^publish/i }));
  return user;
}

describe("publishing a mock server", () => {
  test("says which route the server refused and why", async () => {
    registerMock.mockResolvedValue({
      ok: false,
      error: 'Route 2 (GET /orders) has an invalid value for "X-A" — a header cannot contain a line break.',
    });
    await publish();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Route 2 \(GET \/orders\)/);
    expect(alert).toHaveTextContent(/cannot contain a line break/);
  }, 30_000);

  test("falls back to something readable when the server gives no reason", async () => {
    registerMock.mockResolvedValue({ ok: false });
    await publish();
    expect(await screen.findByRole("alert")).toHaveTextContent(/refused/i);
  }, 30_000);

  test("says nothing when the publish succeeds", async () => {
    registerMock.mockResolvedValue({ ok: true, count: 0 });
    await publish();
    await waitFor(() => expect(screen.getByRole("button", { name: /publish ✓/i })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  }, 30_000);

  test("a later success clears the earlier failure", async () => {
    registerMock.mockResolvedValue({ ok: false, error: "Route 1 (GET /) has status 999." });
    const user = await publish();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    registerMock.mockResolvedValue({ ok: true, count: 1 });
    await user.click(screen.getByRole("button", { name: /^publish/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }, 30_000);
});

/* A published mock is one the user has to point something at, and nothing
   said where it answers. */
describe("where the mock answers", () => {
  test("the URL is shown after a successful publish", async () => {
    registerMock.mockResolvedValue({ ok: true, count: 1 });
    await publish();
    const id = Object.keys(useStore.getState().mocks)[0];
    expect(await screen.findByText(new RegExp(`/api/mock/${id}$`))).toBeInTheDocument();
  }, 30_000);

  test("and not after a failed one", async () => {
    registerMock.mockResolvedValue({ ok: false, error: "nope" });
    await publish();
    expect(screen.queryByText(/Serving at/)).toBeNull();
  }, 30_000);
});

/* The status field clamped on every keystroke: the first digit of "404" was
   clamped up to 200, React rewrote the field with the caret at the end, the
   next digit made "2000" which clamped to 599, and it never recovered. */
describe("typing a status code", () => {
  async function openRoute() {
    const user = userEvent.setup();
    const id = useStore.getState().createMock("M");
    useStore.getState().updateMock(id, {
      routes: [{ id: "r1", method: "GET", path: "/z", status: 200, headers: {}, body: "b" }],
    });
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(await screen.findByText("▸"));
    return { user, id, field: screen.getByLabelText("Response status") as HTMLInputElement };
  }

  for (const code of ["404", "204", "301", "503"]) {
    test(`typing ${code} leaves ${code}`, async () => {
      const { user, id, field } = await openRoute();
      await user.clear(field);
      await user.type(field, code);
      await user.tab();   // commit on leaving the field
      expect(field.value).toBe(code);
      expect(useStore.getState().mocks[id].routes[0].status).toBe(Number(code));
    }, 30_000);
  }

  test("a value out of range is still corrected when you leave the field", async () => {
    const { user, id, field } = await openRoute();
    await user.clear(field);
    await user.type(field, "999");
    await user.tab();
    expect(useStore.getState().mocks[id].routes[0].status).toBe(599);
  }, 30_000);

  test("an emptied field falls back to what was there", async () => {
    const { user, id, field } = await openRoute();
    await user.clear(field);
    await user.tab();
    expect(useStore.getState().mocks[id].routes[0].status).toBe(200);
  }, 30_000);
});

/* The ✓ was component state that only a publish ever set, so it outlived the
   routes it described. */
describe("the publish tick describes what is actually published", () => {
  async function published() {
    const user = userEvent.setup();
    const id = useStore.getState().createMock("M");
    useStore.getState().updateMock(id, {
      routes: [{ id: "r1", method: "GET", path: "/z", status: 200, headers: {}, body: "first" }],
    });
    registerMock.mockResolvedValue({ ok: true, count: 1 });
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(await screen.findByText("▸"));
    await user.click(screen.getByRole("button", { name: /^publish/i }));
    await screen.findByRole("button", { name: /publish ✓/i });
    return user;
  }
  const tick = () => screen.getByRole("button", { name: /^publish/i }).textContent ?? "";

  test("editing a body clears it", async () => {
    const user = await published();
    await user.type(screen.getByPlaceholderText("response body"), "X");
    await waitFor(() => expect(tick()).not.toContain("✓"));
  }, 30_000);

  test("editing a path clears it", async () => {
    const user = await published();
    await user.type(screen.getByPlaceholderText("/path"), "X");
    await waitFor(() => expect(tick()).not.toContain("✓"));
  }, 30_000);

  test("adding a route clears it", async () => {
    const user = await published();
    await user.click(screen.getByRole("button", { name: /\+ Route/i }));
    await waitFor(() => expect(tick()).not.toContain("✓"));
  }, 30_000);

  test("changing the status clears it", async () => {
    const user = await published();
    const field = screen.getByLabelText("Response status");
    await user.clear(field);
    await user.type(field, "404");
    await user.tab();
    await waitFor(() => expect(tick()).not.toContain("✓"));
  }, 30_000);
});

/* The confirm dialog says this cannot be undone, and it could not: only the
   local entry was dropped, so the mock's URL went on serving every route it
   had — with no way left to stop it, because the mock was gone. */
describe("deleting a mock server", () => {
  test("withdraws its routes from the server first", async () => {
    const user = userEvent.setup();
    const id = useStore.getState().createMock("Billing");
    useStore.getState().updateMock(id, {
      routes: [{ id: "r1", method: "GET", path: "/z", status: 200, headers: {}, body: "b" }],
    });
    registerMock.mockResolvedValue({ ok: true, count: 1 });
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await user.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(registerMock).toHaveBeenCalledWith(id, []));
    expect(useStore.getState().mocks[id]).toBeUndefined();
  }, 30_000);

  test("and does nothing at all if the confirm is declined", async () => {
    const user = userEvent.setup();
    const id = useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));

    expect(registerMock).not.toHaveBeenCalled();
    expect(useStore.getState().mocks[id]).toBeDefined();
  }, 30_000);
});
