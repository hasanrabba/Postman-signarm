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
