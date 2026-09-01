"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Collection,
  CollectionVersion,
  Environment,
  Folder,
  HistoryEntry,
  KeyValue,
  MockServer,
  SignalRequest,
  SignalResponse,
  TestResult,
} from "./types";
import { uid } from "./id";
import { emptyRequest as emptyRequestDefault } from "./defaults";
import { restoreRedacted } from "./secrets";

export interface TabState {
  id: string;
  requestId: string;    // matches a SignalRequest id or "draft:<id>"
  dirty: boolean;
  draft: SignalRequest; // the working copy
  response?: SignalResponse;
  tests?: TestResult[];
  logs?: string[];
  sending?: boolean;
}

interface Store {
  collections: Record<string, Collection>;
  collectionOrder: string[];
  environments: Record<string, Environment>;
  globals: KeyValue[];
  history: HistoryEntry[];
  mocks: Record<string, MockServer>;

  tabs: TabState[];
  activeTabId?: string;
  activeEnvId?: string;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // collection ops
  createCollection: (name: string) => string;
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (id: string) => void;
  addFolder: (collectionId: string, parentFolderId: string, name: string) => string;
  renameFolder: (collectionId: string, folderId: string, name: string) => void;
  deleteFolder: (collectionId: string, folderId: string) => void;
  addRequest: (collectionId: string, folderId: string, template?: Partial<SignalRequest>) => string;
  renameRequest: (collectionId: string, requestId: string, name: string) => void;
  duplicateRequest: (collectionId: string, requestId: string) => string | undefined;
  deleteRequest: (collectionId: string, requestId: string) => void;
  commitCollectionVersion: (collectionId: string, message: string) => void;
  revertCollection: (collectionId: string, versionId: string) => void;
  updateCollectionVariables: (id: string, vars: KeyValue[]) => void;

  // environment ops
  createEnvironment: (name: string) => string;
  updateEnvironment: (id: string, patch: Partial<Environment>) => void;
  deleteEnvironment: (id: string) => void;
  setActiveEnvironment: (id?: string) => void;
  updateGlobals: (vars: KeyValue[]) => void;

  // tab ops
  openRequest: (collectionId: string, requestId: string) => void;
  openDraft: (req?: Partial<SignalRequest>) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateDraft: (tabId: string, patch: Partial<SignalRequest>) => void;
  saveDraft: (tabId: string, collectionId: string, folderId: string) => void;
  /** Save a tab's draft over the request it was opened from, if any. */
  saveTabInPlace: (tabId: string) => boolean;
  /** Locate which collection+folder owns a given requestId. */
  findRequestLocation: (requestId: string) => { collectionId: string; folderId: string } | undefined;
  setTabResponse: (
    tabId: string,
    response: SignalResponse,
    tests: TestResult[],
    logs: string[]
  ) => void;
  setTabSending: (tabId: string, sending: boolean) => void;
  /**
   * Persist variable writes made by pre-request and test scripts
   * (sg.env.set / sg.globals.set / sg.collection.set). Environment writes
   * need an active environment; collection writes need an owning collection.
   */
  applyScriptUpdates: (
    updates: {
      env?: Record<string, string>;
      globals?: Record<string, string>;
      collection?: Record<string, string>;
    },
    collectionId?: string
  ) => void;

  // history
  pushHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;
  /**
   * Re-open a history entry as a tab. History stores a redacted copy, so
   * credential values are restored from the live request where one still
   * exists — otherwise the entry opens with [REDACTED] left visible.
   */
  openFromHistory: (entryId: string) => void;

  // mocks
  createMock: (name: string) => string;
  updateMock: (id: string, patch: Partial<MockServer>) => void;
  deleteMock: (id: string) => void;
}

export const emptyRequest = emptyRequestDefault;

/**
 * Upsert `overrides` into a KeyValue list: existing keys are updated in
 * place (and re-enabled), unknown keys are appended.
 */
export function mergeVars(
  base: KeyValue[] | undefined,
  overrides: Record<string, string>
): KeyValue[] {
  const result: KeyValue[] = [];
  const seen = new Set<string>();
  for (const kv of base ?? []) {
    if (Object.prototype.hasOwnProperty.call(overrides, kv.key)) {
      result.push({ ...kv, value: overrides[kv.key], enabled: true });
      seen.add(kv.key);
    } else {
      result.push(kv);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!seen.has(k)) result.push({ id: uid("ov"), key: k, value: v, enabled: true });
  }
  return result;
}

const hasKeys = (o?: Record<string, string>) => !!o && Object.keys(o).length > 0;

function newCollection(name: string): Collection {
  const rootId = uid("fld");
  const root: Folder = { id: rootId, name, requestIds: [], folderIds: [] };
  return {
    id: uid("col"),
    name,
    rootFolderId: rootId,
    folders: { [rootId]: root },
    requests: {},
    variables: [],
    versions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
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

      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

      createCollection: (name) => {
        const c = newCollection(name);
        set((s) => ({
          collections: { ...s.collections, [c.id]: c },
          collectionOrder: [...s.collectionOrder, c.id],
        }));
        return c.id;
      },
      renameCollection: (id, name) => set((s) => {
        const c = s.collections[id]; if (!c) return s;
        return { collections: { ...s.collections, [id]: { ...c, name, updatedAt: Date.now() } } };
      }),
      deleteCollection: (id) => set((s) => {
        const { [id]: _drop, ...rest } = s.collections;
        return { collections: rest, collectionOrder: s.collectionOrder.filter((x) => x !== id) };
      }),
      addFolder: (collectionId, parentFolderId, name) => {
        const fid = uid("fld");
        set((s) => {
          const c = s.collections[collectionId]; if (!c) return s;
          const parent = c.folders[parentFolderId]; if (!parent) return s;
          const folder: Folder = { id: fid, name, requestIds: [], folderIds: [] };
          return {
            collections: {
              ...s.collections,
              [collectionId]: {
                ...c,
                folders: {
                  ...c.folders,
                  [fid]: folder,
                  [parentFolderId]: { ...parent, folderIds: [...parent.folderIds, fid] },
                },
                updatedAt: Date.now(),
              },
            },
          };
        });
        return fid;
      },
      renameFolder: (collectionId, folderId, name) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        const f = c.folders[folderId]; if (!f) return s;
        return {
          collections: {
            ...s.collections,
            [collectionId]: {
              ...c,
              folders: { ...c.folders, [folderId]: { ...f, name } },
              updatedAt: Date.now(),
            },
          },
        };
      }),
      /** Deletes a folder and every request/subfolder it contains.
       *  The collection's root folder cannot be deleted. */
      deleteFolder: (collectionId, folderId) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        if (folderId === c.rootFolderId) return s;
        const doomedFolders = new Set<string>();
        const doomedRequests = new Set<string>();
        const walk = (fid: string) => {
          if (doomedFolders.has(fid)) return;
          const f = c.folders[fid];
          if (!f) return;
          doomedFolders.add(fid);
          for (const rid of f.requestIds) doomedRequests.add(rid);
          for (const child of f.folderIds) walk(child);
        };
        walk(folderId);
        const remainingFolders: Record<string, Folder> = {};
        for (const [fid, f] of Object.entries(c.folders)) {
          if (doomedFolders.has(fid)) continue;
          remainingFolders[fid] = {
            ...f,
            folderIds: f.folderIds.filter((x) => !doomedFolders.has(x)),
          };
        }
        const remainingRequests: Record<string, SignalRequest> = {};
        for (const [rid, r] of Object.entries(c.requests)) {
          if (!doomedRequests.has(rid)) remainingRequests[rid] = r;
        }
        return {
          collections: {
            ...s.collections,
            [collectionId]: {
              ...c,
              folders: remainingFolders,
              requests: remainingRequests,
              updatedAt: Date.now(),
            },
          },
          tabs: s.tabs.filter((t) => !doomedRequests.has(t.requestId)),
        };
      }),
      addRequest: (collectionId, folderId, template) => {
        const r = emptyRequest(template);
        set((s) => {
          const c = s.collections[collectionId]; if (!c) return s;
          const folder = c.folders[folderId]; if (!folder) return s;
          return {
            collections: {
              ...s.collections,
              [collectionId]: {
                ...c,
                requests: { ...c.requests, [r.id]: r },
                folders: { ...c.folders, [folderId]: { ...folder, requestIds: [...folder.requestIds, r.id] } },
                updatedAt: Date.now(),
              },
            },
          };
        });
        return r.id;
      },
      renameRequest: (collectionId, requestId, name) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        const r = c.requests[requestId]; if (!r) return s;
        return {
          collections: {
            ...s.collections,
            [collectionId]: {
              ...c,
              requests: { ...c.requests, [requestId]: { ...r, name } },
              updatedAt: Date.now(),
            },
          },
        };
      }),
      duplicateRequest: (collectionId, requestId) => {
        const state = get();
        const col = state.collections[collectionId];
        if (!col) return undefined;
        const src = col.requests[requestId];
        if (!src) return undefined;
        const parent = Object.values(col.folders).find((f) => f.requestIds.includes(requestId));
        if (!parent) return undefined;
        const copy: SignalRequest = { ...src, id: uid("req"), name: `${src.name} (copy)` };
        set((s) => {
          const c = s.collections[collectionId]; if (!c) return s;
          const f = c.folders[parent.id]; if (!f) return s;
          return {
            collections: {
              ...s.collections,
              [collectionId]: {
                ...c,
                requests: { ...c.requests, [copy.id]: copy },
                folders: {
                  ...c.folders,
                  [parent.id]: { ...f, requestIds: [...f.requestIds, copy.id] },
                },
                updatedAt: Date.now(),
              },
            },
          };
        });
        return copy.id;
      },
      deleteRequest: (collectionId, requestId) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        const { [requestId]: _drop, ...reqs } = c.requests;
        const folders: Record<string, Folder> = {};
        for (const [fid, f] of Object.entries(c.folders)) {
          folders[fid] = { ...f, requestIds: f.requestIds.filter((x) => x !== requestId) };
        }
        return {
          collections: {
            ...s.collections,
            [collectionId]: { ...c, requests: reqs, folders, updatedAt: Date.now() },
          },
          tabs: s.tabs.filter((t) => t.requestId !== requestId),
        };
      }),
      commitCollectionVersion: (collectionId, message) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        const { versions, ...snapshot } = c;
        const v: CollectionVersion = {
          id: uid("ver"),
          message,
          timestamp: Date.now(),
          snapshot,
        };
        return {
          collections: { ...s.collections, [collectionId]: { ...c, versions: [v, ...versions] } },
        };
      }),
      revertCollection: (collectionId, versionId) => set((s) => {
        const c = s.collections[collectionId]; if (!c) return s;
        const v = c.versions.find((x) => x.id === versionId); if (!v) return s;
        const reverted = {
          ...v.snapshot, versions: c.versions, updatedAt: Date.now(),
        } as Collection;
        // Deleting a request closes its tab; a revert that removes one has to
        // do the same, or the tab keeps editing a request that no longer
        // exists. Survivors stay open but are marked dirty when the reverted
        // copy no longer matches what the tab is holding.
        const tabs = s.tabs
          .filter((t) =>
            Object.prototype.hasOwnProperty.call(c.requests, t.requestId)
              ? Object.prototype.hasOwnProperty.call(reverted.requests, t.requestId)
              : true
          )
          .map((t) => {
            const r = reverted.requests[t.requestId];
            if (!r) return t;
            return { ...t, dirty: JSON.stringify(r) !== JSON.stringify(t.draft) };
          });
        return { collections: { ...s.collections, [collectionId]: reverted }, tabs };
      }),
      updateCollectionVariables: (id, vars) => set((s) => {
        const c = s.collections[id]; if (!c) return s;
        return { collections: { ...s.collections, [id]: { ...c, variables: vars, updatedAt: Date.now() } } };
      }),

      createEnvironment: (name) => {
        const id = uid("env");
        set((s) => ({ environments: { ...s.environments, [id]: { id, name, variables: [] } } }));
        return id;
      },
      updateEnvironment: (id, patch) => set((s) => {
        const e = s.environments[id]; if (!e) return s;
        return { environments: { ...s.environments, [id]: { ...e, ...patch } } };
      }),
      deleteEnvironment: (id) => set((s) => {
        const { [id]: _drop, ...rest } = s.environments;
        return { environments: rest, activeEnvId: s.activeEnvId === id ? undefined : s.activeEnvId };
      }),
      setActiveEnvironment: (id) => set({ activeEnvId: id }),
      updateGlobals: (vars) => set({ globals: vars }),

      openRequest: (collectionId, requestId) => set((s) => {
        const existing = s.tabs.find((t) => t.requestId === requestId);
        if (existing) return { activeTabId: existing.id };
        const r = s.collections[collectionId]?.requests[requestId];
        if (!r) return s;
        const tab: TabState = {
          id: uid("tab"),
          requestId,
          dirty: false,
          draft: { ...r },
        };
        return { tabs: [...s.tabs, tab], activeTabId: tab.id };
      }),
      openDraft: (req) => {
        const draft = emptyRequest(req ?? {});
        const tab: TabState = {
          id: uid("tab"),
          requestId: `draft:${draft.id}`,
          dirty: true,
          draft,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },
      closeTab: (tabId) => set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== tabId);
        const activeTabId = s.activeTabId === tabId ? tabs[tabs.length - 1]?.id : s.activeTabId;
        return { tabs, activeTabId };
      }),
      setActiveTab: (tabId) => set({ activeTabId: tabId }),
      updateDraft: (tabId, patch) => set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, draft: { ...t.draft, ...patch }, dirty: true } : t
        ),
      })),
      saveDraft: (tabId, collectionId, folderId) => set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId); if (!tab) return s;
        const col = s.collections[collectionId]; if (!col) return s;
        const folder = col.folders[folderId]; if (!folder) return s;
        const existing = col.requests[tab.draft.id];
        const requests = { ...col.requests, [tab.draft.id]: { ...tab.draft } };
        const folders = existing
          ? col.folders
          : { ...col.folders, [folderId]: { ...folder, requestIds: [...folder.requestIds, tab.draft.id] } };
        return {
          collections: {
            ...s.collections,
            [collectionId]: { ...col, requests, folders, updatedAt: Date.now() },
          },
          tabs: s.tabs.map((t) => t.id === tabId ? { ...t, dirty: false, requestId: tab.draft.id } : t),
        };
      }),
      saveTabInPlace: (tabId) => {
        const s = get();
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab) return false;
        const loc = s.findRequestLocation(tab.draft.id);
        if (!loc) return false;
        s.saveDraft(tabId, loc.collectionId, loc.folderId);
        return true;
      },
      findRequestLocation: (requestId) => {
        const s = get();
        for (const cid of s.collectionOrder) {
          const c = s.collections[cid];
          if (!c || !c.requests[requestId]) continue;
          for (const [fid, f] of Object.entries(c.folders)) {
            if (f.requestIds.includes(requestId)) {
              return { collectionId: cid, folderId: fid };
            }
          }
        }
        return undefined;
      },
      setTabResponse: (tabId, response, tests, logs) => set((s) => ({
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, response, tests, logs, sending: false } : t),
      })),
      setTabSending: (tabId, sending) => set((s) => ({
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, sending } : t),
      })),

      applyScriptUpdates: (updates, collectionId) => set((s) => {
        const next: Partial<Store> = {};
        if (hasKeys(updates.globals)) {
          next.globals = mergeVars(s.globals, updates.globals!);
        }
        if (hasKeys(updates.env) && s.activeEnvId) {
          const env = s.environments[s.activeEnvId];
          if (env) {
            next.environments = {
              ...s.environments,
              [s.activeEnvId]: { ...env, variables: mergeVars(env.variables, updates.env!) },
            };
          }
        }
        if (hasKeys(updates.collection) && collectionId) {
          const c = s.collections[collectionId];
          if (c) {
            next.collections = {
              ...s.collections,
              [collectionId]: {
                ...c,
                variables: mergeVars(c.variables, updates.collection!),
                updatedAt: Date.now(),
              },
            };
          }
        }
        return next;
      }),

      pushHistory: (entry) => set((s) => ({ history: [entry, ...s.history].slice(0, 200) })),
      clearHistory: () => set({ history: [] }),
      openFromHistory: (entryId) => {
        const s = get();
        const entry = s.history.find((h) => h.id === entryId);
        if (!entry) return;
        const loc = s.findRequestLocation(entry.request.id);
        const live = loc ? s.collections[loc.collectionId]?.requests[entry.request.id] : undefined;
        s.openDraft(restoreRedacted(entry.request, live));
      },

      createMock: (name) => {
        const id = uid("mock");
        set((s) => ({ mocks: { ...s.mocks, [id]: { id, name, routes: [] } } }));
        return id;
      },
      updateMock: (id, patch) => set((s) => {
        const m = s.mocks[id]; if (!m) return s;
        return { mocks: { ...s.mocks, [id]: { ...m, ...patch } } };
      }),
      deleteMock: (id) => set((s) => {
        const { [id]: _drop, ...rest } = s.mocks;
        return { mocks: rest };
      }),
    }),
    {
      name: "signal.state.v1",
      // Skip auto-hydration so SSR renders an empty store and the client
      // rehydrates after mount. Without this, zustand's persist middleware
      // reads localStorage synchronously during the first render pass and
      // produces hydration mismatches.
      skipHydration: true,
      storage: createJSONStorage(() =>
        typeof window === "undefined"
          ? (undefined as unknown as Storage)
          : window.localStorage
      ),
      partialize: (s) => ({
        collections: s.collections,
        collectionOrder: s.collectionOrder,
        environments: s.environments,
        globals: s.globals,
        history: s.history,
        mocks: s.mocks,
        activeEnvId: s.activeEnvId,
      }),
    }
  )
);
