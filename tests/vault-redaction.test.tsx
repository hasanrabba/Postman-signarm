/**
 * Vault redaction and secret-edit regression guard.
 *
 * These began as the proof for four defects found by a /qa sweep of 3deef0a,
 * all of them in vault code. They are kept because each one was reachable by
 * an ordinary user and none was covered before:
 *
 *   1. a secret in the URL was masked but never restorable from history
 *   2. Escape cancelled a secret edit only if you typed faster than the
 *      500ms idle write
 *   3. form-data and GraphQL bodies escaped redaction entirely, writing a
 *      resolved secret to localStorage in clear text
 *   4. a failed vault creation reported failure while leaving the vault
 *      showing as unlocked
 *
 * The controls are deliberate: several tests assert a path that already
 * worked, so a future regression in the masking mechanism itself is
 * distinguishable from a regression in mode coverage.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { redactRequest, restoreRedacted } from "@/lib/secrets";
import { emptyRequest } from "@/lib/defaults";
import { parseCurl } from "@/lib/curl";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [], history: [], mocks: {},
  tabs: [], activeTabId: undefined, activeEnvId: undefined, commandPaletteOpen: false,
  secrets: [], vaultUnlocked: false, vaultError: undefined, runnerCollectionId: undefined,
};
beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  useStore.getState().lockVault();
  cleanup();
});

/* ------------------------------------------------------------------ *
 * FINDING 1 — a vault secret used in the URL cannot be restored
 *
 * redactRequest() masks literal secret values across the URL, but
 * restoreRedacted() only puts values back into headers, params, auth and
 * the body. It never touches the URL, so re-opening such a request from
 * history yields a URL with [REDACTED] in the path — unsendable, and
 * unlike a masked header there is no way to recover it.
 * ------------------------------------------------------------------ */
describe("finding 1: a secret in the URL survives redaction but not restore", () => {
  test("unit: a masked URL comes back masked", () => {
    const live = emptyRequest({ url: "https://api.example.com/t/tenant-abc123/charges" });
    const back = restoreRedacted(redactRequest(live, ["tenant-abc123"]), live);
    expect(back.url).toBe(live.url);
  });

  test("end to end: reopening from history gives an unsendable URL", async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("tenantId", "tenant-abc123");

    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "charges", method: "GET", url: "https://api.example.com/t/{{tenantId}}/charges",
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));

    useStore.getState().openFromHistory(useStore.getState().history[0].id);
    expect(useStore.getState().tabs.at(-1)!.draft.url).not.toContain("[REDACTED]");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * FINDING 2 — Escape stops reverting a secret edit after 500ms
 *
 * SecretValueInput writes on a 500ms idle timer as well as on blur. Once
 * that timer has fired the value is committed, so Escape — which the field
 * otherwise treats as cancel — silently keeps the edit. Whether Escape
 * undoes your typing depends on how fast you were.
 * ------------------------------------------------------------------ */
describe("finding 2: Escape only cancels a secret edit if you are quick", () => {
  test("Escape after the idle write has landed does not revert", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("apiKey", "original");
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^vault$/i }));

    const field = await screen.findByLabelText(/value of apiKey/i);
    await userEvent.clear(field);
    await userEvent.type(field, "typo");
    await new Promise((r) => setTimeout(r, 900)); // idle write lands
    await userEvent.keyboard("{Escape}");
    await new Promise((r) => setTimeout(r, 300));

    expect(useStore.getState().secrets[0].value).toBe("original");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * FINDING 3 — a vault secret in a form-data or GraphQL body is written
 *             to localStorage in plaintext
 *
 * redactRequest() rebuilds the body covering `raw` and `urlencoded` only;
 * `formdata` and `graphql` pass through the spread untouched. History is
 * in the persist partialize, so the entry — and the resolved secret inside
 * it — is serialised into signal.state.v1 and survives lock and restart.
 * This is the one finding that contradicts the vault panel's own promise
 * that "Values never leave this browser unencrypted."
 * ------------------------------------------------------------------ */
describe("finding 3: redaction misses two of the body modes", () => {
  const SECRET = "sk-live-super-secret-9999";

  test("a raw JSON body is masked (control — this one works)", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "json", raw: `{"x":"${SECRET}"}`,
      urlencoded: [], formdata: [], graphql: { query: "", variables: "" } } }), [SECRET]);
    expect(r.body.raw).not.toContain(SECRET);
  });

  test("a form-data field is not masked", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ id: "1", key: "token", value: SECRET, enabled: true }],
      graphql: { query: "", variables: "" } } }), [SECRET]);
    expect(r.body.formdata?.[0].value).not.toContain(SECRET);
  });

  test("graphql variables are not masked", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "graphql", raw: "", urlencoded: [],
      formdata: [], graphql: { query: "query{a}", variables: `{"token":"${SECRET}"}` } } }), [SECRET]);
    expect(r.body.graphql?.variables).not.toContain(SECRET);
  });

  test("end to end: the secret reaches localStorage", async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 }),
        { status: 200, headers: { "content-type": "application/json" } }));
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("apiToken", SECRET);
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "upload", method: "POST", url: "https://api.example.com/upload",
      body: { mode: "form-data", raw: "", urlencoded: [],
        formdata: [{ id: "f1", key: "token", value: "{{apiToken}}", enabled: true }],
        graphql: { query: "", variables: "" } },
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));
    await waitFor(() => expect(localStorage.getItem("signal.state.v1")).toBeTruthy());
    expect(localStorage.getItem("signal.state.v1")!).not.toContain(SECRET);
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * FINDING 4 — unlockVault reports failure but leaves the vault unlocked
 *
 * State is committed before the save that makes a new vault durable. If
 * that save throws (quota, storage disabled, private mode) the catch sets
 * vaultError and returns false, but vaultUnlocked is already true — so the
 * panel renders the unlocked view over a vault that does not exist, and
 * the error never shows because it is only rendered in the locked branch.
 * ------------------------------------------------------------------ */
describe("finding 4: a failed vault creation still reports as unlocked", () => {
  test("unlockVault returning false leaves vaultUnlocked false", async () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "signal.vault.v1") throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    };
    try {
      const ok = await useStore.getState().unlockVault("pw");
      expect({ ok, unlocked: useStore.getState().vaultUnlocked }).toEqual({ ok: false, unlocked: false });
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Neighbouring paths fixed alongside the four findings.
 * ------------------------------------------------------------------ */
describe("redaction covers the rest of the body surface", () => {
  const SECRET = "sk-live-super-secret-9999";

  test("a graphql query as well as its variables", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "graphql", raw: "", urlencoded: [], formdata: [],
      graphql: { query: `query { a(t:"${SECRET}") }`, variables: "{}" } } }), [SECRET]);
    expect(r.body.graphql?.query).not.toContain(SECRET);
  });

  test("a form-data field named like a credential is fully masked", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ id: "1", key: "access_token", value: "anything", enabled: true }],
      graphql: { query: "", variables: "" } } }));
    expect(r.body.formdata?.[0].value).toBe("[REDACTED]");
  });

  test("a redacted form-data field is restorable", () => {
    const live = emptyRequest({ body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ id: "f1", key: "token", value: "real-token-value", enabled: true }],
      graphql: { query: "", variables: "" } } });
    const back = restoreRedacted(redactRequest(live), live);
    expect(back.body.formdata?.[0].value).toBe("real-token-value");
  });

  test("a token imported from curl -F is flagged secret in the UI", () => {
    const r = parseCurl("curl -F token=abc123 -F name=alice https://x.example.com/upload")!;
    const token = r.body.formdata!.find((f) => f.key === "token")!;
    const name = r.body.formdata!.find((f) => f.key === "name")!;
    expect(token.secret).toBe(true);
    expect(name.secret).toBeFalsy();
  });

  test("an ordinary form-data value is left alone when nothing is unlocked", () => {
    const r = redactRequest(emptyRequest({ body: { mode: "form-data", raw: "", urlencoded: [],
      formdata: [{ id: "1", key: "caption", value: "a holiday photo", enabled: true }],
      graphql: { query: "", variables: "" } } }), []);
    expect(r.body.formdata?.[0].value).toBe("a holiday photo");
  });
});
