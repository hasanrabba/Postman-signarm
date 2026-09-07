/**
 * A request lives in two places at once: in its collection, and as the draft
 * of any tab it is open in. Renaming it in the sidebar changed only the first,
 * and saving writes the draft over the stored request wholesale — so the
 * rename came back off.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 0 })),
  mockUrlFor: vi.fn(async () => undefined),
  sendProxy: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); cleanup(); });

/** a collection with one request, open in a tab */
function seed() {
  const cid = useStore.getState().createCollection("C");
  const root = useStore.getState().collections[cid].rootFolderId;
  const rid = useStore.getState().addRequest(cid, root, { name: "Old Name", url: "https://x.test/v1" });
  useStore.getState().openRequest(cid, rid);
  return { cid, rid };
}
const stored = (cid: string, rid: string) => useStore.getState().collections[cid].requests[rid];

describe("renaming a request keeps the open tab in step", () => {
  test("the tab's draft takes the new name", () => {
    const { cid, rid } = seed();
    useStore.getState().renameRequest(cid, rid, "New Name");
    expect(useStore.getState().tabs[0].draft.name).toBe("New Name");
  });

  test("saving afterwards does not put the old name back", () => {
    const { cid, rid } = seed();
    useStore.getState().renameRequest(cid, rid, "New Name");
    useStore.getState().saveTabInPlace(useStore.getState().tabs[0].id);
    expect(stored(cid, rid).name).toBe("New Name");
  });

  test("an edit made after the rename keeps both", () => {
    const { cid, rid } = seed();
    useStore.getState().renameRequest(cid, rid, "New Name");
    const tabId = useStore.getState().tabs[0].id;
    useStore.getState().updateDraft(tabId, { url: "https://x.test/v2" });
    useStore.getState().saveTabInPlace(tabId);
    expect(stored(cid, rid)).toMatchObject({ name: "New Name", url: "https://x.test/v2" });
  });

  test("a request open in two tabs has both updated", () => {
    const { cid, rid } = seed();
    // a second, independent draft of the same request
    useStore.getState().openDraft(stored(cid, rid));
    useStore.getState().renameRequest(cid, rid, "New Name");
    const drafts = useStore.getState().tabs.filter((t) => t.draft.id === rid).map((t) => t.draft.name);
    expect(drafts.every((n) => n === "New Name")).toBe(true);
  });

  test("a tab holding a different request is untouched", () => {
    const { cid, rid } = seed();
    const root = useStore.getState().collections[cid].rootFolderId;
    const other = useStore.getState().addRequest(cid, root, { name: "Other", url: "https://y.test/" });
    useStore.getState().openRequest(cid, other);
    useStore.getState().renameRequest(cid, rid, "New Name");
    expect(stored(cid, other).name).toBe("Other");
    expect(useStore.getState().tabs.find((t) => t.draft.id === other)!.draft.name).toBe("Other");
  });

  test("renaming does not mark the tab dirty — nothing the user edited changed", () => {
    const { cid, rid } = seed();
    const before = useStore.getState().tabs[0].dirty;
    useStore.getState().renameRequest(cid, rid, "New Name");
    expect(useStore.getState().tabs[0].dirty).toBe(before);
  });
});

/* The visible warning sign of the two above. */
describe("the rename shows up where the user is looking", () => {
  test("the tab strip and the name field follow the sidebar", async () => {
    const user = userEvent.setup();
    const { cid, rid } = seed();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    expect(screen.getAllByText("Old Name").length).toBeGreaterThan(0);

    useStore.getState().renameRequest(cid, rid, "New Name");

    await waitFor(() => expect(screen.queryAllByText("Old Name")).toHaveLength(0));
    expect(screen.getAllByText("New Name").length).toBeGreaterThan(0);
    expect(user).toBeDefined();
  }, 30_000);
});
