"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useStore } from "@/lib/store";

type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function CommandPalette() {
  const store = useStore();
  const { commandPaletteOpen, setCommandPaletteOpen, openDraft } = store;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = /Mac/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      // The palette advertises ⌘N for a new request; bind it here so the
      // hint is true. Shift+⌘N is the browser's new-window shortcut.
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openDraft();
        setCommandPaletteOpen(false);
      }
      if (e.key === "Escape") setCommandPaletteOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandPaletteOpen, setCommandPaletteOpen, openDraft]);

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
            if (!r) return alert("Could not parse cURL");
            // A half-copied command parses but names nowhere to send anything.
            if (!r.url) return alert("That command has no URL in it.");
            store.openDraft(r);
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

  if (!commandPaletteOpen) return null;
  // Mounted only while open, so its query and highlight start fresh every
  // time. Reopening used to show the last query, and resetting it in an effect
  // meant setting state during render.
  return <PaletteBody commands={commands} onClose={() => setCommandPaletteOpen(false)} />;
}

function PaletteBody({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  // A palette is a keyboard feature: you open it, type, and press Enter. This
  // one had no highlight and no Enter, so the only way to run anything was to
  // take your hands off the keyboard and click.
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Optional-called: jsdom does not implement it, and neither do some
    // embedded webviews.
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const filtered = commands
    .filter((c) => !query || c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 25);

  const move = (delta: number) =>
    setSelected((i) => Math.max(0, Math.min(i + delta, filtered.length - 1)));

  const runSelected = () => {
    const cmd = filtered[selected];
    // With no matches there is nothing to run, and closing on Enter would
    // throw away the query the user is still correcting.
    if (!cmd) return;
    cmd.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24"
      onClick={onClose}
    >
      <div
        className="w-[560px] bg-signal-panel border border-signal-border rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="input rounded-none border-0 border-b border-signal-border"
          placeholder="type a command or request…"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={filtered[selected] ? `palette-opt-${filtered[selected].id}` : undefined}
          value={query}
          onChange={(e) => {
            // The list changes as the query does, so the highlight returns to
            // the top rather than pointing at whatever sat there before.
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
            else if (e.key === "Home") { e.preventDefault(); setSelected(0); }
            else if (e.key === "End") { e.preventDefault(); setSelected(filtered.length - 1); }
            else if (e.key === "Enter") { e.preventDefault(); runSelected(); }
          }}
        />
        <div className="max-h-80 overflow-auto" id="palette-list" role="listbox">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              id={`palette-opt-${c.id}`}
              role="option"
              aria-selected={i === selected}
              ref={i === selected ? selectedRef : undefined}
              className={`flex items-center w-full px-3 py-2 text-sm text-left hover:bg-signal-bg ${
                i === selected ? "bg-signal-bg" : ""
              }`}
              // The mouse and the keyboard share one highlight, so moving the
              // pointer over the list does not leave Enter pointing elsewhere.
              onMouseMove={() => setSelected(i)}
              onClick={() => { c.run(); onClose(); }}
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
