"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { confirmDialog } from "@/components/ConfirmDialog";
import { anyLayerOpen } from "@/lib/layers";

/** What a tab is called, in one place, so the strip and its tooltip agree. */
function tabLabel(name: string, url: string): string {
  return name.trim() || url.trim() || "Untitled";
}

export function Tabs() {
  const { tabs, activeTabId, setActiveTab, closeTab, openDraft, commandPaletteOpen, setCommandPaletteOpen } = useStore();
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab on screen. The strip scrolls horizontally and nothing
  // moved it, so with thirty tabs open the highlighted one was off the right
  // edge — the tabs you could see showed no selection at all, and after a close
  // you had no way to tell which request you had landed on.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  // ⌘1..⌘9 jumps to a tab, ⌘9 to the last one, the way every tabbed editor
  // does. Before this the strip could not be reached from the keyboard at all:
  // the palette only lists requests saved into a collection, so an unsaved
  // draft — which is what the + button makes — was unreachable once you left it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || e.shiftKey) return;
      if (anyLayerOpen()) return;
      const isMac = /Mac/.test(navigator.platform);
      if (!(isMac ? e.metaKey : e.ctrlKey)) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const n = Number(e.key);
      const target = n === 9 ? useStore.getState().tabs.at(-1) : useStore.getState().tabs[n - 1];
      if (!target) return;
      e.preventDefault();
      setActiveTab(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTab]);

  const close = async (id: string, dirty: boolean, label: string) => {
    // Unsaved work in a tab exists nowhere else — not on disk, not in history,
    // not in the collection — so one click on a 10px glyph used to delete an
    // arbitrary amount of typing with no question and no undo. This same app
    // asks before deleting a collection, a folder, a request, a mock and a
    // secret, all of which are recoverable by comparison.
    if (dirty) {
      const ok = await confirmDialog({
        title: "Close tab",
        message: `"${label}" has unsaved changes. Closing discards them — they are not in history and not in the collection.`,
        confirmLabel: "Discard",
        destructive: true,
      });
      if (!ok) return;
    }
    closeTab(id);
  };

  /** Left/Right move along the strip, the way a real tablist does. */
  const onStripKey = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const last = tabs.length - 1;
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? last
      : e.key === "ArrowLeft" ? Math.max(0, index - 1)
      : Math.min(last, index + 1);
    const target = tabs[next];
    if (!target) return;
    setActiveTab(target.id);
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${target.id}"]`)
      ?.focus();
  };

  return (
    <div className="flex items-center border-b border-signal-border bg-signal-panel">
      <div className="flex overflow-x-auto" role="tablist" aria-label="Open requests" ref={stripRef}>
        {tabs.map((t, i) => {
          const label = tabLabel(t.draft.name, t.draft.url);
          const active = t.id === activeTabId;
          return (
            <div
              key={t.id}
              className={`group flex items-center gap-2 pl-3 pr-1 border-r border-signal-border text-xs ${active ? "bg-signal-bg text-white" : "text-signal-muted hover:text-white"}`}
            >
              {/* A real button. It was a <div onClick> with no tabindex, so it
                  was never in the focus order and could not be activated from
                  the keyboard — while the × inside it was focusable, so you
                  could close a tab you could not switch to. */}
              <button
                type="button"
                role="tab"
                data-tab-id={t.id}
                aria-selected={active}
                // Roving tabindex: one stop for the whole strip, then arrows.
                tabIndex={active ? 0 : -1}
                // The label is clipped to 180px, so hover is the only way to
                // tell two long, similarly-named requests apart.
                title={label}
                className="flex items-center gap-2 py-1.5 cursor-pointer max-w-[240px]"
                onClick={() => setActiveTab(t.id)}
                onKeyDown={(e) => onStripKey(e, i)}
              >
                <span className={`method-pill method-${t.draft.method}`}>{t.draft.method}</span>
                <span className="max-w-[180px] truncate">{label}</span>
                {t.dirty && (
                  <span className="w-1.5 h-1.5 rounded-full bg-signal-warn" aria-label="unsaved changes" />
                )}
              </button>
              {/* Named after its tab: every close button used to be announced
                  as "×", so choosing one by ear was a guess about which
                  request you were discarding. */}
              <button
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                className="px-2 py-1.5 opacity-40 group-hover:opacity-100 focus:opacity-100 hover:text-signal-err"
                onClick={(e) => { e.stopPropagation(); void close(t.id, t.dirty, label); }}
              >×</button>
            </div>
          );
        })}
      </div>
      <button className="px-3 text-signal-muted hover:text-white" aria-label="New request" onClick={() => openDraft()}>+</button>
      <div className="ml-auto px-3 flex items-center gap-2 text-[11px] text-signal-muted">
        <button className="btn" onClick={() => setCommandPaletteOpen(!commandPaletteOpen)}>
          <span className="kbd">⌘K</span> palette
        </button>
      </div>
    </div>
  );
}
