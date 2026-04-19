"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import type { Collection, Folder, Method, MockRoute, MockServer, SignalRequest } from "@/lib/types";
import { uid } from "@/lib/id";

type Panel = "collections" | "environments" | "history" | "mocks";

export function Sidebar() {
  const [panel, setPanel] = useState<Panel>("collections");
  const [search, setSearch] = useState("");

  return (
    <aside className="w-72 shrink-0 border-r border-signal-border bg-signal-panel flex flex-col">
      <div className="p-3 border-b border-signal-border flex items-center gap-2">
        <div className="font-bold text-white tracking-wider">
          <span className="text-signal-accent">signarm</span> signal
        </div>
        <div className="ml-auto text-[10px] text-signal-muted">v0.1</div>
      </div>
      <nav className="flex text-xs border-b border-signal-border">
        {(["collections", "environments", "history", "mocks"] as Panel[]).map((p) => (
          <button
            key={p}
            className={`flex-1 py-2 ${panel === p ? "text-white bg-signal-bg" : "text-signal-muted"}`}
            onClick={() => setPanel(p)}
          >
            {p}
          </button>
        ))}
      </nav>
      <div className="p-2">
        <input
          className="input"
          placeholder="search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-auto">
        {panel === "collections" && <CollectionsPanel search={search} />}
        {panel === "environments" && <EnvironmentsPanel />}
        {panel === "history" && <HistoryPanel />}
        {panel === "mocks" && <MocksPanel />}
      </div>
    </aside>
  );
}

function CollectionsPanel({ search }: { search: string }) {
  const { collections, collectionOrder, createCollection, addRequest, openRequest } = useStore();

  return (
    <div className="p-2 space-y-2">
      <button
        className="btn w-full text-left"
        onClick={() => {
          const name = prompt("Collection name", "My Collection");
          if (name) createCollection(name);
        }}
      >
        + New collection
      </button>
      {collectionOrder.map((cid) => {
        const c = collections[cid];
        if (!c) return null;
        return (
          <CollectionTree
            key={cid}
            collection={c}
            search={search}
            onAddRequest={(fid) => {
              const rid = addRequest(c.id, fid);
              openRequest(c.id, rid);
            }}
            onOpen={(rid) => openRequest(c.id, rid)}
          />
        );
      })}
    </div>
  );
}

function CollectionTree({
  collection, search, onAddRequest, onOpen,
}: {
  collection: Collection;
  search: string;
  onAddRequest: (folderId: string) => void;
  onOpen: (requestId: string) => void;
}) {
  const { commitCollectionVersion, addFolder } = useStore();
  const [open, setOpen] = useState(true);
  const root = collection.folders[collection.rootFolderId];

  const matches = (r: SignalRequest) =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.url.toLowerCase().includes(search.toLowerCase());

  return (
    <div className="border border-signal-border rounded">
      <div className="flex items-center gap-1 px-2 py-1 bg-signal-bg">
        <button onClick={() => setOpen((o) => !o)} className="text-signal-muted w-4">{open ? "▾" : "▸"}</button>
        <span className="font-medium text-white text-sm flex-1 truncate">{collection.name}</span>
        <button
          className="text-xs text-signal-muted hover:text-white"
          title="Commit version"
          onClick={() => {
            const msg = prompt("Commit message", "checkpoint");
            if (msg) commitCollectionVersion(collection.id, msg);
          }}
        >⎘</button>
        <button
          className="text-xs text-signal-muted hover:text-white"
          title="New folder"
          onClick={() => {
            const name = prompt("Folder name", "new folder");
            if (name) addFolder(collection.id, collection.rootFolderId, name);
          }}
        >＋</button>
      </div>
      {open && (
        <FolderNode
          collection={collection}
          folder={root}
          onAddRequest={onAddRequest}
          onOpen={onOpen}
          matches={matches}
        />
      )}
    </div>
  );
}

function FolderNode({
  collection, folder, onAddRequest, onOpen, matches,
}: {
  collection: Collection;
  folder: Folder;
  onAddRequest: (fid: string) => void;
  onOpen: (rid: string) => void;
  matches: (r: SignalRequest) => boolean;
}) {
  const [open, setOpen] = useState(true);
  const subRequests = folder.requestIds
    .map((id) => collection.requests[id])
    .filter((r): r is SignalRequest => Boolean(r))
    .filter(matches);
  const subFolders = folder.folderIds
    .map((id) => collection.folders[id])
    .filter((f): f is Folder => Boolean(f));

  return (
    <div className="pl-2">
      <div className="flex items-center gap-1 px-1 py-0.5 text-sm">
        <button onClick={() => setOpen((o) => !o)} className="w-4 text-signal-muted">{open ? "▾" : "▸"}</button>
        <span className="flex-1 text-signal-muted truncate">{folder.name}</span>
        <button
          className="text-[11px] text-signal-muted hover:text-white"
          onClick={() => onAddRequest(folder.id)}
          title="Add request"
        >+req</button>
      </div>
      {open && (
        <div className="pl-4">
          {subFolders.map((f) => (
            <FolderNode key={f.id} collection={collection} folder={f} onAddRequest={onAddRequest} onOpen={onOpen} matches={matches} />
          ))}
          {subRequests.map((r) => (
            <RequestItem key={r.id} collection={collection} request={r} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestItem({
  collection, request, onOpen,
}: {
  collection: Collection;
  request: SignalRequest;
  onOpen: (id: string) => void;
}) {
  const { renameRequest, duplicateRequest, deleteRequest, openRequest } = useStore();
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div
      className="group flex items-center gap-2 w-full text-xs hover:bg-signal-bg rounded pr-1"
      onMouseLeave={() => setShowMenu(false)}
    >
      <button
        className="flex items-center gap-2 flex-1 text-left px-1 py-0.5 min-w-0"
        onClick={() => onOpen(request.id)}
      >
        <span className={`method-pill method-${request.method}`}>{request.method}</span>
        <span className="truncate text-slate-200">{request.name || request.url || "(untitled)"}</span>
      </button>
      <div className="relative">
        <button
          className="opacity-0 group-hover:opacity-100 text-signal-muted hover:text-white px-1"
          onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
        >⋯</button>
        {showMenu && (
          <div
            className="absolute right-0 top-5 z-10 bg-signal-panel border border-signal-border rounded shadow text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="block w-full text-left px-2 py-1 hover:bg-signal-bg"
              onClick={() => {
                const next = prompt("Rename request", request.name);
                if (next !== null) renameRequest(collection.id, request.id, next);
                setShowMenu(false);
              }}
            >Rename</button>
            <button
              className="block w-full text-left px-2 py-1 hover:bg-signal-bg"
              onClick={() => {
                const dupId = duplicateRequest(collection.id, request.id);
                if (dupId) openRequest(collection.id, dupId);
                setShowMenu(false);
              }}
            >Duplicate</button>
            <button
              className="block w-full text-left px-2 py-1 hover:bg-signal-bg text-signal-err"
              onClick={() => {
                if (confirm(`Delete "${request.name || request.url}"?`)) {
                  deleteRequest(collection.id, request.id);
                }
                setShowMenu(false);
              }}
            >Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentsPanel() {
  const { environments, createEnvironment, updateEnvironment, deleteEnvironment, setActiveEnvironment, activeEnvId, globals, updateGlobals } = useStore();
  const envList = useMemo(() => Object.values(environments), [environments]);
  const [editing, setEditing] = useState<string | undefined>(undefined);

  return (
    <div className="p-2 space-y-2">
      <button
        className="btn w-full"
        onClick={() => {
          const name = prompt("Environment name", "dev");
          if (name) setEditing(createEnvironment(name));
        }}
      >+ New environment</button>

      <div className="border border-signal-border rounded">
        <div className="px-2 py-1 text-xs text-signal-muted">Globals</div>
        <MiniVars vars={globals} onChange={updateGlobals} />
      </div>

      {envList.map((e) => (
        <div key={e.id} className="border border-signal-border rounded">
          <div className="flex items-center gap-1 px-2 py-1">
            <input
              type="radio"
              name="env"
              checked={activeEnvId === e.id}
              onChange={() => setActiveEnvironment(e.id)}
            />
            <input
              className="input flex-1"
              value={e.name}
              onChange={(ev) => updateEnvironment(e.id, { name: ev.target.value })}
            />
            <button
              className="text-xs text-signal-muted"
              onClick={() => setEditing((x) => (x === e.id ? undefined : e.id))}
            >{editing === e.id ? "close" : "edit"}</button>
            <button
              className="text-xs text-signal-muted hover:text-signal-err"
              onClick={() => deleteEnvironment(e.id)}
            >×</button>
          </div>
          {editing === e.id && (
            <MiniVars
              vars={e.variables}
              onChange={(vars) => updateEnvironment(e.id, { variables: vars })}
            />
          )}
        </div>
      ))}
      {activeEnvId === undefined && (
        <div className="text-[11px] text-signal-muted px-1">No environment selected.</div>
      )}
    </div>
  );
}

type MiniVar = { id: string; key: string; value: string; enabled: boolean };
function MiniVars({ vars, onChange }: { vars: MiniVar[]; onChange: (v: MiniVar[]) => void }) {
  const list: MiniVar[] = [...vars, { id: "__new", key: "", value: "", enabled: true }];
  const update = (id: string, patch: Partial<MiniVar>) => {
    if (id === "__new") {
      onChange([...vars, { id: `kv_${Date.now()}`, key: "", value: "", enabled: true, ...patch }]);
      return;
    }
    onChange(vars.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };
  const remove = (id: string) => onChange(vars.filter((v) => v.id !== id));
  return (
    <div className="p-1 space-y-1">
      {list.map((v) => (
        <div key={v.id} className="grid grid-cols-[20px_1fr_1fr_20px] gap-1">
          <input type="checkbox" checked={v.enabled} onChange={(e) => update(v.id, { enabled: e.target.checked })} />
          <input className="input" placeholder="key" value={v.key} onChange={(e) => update(v.id, { key: e.target.value })} />
          <input className="input" placeholder="value" value={v.value} onChange={(e) => update(v.id, { value: e.target.value })} />
          {v.id !== "__new" ? <button className="text-signal-muted hover:text-signal-err" onClick={() => remove(v.id)}>×</button> : <span />}
        </div>
      ))}
    </div>
  );
}

function HistoryPanel() {
  const { history, clearHistory, openDraft } = useStore();
  if (!history.length) return <div className="text-xs text-signal-muted p-2">No history yet. Send a request to populate this list.</div>;
  return (
    <div className="p-2 space-y-1">
      <button className="btn w-full" onClick={clearHistory}>Clear history</button>
      {history.map((h) => (
        <button
          key={h.id}
          className="w-full text-left px-2 py-1 text-xs hover:bg-signal-bg rounded border border-signal-border"
          onClick={() => openDraft(h.request)}
        >
          <div className="flex items-center gap-2">
            <span className={`method-pill method-${h.request.method}`}>{h.request.method}</span>
            <span className="truncate">{h.request.url || "(no url)"}</span>
          </div>
          <div className="text-[10px] text-signal-muted mt-0.5">
            {h.response ? `${h.response.status} · ${h.response.elapsedMs}ms · ${h.response.sizeBytes}B` : "—"}
          </div>
        </button>
      ))}
    </div>
  );
}

function MocksPanel() {
  const { mocks, createMock, updateMock, deleteMock } = useStore();
  const list = useMemo(() => Object.values(mocks), [mocks]);
  return (
    <div className="p-2 space-y-2">
      <button
        className="btn w-full"
        onClick={() => {
          const name = prompt("Mock server name", "my-mock");
          if (name) createMock(name);
        }}
      >+ New mock server</button>
      {list.map((m) => (
        <MockServerEditor
          key={m.id}
          server={m}
          onRename={(name) => updateMock(m.id, { name })}
          onDelete={() => deleteMock(m.id)}
          onRoutesChange={(routes) => updateMock(m.id, { routes })}
        />
      ))}
    </div>
  );
}

function MockServerEditor({
  server, onRename, onDelete, onRoutesChange,
}: {
  server: MockServer;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRoutesChange: (routes: MockRoute[]) => void;
}) {
  const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const [syncing, setSyncing] = useState<"idle" | "ok" | "error">("idle");
  const [expanded, setExpanded] = useState(false);

  const sync = async () => {
    setSyncing("idle");
    const { registerMock } = await import("@/lib/transport");
    const res = await registerMock(server.id, server.routes);
    setSyncing(res.ok ? "ok" : "error");
  };

  const addRoute = () => {
    const newRoute: MockRoute = {
      id: uid("rt"),
      method: "GET",
      path: "/",
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    onRoutesChange([...server.routes, newRoute]);
    setExpanded(true);
  };

  return (
    <div className="border border-signal-border rounded p-2 space-y-1">
      <div className="flex items-center gap-1">
        <button className="text-signal-muted w-4" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "▾" : "▸"}
        </button>
        <input className="input flex-1" value={server.name} onChange={(e) => onRename(e.target.value)} />
        <button className="text-xs text-signal-muted hover:text-signal-err" onClick={onDelete}>×</button>
      </div>
      <div className="text-[10px] text-signal-muted break-all">
        <code>/api/mock/{server.id}/&lt;path&gt;</code>
      </div>
      {expanded && (
        <div className="space-y-1">
          {server.routes.map((r, idx) => (
            <div key={r.id} className="border border-signal-border rounded p-1 space-y-1">
              <div className="flex items-center gap-1">
                <select
                  className="input !w-20"
                  value={r.method}
                  onChange={(e) => {
                    const copy = [...server.routes]; copy[idx] = { ...r, method: e.target.value as Method };
                    onRoutesChange(copy);
                  }}
                >
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input
                  className="input flex-1"
                  value={r.path}
                  placeholder="/path"
                  onChange={(e) => {
                    const copy = [...server.routes]; copy[idx] = { ...r, path: e.target.value };
                    onRoutesChange(copy);
                  }}
                />
                <input
                  className="input !w-16"
                  type="number"
                  value={r.status}
                  onChange={(e) => {
                    const copy = [...server.routes]; copy[idx] = { ...r, status: Number(e.target.value) };
                    onRoutesChange(copy);
                  }}
                />
                <button
                  className="text-xs text-signal-muted hover:text-signal-err"
                  onClick={() => onRoutesChange(server.routes.filter((x) => x.id !== r.id))}
                >×</button>
              </div>
              <textarea
                className="input font-mono h-16 text-[11px]"
                placeholder="response body"
                value={r.body}
                onChange={(e) => {
                  const copy = [...server.routes]; copy[idx] = { ...r, body: e.target.value };
                  onRoutesChange(copy);
                }}
              />
            </div>
          ))}
          <div className="flex gap-1">
            <button className="btn flex-1" onClick={addRoute}>+ Route</button>
            <button className="btn flex-1" onClick={sync}>
              Publish{syncing === "ok" ? " ✓" : syncing === "error" ? " ✗" : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
