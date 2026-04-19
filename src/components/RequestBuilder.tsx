"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore, type TabState } from "@/lib/store";
import type { AuthType, BodyMode, Method, SignalRequest } from "@/lib/types";
import { KVEditor } from "./KVEditor";
import { executeRequest } from "@/lib/executor";
import { parseCurl, toCurl } from "@/lib/curl";
import { generateSnippet, type SnippetLang } from "@/lib/snippets";
import { uid } from "@/lib/id";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_MODES: BodyMode[] = ["none", "json", "text", "xml", "form-urlencoded", "form-data", "graphql"];
type Tab = "params" | "auth" | "headers" | "body" | "pre" | "tests" | "snippets" | "docs";

export function RequestBuilder({ tab }: { tab: TabState }) {
  const {
    updateDraft, setTabSending, setTabResponse, pushHistory,
    globals, environments, activeEnvId, collections, collectionOrder,
    saveTabInPlace, saveDraft, findRequestLocation,
  } = useStore();
  const draft = tab.draft;
  const [activeTab, setActiveTab] = useState<Tab>("params");

  const collection = useMemo(
    () => Object.values(collections).find((c) => Object.prototype.hasOwnProperty.call(c.requests, draft.id)),
    [collections, draft.id]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = /Mac/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, draft]);

  const save = () => {
    // Try saving over the tracked request first.
    if (saveTabInPlace(tab.id)) return;
    // Otherwise prompt for a destination collection.
    const existingLoc = findRequestLocation(draft.id);
    if (existingLoc) {
      saveDraft(tab.id, existingLoc.collectionId, existingLoc.folderId);
      return;
    }
    if (collectionOrder.length === 0) {
      alert("Create a collection first to save this request.");
      return;
    }
    const target = collectionOrder.length === 1
      ? collectionOrder[0]
      : prompt(
          `Save into which collection?\n${collectionOrder.map((cid, i) => `${i + 1}) ${collections[cid]?.name}`).join("\n")}`,
          "1"
        );
    const pick = typeof target === "string"
      ? (Number.isFinite(Number(target)) ? collectionOrder[Number(target) - 1] : target)
      : undefined;
    if (!pick || !collections[pick]) return;
    saveDraft(tab.id, pick, collections[pick].rootFolderId);
  };

  const send = async () => {
    setTabSending(tab.id, true);
    try {
      const scope = {
        global: globals,
        environment: activeEnvId ? environments[activeEnvId]?.variables : undefined,
        collection: collection?.variables,
      };
      const result = await executeRequest(draft, { scope });
      setTabResponse(tab.id, result.response, result.tests, result.logs);
      pushHistory({
        id: uid("hist"),
        timestamp: Date.now(),
        request: result.request,
        response: result.response,
        testResults: result.tests,
      });
    } catch (e) {
      setTabResponse(tab.id, {
        status: 0, statusText: "Error", headers: {}, body: "",
        elapsedMs: 0, sizeBytes: 0, error: (e as Error).message,
      }, [], []);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-signal-border bg-signal-panel">
        <input
          className="input bg-transparent flex-shrink-0 w-56"
          placeholder="request name"
          value={draft.name}
          onChange={(e) => updateDraft(tab.id, { name: e.target.value })}
        />
        <select
          className="bg-signal-bg border border-signal-border rounded px-2 py-1 text-sm font-bold"
          value={draft.method}
          onChange={(e) => updateDraft(tab.id, { method: e.target.value as Method })}
        >
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="input flex-1"
          placeholder="https://api.example.com/v1/resource  (use {{var}} for variables)"
          value={draft.url}
          onChange={(e) => updateDraft(tab.id, { url: e.target.value })}
        />
        <button
          className="btn-primary"
          onClick={send}
          disabled={tab.sending || !draft.url}
        >{tab.sending ? "Sending…" : "Send"}</button>
        <button
          className="btn"
          onClick={save}
          disabled={!tab.dirty}
          title={tab.dirty ? "Save changes (Cmd/Ctrl+S)" : "No changes"}
        >Save</button>
      </div>

      <nav className="flex gap-1 border-b border-signal-border bg-signal-panel px-2">
        {(["params", "auth", "headers", "body", "pre", "tests", "snippets", "docs"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={`tab ${activeTab === t ? "tab-active" : ""}`}>
            {t === "pre" ? "pre-request" : t}
          </button>
        ))}
      </nav>

      <div className="p-3 overflow-auto">
        {activeTab === "params" && (
          <KVEditor rows={draft.params} onChange={(rows) => updateDraft(tab.id, { params: rows })} keyPlaceholder="param" />
        )}
        {activeTab === "headers" && (
          <KVEditor rows={draft.headers} onChange={(rows) => updateDraft(tab.id, { headers: rows })} keyPlaceholder="Header-Name" />
        )}
        {activeTab === "auth" && <AuthEditor tab={tab} />}
        {activeTab === "body" && <BodyEditor tab={tab} />}
        {activeTab === "pre" && (
          <ScriptEditor
            value={draft.preRequestScript}
            onChange={(v) => updateDraft(tab.id, { preRequestScript: v })}
            hint="Runs before the request. Use sg.env.set('key','value') or sg.globals.set(...)."
          />
        )}
        {activeTab === "tests" && (
          <ScriptEditor
            value={draft.testScript}
            onChange={(v) => updateDraft(tab.id, { testScript: v })}
            hint={"sg.test('status is 200', () => sg.expect(sg.response.status).toBe(200));"}
          />
        )}
        {activeTab === "snippets" && <SnippetsPanel request={draft} />}
        {activeTab === "docs" && (
          <textarea
            className="input h-60 font-mono"
            placeholder="Markdown description (shown when publishing docs)"
            value={draft.description ?? ""}
            onChange={(e) => updateDraft(tab.id, { description: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

function AuthEditor({ tab }: { tab: TabState }) {
  const { updateDraft } = useStore();
  const auth = tab.draft.auth;
  const setType = (type: AuthType) => updateDraft(tab.id, { auth: { ...auth, type } });
  return (
    <div className="space-y-3 max-w-2xl">
      <div className="flex gap-2">
        <span className="text-xs text-signal-muted py-1.5">Auth:</span>
        {(["none", "basic", "bearer", "apikey", "oauth2"] as AuthType[]).map((t) => (
          <button key={t} onClick={() => setType(t)} className={`btn ${auth.type === t ? "border-signal-accent text-white" : ""}`}>{t}</button>
        ))}
      </div>
      {auth.type === "basic" && (
        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="username" value={auth.basic?.username ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, basic: { username: e.target.value, password: auth.basic?.password ?? "" } } })} />
          <input className="input" placeholder="password" type="password" value={auth.basic?.password ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, basic: { username: auth.basic?.username ?? "", password: e.target.value } } })} />
        </div>
      )}
      {auth.type === "bearer" && (
        <input className="input" placeholder="token" value={auth.bearer?.token ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, bearer: { token: e.target.value } } })} />
      )}
      {auth.type === "apikey" && (
        <div className="grid grid-cols-[1fr_1fr_140px] gap-2">
          <input className="input" placeholder="key name" value={auth.apikey?.key ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, apikey: { key: e.target.value, value: auth.apikey?.value ?? "", in: auth.apikey?.in ?? "header" } } })} />
          <input className="input" placeholder="value" value={auth.apikey?.value ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, apikey: { key: auth.apikey?.key ?? "", value: e.target.value, in: auth.apikey?.in ?? "header" } } })} />
          <select
            className="input"
            value={auth.apikey?.in ?? "header"}
            onChange={(e) => updateDraft(tab.id, { auth: { ...auth, apikey: { key: auth.apikey?.key ?? "", value: auth.apikey?.value ?? "", in: e.target.value as "header" | "query" } } })}
          >
            <option value="header">in header</option>
            <option value="query">in query</option>
          </select>
        </div>
      )}
      {auth.type === "oauth2" && (
        <div className="grid grid-cols-[140px_1fr] gap-2">
          <input className="input" placeholder="token type (Bearer)" value={auth.oauth2?.tokenType ?? "Bearer"} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, oauth2: { accessToken: auth.oauth2?.accessToken ?? "", tokenType: e.target.value } } })} />
          <input className="input" placeholder="access token" value={auth.oauth2?.accessToken ?? ""} onChange={(e) => updateDraft(tab.id, { auth: { ...auth, oauth2: { accessToken: e.target.value, tokenType: auth.oauth2?.tokenType } } })} />
        </div>
      )}
    </div>
  );
}

function BodyEditor({ tab }: { tab: TabState }) {
  const { updateDraft } = useStore();
  const body = tab.draft.body;
  const setMode = (mode: BodyMode) => updateDraft(tab.id, { body: { ...body, mode } });

  return (
    <div className="space-y-2">
      <div className="flex gap-1 flex-wrap">
        {BODY_MODES.map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`btn ${body.mode === m ? "border-signal-accent text-white" : ""}`}>{m}</button>
        ))}
        <span className="ml-auto">
          <button
            className="btn"
            onClick={() => {
              const input = prompt("Paste a cURL command:");
              if (!input) return;
              const parsed = parseCurl(input);
              if (!parsed) return alert("Could not parse cURL");
              updateDraft(tab.id, parsed);
            }}
          >Import cURL</button>
        </span>
      </div>

      {body.mode === "none" && <div className="text-xs text-signal-muted">This request has no body.</div>}
      {(body.mode === "json" || body.mode === "text" || body.mode === "xml") && (
        <textarea
          className="input font-mono h-72"
          placeholder={body.mode === "json" ? `{\n  "example": true\n}` : "raw body"}
          value={body.raw ?? ""}
          onChange={(e) => updateDraft(tab.id, { body: { ...body, raw: e.target.value } })}
        />
      )}
      {body.mode === "form-urlencoded" && (
        <KVEditor rows={body.urlencoded ?? []} onChange={(rows) => updateDraft(tab.id, { body: { ...body, urlencoded: rows } })} />
      )}
      {body.mode === "form-data" && (
        <div className="text-xs text-signal-muted">form-data files are edited client-side; this MVP transmits text fields only.</div>
      )}
      {body.mode === "graphql" && (
        <div className="grid grid-cols-2 gap-2">
          <textarea
            className="input font-mono h-72"
            placeholder="query { ... }"
            value={body.graphql?.query ?? ""}
            onChange={(e) => updateDraft(tab.id, { body: { ...body, graphql: { query: e.target.value, variables: body.graphql?.variables ?? "" } } })}
          />
          <textarea
            className="input font-mono h-72"
            placeholder={`{\n  "id": "123"\n}`}
            value={body.graphql?.variables ?? ""}
            onChange={(e) => updateDraft(tab.id, { body: { ...body, graphql: { query: body.graphql?.query ?? "", variables: e.target.value } } })}
          />
        </div>
      )}
    </div>
  );
}

function ScriptEditor({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-signal-muted">{hint}</div>
      <textarea
        className="input font-mono h-72"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SnippetsPanel({ request }: { request: SignalRequest }) {
  const [lang, setLang] = useState<SnippetLang>("curl");
  const snippet = generateSnippet(request, lang);
  return (
    <div className="space-y-2">
      <div className="flex gap-1 flex-wrap">
        {(["curl", "fetch", "node-fetch", "python-requests", "go", "httpie"] as SnippetLang[]).map((l) => (
          <button key={l} onClick={() => setLang(l)} className={`btn ${lang === l ? "border-signal-accent text-white" : ""}`}>{l}</button>
        ))}
        <button className="btn ml-auto" onClick={() => navigator.clipboard.writeText(snippet)}>Copy</button>
      </div>
      <pre className="input font-mono h-72 overflow-auto whitespace-pre-wrap">{snippet}</pre>
      <div className="text-[11px] text-signal-muted">Tip: export any request as <code>{toCurl(request).slice(0, 40)}…</code> via the cURL tab.</div>
    </div>
  );
}
