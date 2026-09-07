"use client";

import { useEffect, useRef } from "react";

/**
 * Which modal is on top.
 *
 * The palette, the confirm dialog and the collection runner each listen on
 * window for keys, and none of them knew about the others. With a confirm open
 * and the palette opened over it, one Escape dismissed BOTH — and one Enter ran
 * the highlighted command AND confirmed the dialog underneath, so pressing
 * Enter in the palette deleted a mock server.
 *
 * A layer registers while it is open and only acts on a key when it is the one
 * on top.
 */
const stack: symbol[] = [];

function push(): symbol {
  const token = Symbol("layer");
  stack.push(token);
  return token;
}

function pop(token: symbol): void {
  const i = stack.lastIndexOf(token);
  if (i !== -1) stack.splice(i, 1);
}

/**
 * Is any modal open at all?
 *
 * For handlers that belong to the page underneath rather than to a layer: the
 * request builder's send and save fired through an open palette, so a ⌘Enter
 * typed at the palette sent a request the user had not asked for — and with a
 * confirm dialog up it both sent the request and answered the dialog.
 */
export function anyLayerOpen(): boolean {
  return stack.length > 0;
}

/**
 * Register while `active`, and get back a predicate to call from inside a key
 * handler. It is a function rather than a boolean so the answer is read when
 * the key is pressed, not captured when the handler was attached.
 */
export function useTopLayer(active: boolean): () => boolean {
  const token = useRef<symbol | null>(null);
  useEffect(() => {
    if (!active) return;
    const t = push();
    token.current = t;
    return () => {
      pop(t);
      token.current = null;
    };
  }, [active]);
  return () => token.current !== null && stack[stack.length - 1] === token.current;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Keep the keyboard inside a modal, and give it back afterwards.
 *
 * Nothing trapped Tab, so one Shift+Tab from the open command palette put the
 * cursor in a Params field behind it and everything typed after that was
 * written silently into the request. The confirm dialog was worse: seven tabs
 * reached the sidebar's search box, and its window-level Enter handler then
 * answered "yes" to a question about deleting a collection.
 *
 * Closing dropped focus on the body, so the next thing typed went nowhere at
 * all — the user had to click back into the field they had been in.
 *
 * Returns a ref to put on the modal's outermost element.
 */
export function useModalFocus<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    // Read here, not in a later effect, and only because nothing inside has
    // taken focus yet: React applies `autoFocus` while it commits, which is
    // before this runs, so a modal that used it left us pointing at its own
    // input. Mark the element to start on with `data-modal-autofocus` instead.
    const previously = document.activeElement as HTMLElement | null;

    // No visibility filtering: jsdom reports every element as unrendered, and
    // a modal's contents are on screen by definition.
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    if (node && !node.contains(document.activeElement)) {
      (node.querySelector<HTMLElement>("[data-modal-autofocus]") ?? focusable()[0])?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !node) return;
      const list = focusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (!current || !node.contains(current)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && current === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
    };
    // Captured, so it runs before anything inside the modal sees the Tab.
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previously && previously !== document.body && document.contains(previously)) {
        previously.focus?.();
      }
    };
  }, [active]);

  return ref;
}
