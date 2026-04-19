"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { Collection, Folder, Method, MockRoute, MockServer, SignalRequest } from "@/lib/types";
import { uid } from "@/lib/id";
import { EditableName, type EditableNameHandle } from "./EditableName";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";

type Panel = "collections" | "environments" | "history" | "mocks";

export function Sidebar() {
  const [panel, setPanel] = useState<Panel>("collections");
  const [search, setSearch] = useState("");

  return (
    <aside className="w-80 shrink-0 border-r border-signal-border bg-signal-panel flex flex-col">
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
  const { commitCollectionVersion, addFolder, renameCollection, deleteCollection } = useStore();
  const [open, setOpen] = useState(true);
  const nameRef = useRef<EditableNameHandle | null>(null);
  const root = collection.folders[collection.rootFolderId];

  const matches = (r: SignalRequest) =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.url.toLowerCase().includes(search.toLowerCase());

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: "Delete collection",
      message: `Delete "${collection.name}" and everything inside it?\n\nThis cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteCollection(collection.id);
  };

  return (
    <div className="border border-signal-border rounded">
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-signal-bg relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-signal-muted hover:text-white w-5 h-5 flex items-center justify-center rounded hover:bg-signal-panel"
          aria-label={open ? "Collapse collection" : "Expand collection"}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        <EditableName
          ref={nameRef}
          value={collection.name}
          onSave={(next) => renameCollection(collection.id, next)}
          className="font-medium text-white text-sm flex-1 truncate px-1"
          inputClassName="input flex-1 !py-0 !text-sm font-medium"
          ariaLabel={`Rename collection ${collection.name}`}
        />
        <IconButton
          label={`Rename collection ${collection.name}`}
          title="Rename"
          onClick={() => nameRef.current?.startEditing()}
        >
          <Icon name="pencil" />
        </IconButton>
        <IconButton
          label="Add folder"
          title="Add folder"
          onClick={() => addFolder(collection.id, collection.rootFolderId, "new folder")}
        >
          <Icon name="folderPlus" />
        </IconButton>
        <IconButton
          label="Commit version"
          title="Commit version"
          onClick={() => commitCollectionVersion(collection.id, new Date().toISOString())}
        >
          <Icon name="gitBranch" />
        </IconButton>
        <IconButton
          label={`Delete collection ${collection.name}`}
          title="Delete collection"
          danger
          onClick={handleDelete}
        >
          <Icon name="trash" />
        </IconButton>
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
  const { addFolder, renameFolder, deleteFolder } = useStore();
  const [open, setOpen] = useState(true);
  const nameRef = useRef<EditableNameHandle | null>(null);
  const isRoot = folder.id === collection.rootFolderId;
  const subRequests = folder.requestIds
    .map((id) => collection.requests[id])
    .filter((r): r is SignalRequest => Boolean(r))
    .filter(matches);
  const subFolders = folder.folderIds
    .map((id) => collection.folders[id])
    .filter((f): f is Folder => Boolean(f));

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: "Delete folder",
      message: `Delete folder "${folder.name}" and everything inside it?\n\nThis cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteFolder(collection.id, folder.id);
  };

  return (
    <div className="pl-2">
      {/* The collection's root folder has no visible row of its own — its
          name is already the collection header. Show a row only for
          non-root (nested) folders. */}
      {!isRoot && (
        <div className="flex items-center gap-0.5 px-1 py-0.5 text-sm relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-5 h-5 flex items-center justify-center rounded text-signal-muted hover:text-white hover:bg-signal-panel"
            aria-label={open ? "Collapse folder" : "Expand folder"}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          </button>
          <EditableName
            ref={nameRef}
            value={folder.name}
            onSave={(next) => renameFolder(collection.id, folder.id, next)}
            className="flex-1 text-signal-muted truncate px-1"
            inputClassName="input flex-1 !py-0 !text-xs"
            ariaLabel={`Rename folder ${folder.name}`}
          />
          <IconButton
            label={`Rename folder ${folder.name}`}
            title="Rename folder"
            onClick={() => nameRef.current?.startEditing()}
          >
            <Icon name="pencil" size={12} />
          </IconButton>
          <IconButton
            label="Add request to folder"
            title="Add request here"
            onClick={() => onAddRequest(folder.id)}
          >
            <Icon name="plus" size={12} />
          </IconButton>
          <IconButton
            label="Add subfolder"
            title="Add subfolder"
            onClick={() => addFolder(collection.id, folder.id, "subfolder")}
          >
            <Icon name="folderPlus" size={12} />
          </IconButton>
          <IconButton
            label={`Delete folder ${folder.name}`}
            title="Delete folder"
            danger
            onClick={handleDelete}
          >
            <Icon name="trash" size={12} />
          </IconButton>
        </div>
      )}
      {open && (
        <div className={isRoot ? "" : "pl-4"}>
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
  const nameRef = useRef<EditableNameHandle | null>(null);

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: "Delete request",
      message: `Delete "${request.name || request.url || "(untitled)"}"?\n\nThis cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteRequest(collection.id, request.id);
  };

  return (
    <div className="flex items-center gap-1 w-full text-xs hover:bg-signal-bg rounded pr-1">
      <button
        className={`method-pill method-${request.method}`}
        onClick={() => onOpen(request.id)}
        aria-label={`Open ${request.name || request.url}`}
      >
        {request.method}
      </button>
      <EditableName
        ref={nameRef}
        value={request.name || request.url || "(untitled)"}
        onSave={(next) => renameRequest(collection.id, request.id, next)}
        className="flex-1 text-left px-1 py-0.5 min-w-0 truncate text-slate-200 cursor-pointer"
        inputClassName="input flex-1 !py-0 !text-xs"
        ariaLabel={`Rename request ${request.name || request.url}`}
      />
      <IconButton
        label={`Rename request ${request.name || request.url}`}
        title="Rename request"
        onClick={() => nameRef.current?.startEditing()}
      >
        <Icon name="pencil" size={12} />
      </IconButton>
      <IconButton
        label="Duplicate request"
        title="Duplicate"
        onClick={() => {
          const dupId = duplicateRequest(collection.id, request.id);
          if (dupId) openRequest(collection.id, dupId);
        }}
      >
        <Icon name="copy" size={12} />
      </IconButton>
      <IconButton
        label={`Delete request ${request.name || request.url}`}
        title="Delete request"
        danger
        onClick={handleDelete}
      >
        <Icon name="trash" size={12} />
      </IconButton>
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

/**
 * Consistent icon-button styling for the sidebar action buttons. Always
 * visible; shows a hover box and dim → bright color transition so users
 * can tell it's clickable.
 */
function IconButton({
  label, title, onClick, danger = false, children,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={
        "w-6 h-6 flex items-center justify-center rounded text-signal-muted " +
        (danger
          ? "hover:bg-signal-err/20 hover:text-signal-err"
          : "hover:bg-signal-panel hover:text-white")
      }
    >
      {children}
    </button>
  );
}
