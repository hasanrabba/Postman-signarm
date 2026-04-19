"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";

type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function CommandPalette() {
  const store = useStore();
  const { commandPaletteOpen, setCommandPaletteOpen } = store;
  const [query, setQuery] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = /Mac/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if (e.key === "Escape") setCommandPaletteOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new-request", label: "New request", hint: "⌘N", run: () => store.openDraft() },
      { id: "new-collection", label: "New collection", run: () => {
          const name = prompt("Collection name", "My Collection"); if (name) store.createCollection(name);
        } },
      { id: "new-environment", label: "New environment", run: () => {
          const name = prompt("Environment name", "dev"); if (name) store.createEnvironment(name);
        } },
      { id: "import-curl", label: "Import request from cURL", run: () => {
          const text = prompt("Paste a cURL command");
          if (!text) return;
          import("@/lib/curl").then(({ parseCurl }) => {
            const r = parseCurl(text);
            if (r) store.openDraft(r);
            else alert("Could not parse cURL");
          });
        } },
      { id: "ai-describe", label: "AI: describe this request", hint: "stub", run: () => {
          alert("Wire this up to your AI provider by POSTing the active request to /api/ai-explain.");
        } },
    ];
    for (const cid of store.collectionOrder) {
      const col = store.collections[cid];
      if (!col) continue;
      for (const req of Object.values(col.requests)) {
        cmds.push({
          id: `open-${req.id}`,
          label: `Open: ${req.name || req.url || "(untitled)"}`,
          hint: req.method,
          run: () => store.openRequest(col.id, req.id),
        });
      }
    }
    return cmds;
  }, [store]);

  const filtered = commands
    .filter((c) => !query || c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 25);

  if (!commandPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-[560px] bg-signal-panel border border-signal-border rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="input rounded-none border-0 border-b border-signal-border"
          placeholder="type a command or request…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-80 overflow-auto">
          {filtered.map((c) => (
            <button
              key={c.id}
              className="flex items-center w-full px-3 py-2 text-sm text-left hover:bg-signal-bg"
              onClick={() => { c.run(); setCommandPaletteOpen(false); }}
            >
              <span className="flex-1 truncate">{c.label}</span>
              {c.hint && <span className="kbd">{c.hint}</span>}
            </button>
          ))}
          {!filtered.length && <div className="px-3 py-4 text-xs text-signal-muted">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
