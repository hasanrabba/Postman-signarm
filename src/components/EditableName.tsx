"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onSave: (next: string) => void;
  /** Class applied to the display span. */
  className?: string;
  /** Class applied to the input once editing. */
  inputClassName?: string;
  /** If true the component starts in edit mode (e.g. just-created nodes). */
  editingInitially?: boolean;
  /** Optional hook fired when editing begins; used by the sidebar to make
   *  room / widen the row if needed. */
  onEditStart?: () => void;
  /** Optional hook fired when editing ends (committed or cancelled). */
  onEditEnd?: () => void;
  ariaLabel?: string;
}

/**
 * Inline rename control. Shows the value as a span by default; a double
 * click (or keyboard F2 when focused) flips it to an input. Enter commits,
 * Escape cancels, blur commits. Empty strings are discarded so users can't
 * lose the name by accidentally selecting all and pressing Enter.
 */
export function EditableName({
  value, onSave, className, inputClassName,
  editingInitially = false, onEditStart, onEditEnd, ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(editingInitially);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => {
    if (editing) {
      onEditStart?.();
      // Defer select so it runs after autofocus.
      queueMicrotask(() => ref.current?.select());
    } else {
      onEditEnd?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    setEditing(false);
  };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <span
        className={className}
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Double-click to rename"
        aria-label={ariaLabel}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      ref={ref}
      className={inputClassName ?? "input !py-0 !text-sm"}
      autoFocus
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
