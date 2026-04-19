import { describe, expect, test, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

function mockOkResponse() {
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
        elapsedMs: 5,
        sizeBytes: 20,
        contentType: "application/json",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

async function remount() {
  cleanup();
  // Simulate a fresh app restart: snapshot localStorage, reset the in-memory
  // store to its initial state (which would re-write an empty snapshot via
  // the persist middleware), then restore the original snapshot and
  // rehydrate — mimicking the JS heap being destroyed while the disk
  // contents persist.
  const snapshot = localStorage.getItem("signal.state.v1");
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
  if (snapshot !== null) localStorage.setItem("signal.state.v1", snapshot);
  await useStore.persist.rehydrate();
  render(<Home />);
}

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

describe("persistence — survives app restart", () => {
  test("Save button auto-creates a collection and stores the request", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));

    const url = screen.getByPlaceholderText(/api\.example\.com/i) as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://example.test/widgets" } });
    fireEvent.change(screen.getByPlaceholderText(/request name/i), {
      target: { value: "List widgets" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const order = useStore.getState().collectionOrder;
      expect(order.length).toBeGreaterThan(0);
    });

    const order = useStore.getState().collectionOrder;
    const col = useStore.getState().collections[order[0]];
    expect(col.name).toBe("My Collection");
    const saved = Object.values(col.requests);
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe("List widgets");
    expect(saved[0].url).toBe("https://example.test/widgets");
  });

  test("collection + request + name survive remount", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));

    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), {
      target: { value: "https://example.test/persist" },
    });
    fireEvent.change(screen.getByPlaceholderText(/request name/i), {
      target: { value: "Persisted request" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(useStore.getState().collectionOrder.length).toBe(1);
    });

    await remount();

    const order = useStore.getState().collectionOrder;
    expect(order.length).toBe(1);
    const col = useStore.getState().collections[order[0]];
    expect(col).toBeTruthy();
    const req = Object.values(col.requests)[0];
    expect(req.name).toBe("Persisted request");
    expect(req.url).toBe("https://example.test/persist");
  });

  test("environments + activeEnvId survive remount", async () => {
    window.prompt = () => "staging";
    render(<Home />);
    await waitFor(() => screen.getByText(/environments/i));

    fireEvent.click(screen.getByText(/environments/i));
    fireEvent.click(screen.getByText(/\+ new environment/i));
    await waitFor(() => screen.getByDisplayValue("staging"));

    const envId = Object.keys(useStore.getState().environments)[0];
    useStore.getState().setActiveEnvironment(envId);
    useStore.getState().updateEnvironment(envId, {
      variables: [{ id: "v1", key: "host", value: "staging.example.com", enabled: true }],
    });

    await remount();

    const envs = useStore.getState().environments;
    const active = useStore.getState().activeEnvId;
    expect(Object.keys(envs).length).toBe(1);
    expect(active).toBeTruthy();
    const env = envs[active!];
    expect(env.name).toBe("staging");
    expect(env.variables[0]).toMatchObject({ key: "host", value: "staging.example.com" });
  });

  test("history entries survive remount", async () => {
    mockOkResponse();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));

    // Send twice so we have two history entries.
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(2));

    await remount();

    expect(useStore.getState().history.length).toBe(2);
  });

  test("global variables survive remount", async () => {
    render(<Home />);
    await waitFor(() => screen.getByText(/environments/i));
    fireEvent.click(screen.getByText(/environments/i));

    useStore.getState().updateGlobals([
      { id: "g1", key: "token", value: "abc123", enabled: true },
    ]);
    expect(useStore.getState().globals).toHaveLength(1);

    await remount();
    expect(useStore.getState().globals).toHaveLength(1);
    expect(useStore.getState().globals[0]).toMatchObject({ key: "token", value: "abc123" });
  });

  test("localStorage actually contains the persisted payload", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), {
      target: { value: "https://example.test/stored" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(useStore.getState().collectionOrder.length).toBe(1));

    const raw = localStorage.getItem("signal.state.v1");
    expect(raw).toBeTruthy();
    const payload = JSON.parse(raw!);
    // Zustand persist wraps with { state, version }
    expect(payload.state).toBeTruthy();
    expect(Object.values(payload.state.collections).length).toBe(1);
  });
});

describe("save — forgiving UX", () => {
  test("Save with existing single collection uses it without prompting", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));

    const cid = useStore.getState().createCollection("Existing API");
    // Sanity: make sure there's only that one.
    expect(useStore.getState().collectionOrder).toEqual([cid]);

    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), {
      target: { value: "https://example.test/single-col" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const col = useStore.getState().collections[cid];
      expect(Object.values(col.requests).length).toBe(1);
    });
  });

  test("Save on a tracked request writes back in place (no new collection)", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));

    // First save creates "My Collection"
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), {
      target: { value: "https://example.test/first" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(useStore.getState().collectionOrder.length).toBe(1));
    const firstCid = useStore.getState().collectionOrder[0];

    // Edit the URL and save again — should update the same request, same collection.
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), {
      target: { value: "https://example.test/edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const col = useStore.getState().collections[firstCid];
      const req = Object.values(col.requests)[0];
      expect(req.url).toBe("https://example.test/edited");
    });
    // Should NOT have created a second collection
    expect(useStore.getState().collectionOrder.length).toBe(1);
  });
});
