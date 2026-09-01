import { describe, expect, test, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    collections: {},
    collectionOrder: [],
    environments: {},
    globals: [],
    history: [],
    mocks: {},
    tabs: [],
    activeTabId: undefined,
    activeEnvId: undefined,
    commandPaletteOpen: false,
  });
});

describe("rename — collections", () => {
  test("double-clicking a collection name switches to an input and Enter commits", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("Original");

    // Wait for the new collection row to render.
    const heading = await screen.findByText("Original");
    await user.dblClick(heading);

    const input = await screen.findByRole("textbox", { name: /rename collection original/i });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useStore.getState().collections[cid].name).toBe("Renamed")
    );
  });

  test("store-level renameCollection produces the expected state", () => {
    const cid = useStore.getState().createCollection("ByApi");
    useStore.getState().renameCollection(cid, "After");
    expect(useStore.getState().collections[cid].name).toBe("After");
  });

  test("always-visible \u270e button starts inline editing", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("Before");
    // There are two buttons with "Rename collection Before" aria-label
    // (the pencil button and the name span's aria-label). Find the button.
    const buttons = await screen.findAllByRole("button", {
      name: /rename collection before/i,
    });
    await user.click(buttons[0]);
    const input = await screen.findByRole("textbox", { name: /rename collection before/i });
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(useStore.getState().collections[cid].name).toBe("After")
    );
  });

  test("always-visible \u2715 button opens confirm and deletes on OK", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("DoomMe");
    await user.click(
      await screen.findByRole("button", { name: /delete collection doomme/i })
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/delete collection/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(useStore.getState().collections[cid]).toBeUndefined()
    );
  });

  test("\u2715 button + Cancel keeps the collection", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("KeepMe");
    await user.click(
      await screen.findByRole("button", { name: /delete collection keepme/i })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(useStore.getState().collections[cid]).toBeDefined();
  });

  test("Escape cancels an in-progress rename", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("KeepMe");
    const heading = await screen.findByText("KeepMe");
    await user.dblClick(heading);

    const input = await screen.findByRole("textbox", { name: /rename collection keepme/i });
    fireEvent.change(input, { target: { value: "Dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useStore.getState().collections[cid].name).toBe("KeepMe");
  });

  test("empty rename is discarded", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("NonEmpty");
    const heading = await screen.findByText("NonEmpty");
    await user.dblClick(heading);

    const input = await screen.findByRole("textbox", { name: /rename collection nonempty/i });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useStore.getState().collections[cid].name).toBe("NonEmpty");
  });
});

describe("rename — folders", () => {
  test("double-click to rename a nested folder", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("Parent");
    const rootId = useStore.getState().collections[cid].rootFolderId;
    const fid = useStore.getState().addFolder(cid, rootId, "Auth");

    const label = await screen.findByText("Auth");
    await user.dblClick(label);

    const input = await screen.findByRole("textbox", { name: /rename folder auth/i });
    fireEvent.change(input, { target: { value: "Users" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useStore.getState().collections[cid].folders[fid].name).toBe("Users")
    );
  });
});

describe("folders — create and delete", () => {
  test("+fld on a nested folder adds a subfolder (named via inline rename)", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    const cid = useStore.getState().createCollection("P");
    const rootId = useStore.getState().collections[cid].rootFolderId;
    const fid = useStore.getState().addFolder(cid, rootId, "shallow");

    // Click the "+fld" button inside the "shallow" folder row.
    const folderRow = (await screen.findByText("shallow")).closest("div")!;
    await user.click(within(folderRow).getByRole("button", { name: /add subfolder/i }));

    const folders = useStore.getState().collections[cid].folders;
    const parent = folders[fid];
    expect(parent.folderIds).toHaveLength(1);
    const childId = parent.folderIds[0];
    // The new subfolder is created with a placeholder name the user can
    // rename inline. We only assert that it's non-empty and nested.
    expect(folders[childId].name.length).toBeGreaterThan(0);
  });

  test("delete folder cascades to nested requests and folders", async () => {
    const cid = useStore.getState().createCollection("C");
    const rootId = useStore.getState().collections[cid].rootFolderId;
    const parentId = useStore.getState().addFolder(cid, rootId, "parent");
    const childId = useStore.getState().addFolder(cid, parentId, "child");
    const reqId = useStore.getState().addRequest(cid, childId);

    useStore.getState().deleteFolder(cid, parentId);

    const col = useStore.getState().collections[cid];
    expect(col.folders[parentId]).toBeUndefined();
    expect(col.folders[childId]).toBeUndefined();
    expect(col.requests[reqId]).toBeUndefined();
    expect(col.folders[rootId].folderIds).not.toContain(parentId);
  });

  test("delete refuses to remove a collection's root folder", async () => {
    const cid = useStore.getState().createCollection("Safe");
    const rootId = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().deleteFolder(cid, rootId);
    expect(useStore.getState().collections[cid].folders[rootId]).toBeDefined();
  });
});
