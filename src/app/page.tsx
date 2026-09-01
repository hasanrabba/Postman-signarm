"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Tabs } from "@/components/Tabs";
import { RequestBuilder } from "@/components/RequestBuilder";
import { ResponseViewer } from "@/components/ResponseViewer";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import { Runner } from "@/components/Runner";
import { useStore } from "@/lib/store";

export default function Home() {
  // Subscribe to the persist middleware's own hydration flag rather than
  // mirroring it into local state: setState inside an effect body triggers a
  // cascading render, and this also stops us reporting "hydrated" before
  // rehydrate() has actually finished.
  const hydrated = useSyncExternalStore(
    (cb) => useStore.persist.onFinishHydration(cb),
    () => useStore.persist.hasHydrated(),
    () => false
  );
  const { tabs, activeTabId, openDraft, collectionOrder } = useStore();
  const active = tabs.find((t) => t.id === activeTabId);
  const [runner, setRunner] = useState<string | undefined>(undefined);

  useEffect(() => {
    void useStore.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (hydrated && useStore.getState().tabs.length === 0) {
      openDraft({ name: "My first request", url: "https://httpbin.org/get" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-screen text-signal-muted text-sm">
        Loading Signarm Signal…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-signal-bg text-signal-text">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 relative">
        <Tabs />
        {active ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="grid grid-rows-[auto_1fr] min-h-0 overflow-hidden">
              <RequestBuilder tab={active} />
            </div>
            <div className="border-t border-signal-border flex-1 min-h-0 flex flex-col">
              <ResponseViewer tab={active} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-signal-muted">
            No tab open. Press <span className="kbd mx-1">⌘K</span> or click + to start.
          </div>
        )}
        {collectionOrder.length > 0 && (
          <div className="absolute bottom-2 right-2 flex gap-2">
            <button
              className="btn"
              onClick={() => setRunner(collectionOrder[0])}
              title="Run collection"
            >▶ Run first collection</button>
          </div>
        )}
      </main>
      <CommandPalette />
      <ConfirmDialogHost />
      {runner && <Runner collectionId={runner} onClose={() => setRunner(undefined)} />}
    </div>
  );
}
