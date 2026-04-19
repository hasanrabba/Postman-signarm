"use client";

import { useStore } from "@/lib/store";

export function Tabs() {
  const { tabs, activeTabId, setActiveTab, closeTab, openDraft, commandPaletteOpen, setCommandPaletteOpen } = useStore();
  return (
    <div className="flex items-center border-b border-signal-border bg-signal-panel">
      <div className="flex overflow-x-auto">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-2 px-3 py-1.5 border-r border-signal-border text-xs cursor-pointer ${t.id === activeTabId ? "bg-signal-bg text-white" : "text-signal-muted hover:text-white"}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className={`method-pill method-${t.draft.method}`}>{t.draft.method}</span>
            <span className="max-w-[180px] truncate">{t.draft.name || t.draft.url || "Untitled"}</span>
            {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-signal-warn" />}
            <button
              className="opacity-40 group-hover:opacity-100 hover:text-signal-err"
              onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
            >×</button>
          </div>
        ))}
      </div>
      <button className="px-3 text-signal-muted hover:text-white" onClick={() => openDraft()}>+</button>
      <div className="ml-auto px-3 flex items-center gap-2 text-[11px] text-signal-muted">
        <button className="btn" onClick={() => setCommandPaletteOpen(!commandPaletteOpen)}>
          <span className="kbd">⌘K</span> palette
        </button>
      </div>
    </div>
  );
}
