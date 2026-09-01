import { describe, expect, test, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { parseCurl, toCurl } from "@/lib/curl";
import { generateSnippet } from "@/lib/snippets";
import { emptyRequest } from "@/lib/defaults";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined,
  activeEnvId: undefined, commandPaletteOpen: false,
  secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); cleanup(); });

/* ------------------------------ cURL ------------------------------ */
describe("cURL import", () => {
  test("keeps '=' inside a query value", () => {
    const r = parseCurl("curl 'https://x.example.com/?sig=abc=def&b=1'")!;
    expect(r.params.find((p) => p.key === "sig")!.value).toBe("abc=def");
    expect(r.params.find((p) => p.key === "b")!.value).toBe("1");
  });

  test("keeps '=' inside a urlencoded body value", () => {
    const r = parseCurl("curl -H 'content-type: application/x-www-form-urlencoded' -d 'jwt=a.b=c' https://x.example.com")!;
    expect(r.body.urlencoded!.find((k) => k.key === "jwt")!.value).toBe("a.b=c");
  });

  test("survives a malformed percent-escape instead of throwing", () => {
    const r = parseCurl("curl 'https://x.example.com/?bad=%zz'");
    expect(r).not.toBeNull();
    expect(r!.params[0].value).toBe("%zz");
  });

  test("-u without a password still sends a colon", () => {
    const r = parseCurl("curl -u alice https://x.example.com")!;
    const header = r.headers.find((h) => h.key === "Authorization")!.value;
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("alice:");
  });

  test("-u with a password is unchanged", () => {
    const r = parseCurl("curl -u alice:s3cret https://x.example.com")!;
    const header = r.headers.find((h) => h.key === "Authorization")!.value;
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("alice:s3cret");
  });

  test("still decodes ordinary escapes", () => {
    const r = parseCurl("curl 'https://x.example.com/?q=a%20b'")!;
    expect(r.params[0].value).toBe("a b");
  });
});

describe("cURL export", () => {
  test("escapes a single quote in the URL", () => {
    const cmd = toCurl(emptyRequest({ url: "https://x.example.com/it's" }));
    expect(cmd).toContain("it'\\''s");
    expect(cmd).not.toContain("/it's'");
  });

  test("round-trips a quote-bearing URL back through the parser", () => {
    const url = "https://x.example.com/a'b";
    const cmd = toCurl(emptyRequest({ url }));
    expect(parseCurl(cmd)!.url).toBe(url);
  });
});

/* ---------------------------- snippets ---------------------------- */
describe("snippets carry form-data fields", () => {
  const req = emptyRequest({
    method: "POST", url: "https://x.example.com/upload",
    body: {
      mode: "form-data", raw: "", urlencoded: [],
      formdata: [
        { id: "1", key: "name", value: "alice", enabled: true, type: "text" },
        { id: "2", key: "avatar", value: "", enabled: true, type: "file", fileName: "a.png" },
      ],
      graphql: { query: "", variables: "" },
    },
  });
  for (const lang of ["fetch", "node-fetch", "python-requests", "go", "httpie"] as const) {
    test(`${lang} includes the field value`, () => {
      expect(generateSnippet(req, lang)).toContain("alice");
    });
    test(`${lang} mentions the file field`, () => {
      expect(generateSnippet(req, lang)).toContain("avatar");
    });
  }
  test("non-multipart snippets are unaffected", () => {
    const json = emptyRequest({
      method: "POST", url: "https://x.example.com",
      body: { mode: "json", raw: '{"a":1}', urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    });
    expect(generateSnippet(json, "python-requests")).toContain('data = "{\\"a\\":1}"');
  });
});

/* ------------------------------ store ----------------------------- */
describe("tab reconciliation", () => {
  function seed() {
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const a = s.addRequest(cid, col.rootFolderId, { name: "a" });
    const b = s.addRequest(cid, col.rootFolderId, { name: "b" });
    return { cid, a, b, root: col.rootFolderId };
  }
  const activeResolves = () => {
    const s = useStore.getState();
    return s.activeTabId === undefined || s.tabs.some((t) => t.id === s.activeTabId);
  };

  test("deleting a collection closes its tabs", () => {
    const { cid, a } = seed();
    useStore.getState().openRequest(cid, a);
    useStore.getState().deleteCollection(cid);
    expect(useStore.getState().tabs).toHaveLength(0);
    expect(activeResolves()).toBe(true);
  });

  test("deleting a request leaves the active tab pointing at a real tab", () => {
    const { cid, a, b } = seed();
    useStore.getState().openRequest(cid, a);
    useStore.getState().openRequest(cid, b);
    useStore.getState().deleteRequest(cid, b);
    expect(useStore.getState().tabs).toHaveLength(1);
    expect(activeResolves()).toBe(true);
    expect(useStore.getState().activeTabId).toBe(useStore.getState().tabs[0].id);
  });

  test("deleting a folder leaves the active tab valid", () => {
    const { cid, root } = seed();
    const fid = useStore.getState().addFolder(cid, root, "f");
    const r = useStore.getState().addRequest(cid, fid, { name: "inner" });
    useStore.getState().openRequest(cid, r);
    useStore.getState().deleteFolder(cid, fid);
    expect(activeResolves()).toBe(true);
  });

  test("deleting a collection closes the runner if it was targeting it", () => {
    const { cid } = seed();
    useStore.getState().openRunner(cid);
    useStore.getState().deleteCollection(cid);
    expect(useStore.getState().runnerCollectionId).toBeUndefined();
  });

  test("tabs from other collections are untouched", () => {
    const { cid, a } = seed();
    const other = useStore.getState().createCollection("Other");
    const oc = useStore.getState().collections[other];
    const or = useStore.getState().addRequest(other, oc.rootFolderId, { name: "keep" });
    useStore.getState().openRequest(cid, a);
    useStore.getState().openRequest(other, or);
    useStore.getState().deleteCollection(cid);
    expect(useStore.getState().tabs.map((t) => t.requestId)).toEqual([or]);
    expect(activeResolves()).toBe(true);
  });
});

describe("version history is bounded", () => {
  test("keeps at most 50 snapshots, newest first", () => {
    const cid = useStore.getState().createCollection("C");
    for (let i = 0; i < 60; i++) useStore.getState().commitCollectionVersion(cid, `v${i}`);
    const versions = useStore.getState().collections[cid].versions;
    expect(versions).toHaveLength(50);
    expect(versions[0].message).toBe("v59");
  });
});

/* -------------------------------- UI ------------------------------- */
describe("previously unreachable features", () => {
  async function boot() {
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
  }

  test("a collection can be run from its own row, not just the first one", async () => {
    useStore.getState().createCollection("First");
    const second = useStore.getState().createCollection("Second");
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /run collection Second/i }));
    expect(useStore.getState().runnerCollectionId).toBe(second);
  });

  test("collection variables are editable from the sidebar", async () => {
    const cid = useStore.getState().createCollection("C");
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /collection variables for C/i }));
    const keys = screen.getAllByPlaceholderText("key");
    await userEvent.type(keys[keys.length - 1], "baseUrl");
    await waitFor(() =>
      expect(useStore.getState().collections[cid].variables.some((v) => v.key === "baseUrl")).toBe(true)
    );
  });

  test("a committed version can be reverted from the sidebar", async () => {
    const cid = useStore.getState().createCollection("C");
    const col = useStore.getState().collections[cid];
    useStore.getState().addRequest(cid, col.rootFolderId, { name: "original" });
    useStore.getState().commitCollectionVersion(cid, "snapshot");
    const added = useStore.getState().addRequest(cid, col.rootFolderId, { name: "added-later" });

    await boot();
    await userEvent.click(screen.getByRole("button", { name: /version history for C/i }));
    await userEvent.click(screen.getByRole("button", { name: /^revert$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^revert$/i }));

    await waitFor(() =>
      expect(useStore.getState().collections[cid].requests[added]).toBeUndefined()
    );
  });

  test("Ctrl/Cmd+N opens a new request", async () => {
    await boot();
    const before = useStore.getState().tabs.length;
    await userEvent.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(useStore.getState().tabs.length).toBe(before + 1));
  });
});

describe("destructive actions ask first", () => {
  test("deleting an environment requires confirmation", async () => {
    const eid = useStore.getState().createEnvironment("dev");
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^environments$/i }));
    await userEvent.click(screen.getByRole("button", { name: /delete environment dev/i }));
    // Still present until the dialog is confirmed.
    expect(useStore.getState().environments[eid]).toBeDefined();
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(useStore.getState().environments[eid]).toBeUndefined());
  });
});

/* ------------------- the blank "new" row promotes once ------------------- */
describe("typing into the trailing blank row", () => {
  async function boot() {
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
  }
  /** The request builder uses the same placeholders, so scope to the sidebar. */
  const sidebar = () => within(screen.getByRole("complementary"));

  test("a multi-character global becomes one variable, not one per keystroke", async () => {
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /^environments$/i }));
    const keys = sidebar().getAllByPlaceholderText("key");
    await userEvent.type(keys[keys.length - 1], "baseUrl");
    expect(useStore.getState().globals.map((v) => v.key)).toEqual(["baseUrl"]);
  });

  test("its value field behaves the same way", async () => {
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /^environments$/i }));
    const values = sidebar().getAllByPlaceholderText("value");
    await userEvent.type(values[values.length - 1], "https://api.example.com");
    const g = useStore.getState().globals;
    expect(g).toHaveLength(1);
    expect(g[0].value).toBe("https://api.example.com");
  });

  test("a multi-character header name becomes one header", async () => {
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /^headers$/i }));
    const keys = screen.getAllByPlaceholderText("Header-Name");
    await userEvent.type(keys[keys.length - 1], "X-Trace-Id");
    expect(useStore.getState().tabs[0].draft.headers.map((h) => h.key)).toEqual(["X-Trace-Id"]);
  });

  test("a multi-character query param becomes one param", async () => {
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /^params$/i }));
    const keys = screen.getAllByPlaceholderText("param");
    await userEvent.type(keys[keys.length - 1], "pageSize");
    expect(useStore.getState().tabs[0].draft.params.map((p) => p.key)).toEqual(["pageSize"]);
  });

  test("editing an existing row still edits in place", async () => {
    await boot();
    await userEvent.click(screen.getByRole("button", { name: /^headers$/i }));
    const keys = screen.getAllByPlaceholderText("Header-Name");
    await userEvent.type(keys[keys.length - 1], "Accept");
    const again = screen.getAllByPlaceholderText("Header-Name");
    await userEvent.type(again[0], "-Language");
    expect(useStore.getState().tabs[0].draft.headers.map((h) => h.key)).toEqual(["Accept-Language"]);
  });
});
