"use client";

import { useEffect, useState, useCallback } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

// Module-level state so any component can call `confirmDialog(...)`. The
// <ConfirmDialogHost/> mounted at the app root subscribes to the store and
// renders the modal. Returning a promise that resolves to a boolean gives
// callers the same ergonomics as window.confirm but styled inside the app.
let listeners: Array<(open: boolean, opts?: ConfirmOptions) => void> = [];
let resolveCurrent: ((v: boolean) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // If a dialog is already open, auto-cancel it.
  if (resolveCurrent) { resolveCurrent(false); resolveCurrent = null; }
  return new Promise<boolean>((resolve) => {
    resolveCurrent = resolve;
    for (const l of listeners) l(true, opts);
  });
}

function notifyClose(result: boolean) {
  if (resolveCurrent) { resolveCurrent(result); resolveCurrent = null; }
  for (const l of listeners) l(false);
}

export function ConfirmDialogHost() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);

  const subscribe = useCallback((o: boolean, next?: ConfirmOptions) => {
    setOpen(o);
    if (o && next) setOpts(next);
    if (!o) setOpts(null);
  }, []);

  useEffect(() => {
    listeners.push(subscribe);
    return () => {
      listeners = listeners.filter((l) => l !== subscribe);
    };
  }, [subscribe]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); notifyClose(false); }
      if (e.key === "Enter")  { e.preventDefault(); notifyClose(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !opts) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="signal-confirm-title"
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center"
      onClick={() => notifyClose(false)}
    >
      <div
        className="w-[420px] bg-signal-panel border border-signal-border rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="signal-confirm-title" className="px-4 py-2 border-b border-signal-border font-medium">
          {opts.title}
        </div>
        <div className="px-4 py-3 text-sm whitespace-pre-line">
          {opts.message}
        </div>
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-signal-border">
          <button className="btn" onClick={() => notifyClose(false)}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={opts.destructive
              ? "btn-primary !bg-signal-err"
              : "btn-primary"}
            onClick={() => notifyClose(true)}
            autoFocus
          >
            {opts.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
