"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useStore } from "@/lib/store";
import { anyLayerOpen, useModalFocus, useTopLayer } from "@/lib/layers";

type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function CommandPalette() {
  const store = useStore();
  const { commandPaletteOpen, setCommandPaletteOpen, openDraft } = store;
  const isTop = useTopLayer(commandPaletteOpen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Holding a key autorepeats. Holding ⌘N gave a fistful of blank tabs.
      if (e.repeat) return;
      // AltGr reports as ctrl+alt on Windows and Linux, so a shortcut that
      // ignores Alt eats characters a German or Polish layout types with it.
      if (e.altKey) return;
      const isMac = /Mac/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      // The palette advertises ⌘N for a new request; bind it here so the
      // hint is true. Shift+⌘N is the browser's new-window shortcut.
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n" && !anyLayerOpen()) {
        e.preventDefault();
        openDraft();
        setCommandPaletteOpen(false);
      }
      // Only when the palette is the layer on top: one Escape used to dismiss
      // both it and a confirm dialog underneath.
      if (e.key === "Escape" && isTop()) setCommandPaletteOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandPaletteOpen, setCommandPaletteOpen, openDraft, isTop]);

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
        // Qualified by collection: two requests called "Create order" in
        // different collections were two identical rows, and picking the wrong
        // one is silent — you only find out after you send it.
        //
        // Trimmed, because a name of spaces is not a name. " " rendered as a
        // blank row you could still click, and `||` let it through.
        const name = req.name.trim() || req.url.trim() || "(untitled)";
        const where = col.name.trim();
        cmds.push({
          id: `open-${req.id}`,
          label: where ? `Open: ${where} / ${name}` : `Open: ${name}`,
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

const MAX_ROWS = 25;

function PaletteBody({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const boxRef = useModalFocus<HTMLDivElement>(true);
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

  // Split on whitespace and match every word anywhere in the label. A trailing
  // space — which you get for free from autocomplete, or from typing "get " and
  // pausing — used to match nothing at all, and typing the two words you
  // remember ("orders create") found nothing because they are not adjacent.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = commands.filter((c) => {
    const hay = c.label.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  // The list is capped so a 500-request collection does not paint 500 rows.
  // Silently, it looked like the request you were after did not exist.
  const filtered = matches.slice(0, MAX_ROWS);
  const hidden = matches.length - filtered.length;

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
      // Above the confirm dialog (z-60) and the runner (z-40). It used to sit
      // at z-50, so opening it over a dialog put an invisible input in charge
      // of the keyboard and everything typed went into it.
      className="fixed inset-0 z-[70] bg-black/60 flex items-start justify-center pt-24"
      // On mousedown, and only when the press and the release both landed on
      // the backdrop. Dragging to select text in the query and releasing past
      // the edge of the box counted as a click on the backdrop, so the palette
      // shut and took the half-typed query with it.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[560px] bg-signal-panel border border-signal-border rounded shadow-2xl"
      >
        <input
          // Not `autoFocus`: React applies that during commit, before the
          // focus trap can note where the cursor came from, and closing then
          // had nowhere to put it back. useModalFocus focuses this instead.
          data-modal-autofocus
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
            // Bare Enter only: ⌘Enter belongs to the request behind the
            // palette, not to the highlighted command.
            else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              runSelected();
            }
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
        {hidden > 0 && (
          <div className="px-3 py-2 text-xs text-signal-muted border-t border-signal-border">
            {hidden} more {hidden === 1 ? "match" : "matches"} not shown — keep typing to narrow.
          </div>
        )}
      </div>
    </div>
  );
}
