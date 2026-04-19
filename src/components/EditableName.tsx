"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface EditableNameHandle {
  /** Flip the control into edit mode from outside (e.g. an icon button). */
  startEditing: () => void;
}

interface Props {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  inputClassName?: string;
  editingInitially?: boolean;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  ariaLabel?: string;
}

/**
 * Inline rename control. Span by default; double-click (or an external
 * .startEditing() call) flips it to an input. Enter commits, Escape
 * cancels, blur commits, empty/whitespace-only values are discarded so the
 * user can't accidentally blank a name.
 */
export const EditableName = forwardRef<EditableNameHandle, Props>(
  function EditableName(
    { value, onSave, className, inputClassName,
      editingInitially = false, onEditStart, onEditEnd, ariaLabel },
    ref
  ) {
    const [editing, setEditing] = useState(editingInitially);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(ref, () => ({
      startEditing: () => setEditing(true),
    }), []);

    useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
    useEffect(() => {
      if (editing) {
        onEditStart?.();
        queueMicrotask(() => inputRef.current?.select());
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
        ref={inputRef}
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
);
