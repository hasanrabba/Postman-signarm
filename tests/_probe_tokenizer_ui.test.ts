/**
 * The UI path for cURL import: the "Import cURL" button in RequestBuilder.
 * No JSX here on purpose — the probe file has to keep a .test.ts extension.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    collections: {}, collectionOrder: [], environments: {}, globals: [],
    history: [], mocks: {}, tabs: [], activeTabId: undefined,
    activeEnvId: undefined, commandPaletteOpen: false,
  });
});

async function openBodyTab() {
  render(createElement(Home));
  await waitFor(() => expect(screen.getByDisplayValue(/my first request/i)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "body" }));
  return screen.getByRole("button", { name: /import curl/i });
}

/** Click Import cURL with `text` in the prompt; report what the user sees. */
async function importViaUi(text: string) {
  const btn = await openBodyTab();
  const alerts: string[] = [];
  window.prompt = () => text;
  window.alert = (m?: unknown) => { alerts.push(String(m)); };
  let thrown: unknown = null;
  try {
    fireEvent.click(btn);
  } catch (e) {
    thrown = e;
  }
  return { alerts, thrown, urlField: (screen.getByPlaceholderText(/https?:/i) as HTMLInputElement).value };
}

describe("Import cURL button", () => {
  test("a truncated command shows an error instead of doing nothing", async () => {
    const r = await importViaUi("curl http://127.0.0.1:8902/a -H");
    // Neither call site wraps parseCurl in try/catch, so the throw escapes the
    // click handler: no request imported and no message shown.
    expect(
      { threw: r.thrown === null ? "no" : String(r.thrown), alerts: r.alerts },
      "clicking Import cURL must either import or explain itself"
    ).toEqual({ threw: "no", alerts: ["Could not parse cURL"] });
  });

  test("a command copied with its shell prompt imports", async () => {
    const r = await importViaUi("$ curl http://127.0.0.1:8902/a");
    expect({ url: r.urlField, alerts: r.alerts }).toEqual({
      url: "http://127.0.0.1:8902/a", alerts: [],
    });
  });

  test("a cmd.exe caret continuation does not rewrite the URL to https://^", async () => {
    const r = await importViaUi('curl -X POST ^\n  -H "X-A: 1" ^\n  "http://127.0.0.1:8902/a"');
    expect(r.urlField).toBe("http://127.0.0.1:8902/a");
  });
});

// Keep vitest from complaining about an unused import in some configs.
void vi;
