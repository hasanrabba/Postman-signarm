"use client";

import { useEffect, useSyncExternalStore } from "react";
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
  const { tabs, activeTabId, openDraft, runnerCollectionId, closeRunner } = useStore();
  const active = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    void useStore.persist.rehydrate();
  }, []);

  // The mocks themselves are persisted, but the registry that answers them
  // lives in memory — in the route module on the web, in the Tokio server on
  // the desktop. Without this, a restart left the sidebar listing a mock and
  // all its routes while every request to it 404'd, and the UI looked exactly
  // like a working one. Republished once per load, so the server always
  // reflects what the app remembers.
  useEffect(() => {
    if (!hydrated) return;
    const live = Object.values(useStore.getState().mocks).filter((m) => m.routes.length > 0);
    if (live.length === 0) return;
    void import("@/lib/transport").then(({ registerMock }) => {
      for (const m of live) void registerMock(m.id, m.routes);
    });
  }, [hydrated]);

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
      </main>
      <CommandPalette />
      <ConfirmDialogHost />
      {runnerCollectionId && (
        <Runner collectionId={runnerCollectionId} onClose={closeRunner} />
      )}
    </div>
  );
}
