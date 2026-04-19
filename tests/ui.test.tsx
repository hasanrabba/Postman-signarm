import { describe, expect, test, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

// Stub window.fetch so the executor's call to /api/proxy resolves without
// real network. Each test installs its own scripted response.
function mockFetchOnce(response: unknown, init: { status?: number } = {}) {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  );
  (globalThis as { fetch: unknown }).fetch = fetchSpy;
  return fetchSpy;
}

beforeEach(() => {
  localStorage.clear();
  // Ensure zustand starts with an empty store for each test.
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

describe("application boot", () => {
  test("renders the workspace after hydration", async () => {
    render(<Home />);
    // Boot shows the hydration placeholder briefly, then the sidebar.
    await waitFor(() => expect(screen.getByText(/signarm/i)).toBeInTheDocument());
    expect(screen.getByText(/collections/i)).toBeInTheDocument();
    expect(screen.getByText(/environments/i)).toBeInTheDocument();
    expect(screen.getByText(/history/i)).toBeInTheDocument();
    expect(screen.getByText(/mocks/i)).toBeInTheDocument();
  });

  test("creates a default tab on first launch", async () => {
    render(<Home />);
    await waitFor(() =>
      expect(screen.getByDisplayValue(/my first request/i)).toBeInTheDocument()
    );
  });
});

describe("request builder layout", () => {
  test("header row renders name, method, URL, Send and Save", async () => {
    render(<Home />);
    await waitFor(() =>
      expect(screen.getByDisplayValue(/my first request/i)).toBeInTheDocument()
    );

    // Name
    expect(screen.getByPlaceholderText(/request name/i)).toBeInTheDocument();
    // Method dropdown
    expect(screen.getByDisplayValue("GET")).toBeInTheDocument();
    // URL
    expect(
      screen.getByPlaceholderText(/api\.example\.com/i)
    ).toBeInTheDocument();
    // Send + Save buttons
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
  });

  test("Send is disabled until a URL is entered", async () => {
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    // The default tab has a URL pre-filled (httpbin), so button is enabled.
    // Clear the URL and verify it disables.
    const url = screen.getByPlaceholderText(/api\.example\.com/i) as HTMLInputElement;
    fireEvent.change(url, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

describe("send request flow", () => {
  test("sending a GET renders the response body", async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world", n: 42 }),
      elapsedMs: 12,
      sizeBytes: 26,
      contentType: "application/json",
    });

    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));

    const url = screen.getByPlaceholderText(/api\.example\.com/i) as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://example.test/ping" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/200 ok/i)).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/proxy",
      expect.objectContaining({ method: "POST" })
    );
    // Response body pretty-printed.
    expect(screen.getByText(/"hello": "world"/)).toBeInTheDocument();
  });

  test("network failure surfaces an error chip", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(screen.getByText(/network error|error/i)).toBeInTheDocument()
    );
  });
});

describe("request tabs", () => {
  test("params tab shows the KV editor", async () => {
    render(<Home />);
    await waitFor(() => screen.getByPlaceholderText(/api\.example\.com/i));
    expect(screen.getByPlaceholderText("param")).toBeInTheDocument();
  });

  test("switching to headers and body renders the right UI", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));

    await user.click(screen.getByRole("button", { name: /^headers$/i }));
    expect(screen.getByPlaceholderText("Header-Name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^body$/i }));
    // Body modes appear as buttons.
    expect(screen.getByRole("button", { name: /json/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /form-urlencoded/i })).toBeInTheDocument();
  });

  test("tests tab has a textarea for assertions", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    await user.click(screen.getByRole("button", { name: /^tests$/i }));
    const textarea = screen.getAllByRole("textbox").find(
      (el) => el.tagName === "TEXTAREA"
    );
    expect(textarea).toBeTruthy();
  });
});

describe("collections", () => {
  test("creates a collection via the sidebar", async () => {
    window.prompt = () => "My API";
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /\+ new collection/i }));
    fireEvent.click(screen.getByRole("button", { name: /\+ new collection/i }));
    await waitFor(() => expect(useStore.getState().collectionOrder).toHaveLength(1));
    expect(useStore.getState().collections[useStore.getState().collectionOrder[0]].name)
      .toBe("My API");
  });
});

describe("environments", () => {
  test("creates an environment and activates it", async () => {
    window.prompt = () => "dev";
    render(<Home />);
    await waitFor(() => screen.getByText(/environments/i));
    fireEvent.click(screen.getByText(/environments/i));
    fireEvent.click(screen.getByText(/\+ new environment/i));
    await waitFor(() =>
      expect(screen.getByDisplayValue("dev")).toBeInTheDocument()
    );
    const envs = useStore.getState().environments;
    expect(Object.values(envs).some((e) => e.name === "dev")).toBe(true);
  });
});

describe("command palette", () => {
  test("opens via palette button and filters commands", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /palette/i }));
    await user.click(screen.getByRole("button", { name: /palette/i }));

    const palette = await screen.findByPlaceholderText(
      /type a command or request/i
    );
    await user.type(palette, "new");
    // Scope queries to the palette's popover so we don't collide with the
    // sidebar's "+ New collection" button.
    const popover = palette.closest("div[class*='rounded']") as HTMLElement;
    const scoped = within(popover);
    expect(scoped.getByText("New request")).toBeInTheDocument();
    expect(scoped.getByText("New collection")).toBeInTheDocument();
  });
});

describe("persistence", () => {
  test("history grows after a send", async () => {
    mockFetchOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "ok",
      elapsedMs: 5,
      sizeBytes: 2,
    });
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(useStore.getState().history.length).toBeGreaterThan(0)
    );
  });
});
