"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyValue } from "@/lib/types";
import { uid } from "@/lib/id";
import { isSecretHeaderName, isSecretParamName, maskValue } from "@/lib/secrets";

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  showDescription?: boolean;
  /** When true, rows with a header-style key are auto-treated as secret. */
  secretDetect?: "headers" | "params" | "none";
}

export function KVEditor({
  rows, onChange,
  keyPlaceholder = "key", valuePlaceholder = "value",
  showDescription, secretDetect = "none",
}: Props) {
  const visible = [...rows, { id: "__new", key: "", value: "", enabled: true } as KeyValue];
  // The trailing blank row is a placeholder, not a real row. The first
  // keystroke in it promotes it to a real row — and focus has to follow, or
  // the caret stays in the (now re-blanked) placeholder and every further
  // keystroke creates another row: typing "X-Trace" produced seven headers.
  const [handoff, setHandoff] = useState<{ id: string; field: keyof KeyValue } | null>(null);

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (id === "__new") {
      const created = { id: uid("kv"), key: "", value: "", enabled: true, ...patch };
      onChange([...rows, created]);
      const field = Object.keys(patch)[0] as keyof KeyValue;
      if (field === "key" || field === "value" || field === "description") {
        setHandoff({ id: created.id, field });
      }
      return;
    }
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));

  const autoSecret = (key: string) => {
    if (secretDetect === "headers") return isSecretHeaderName(key);
    if (secretDetect === "params") return isSecretParamName(key);
    return false;
  };

  return (
    <div className="border border-signal-border rounded overflow-hidden">
      <div className="grid grid-cols-[24px_1fr_1fr_132px] text-xs bg-signal-panel px-2 py-1 text-signal-muted">
        <div />
        <div>Key</div>
        <div>Value</div>
        <div className="text-right">Actions</div>
      </div>
      {visible.map((r) => {
        const isSecret = Boolean(r.secret) || autoSecret(r.key);
        return (
          <KVRow
            key={r.id}
            row={r}
            placeholderKey={keyPlaceholder}
            placeholderValue={valuePlaceholder}
            isSecret={isSecret}
            showDescription={showDescription}
            onUpdate={update}
            onRemove={remove}
            focusField={handoff?.id === r.id ? handoff.field : undefined}
            onFocusHandled={() => setHandoff(null)}
          />
        );
      })}
    </div>
  );
}

function KVRow({
  row, placeholderKey, placeholderValue, isSecret, showDescription, onUpdate, onRemove,
  focusField, onFocusHandled,
}: {
  row: KeyValue;
  placeholderKey: string;
  placeholderValue: string;
  isSecret: boolean;
  showDescription?: boolean;
  onUpdate: (id: string, patch: Partial<KeyValue>) => void;
  onRemove: (id: string) => void;
  focusField?: keyof KeyValue;
  onFocusHandled?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const isNew = row.id === "__new";
  // Mask a secret value at rest, but never while the field has focus.
  // maskValue() is lossy — it returns bullets — so a masked field that was
  // also editable would write bullets back as the value. That is why this
  // used to be readOnly, and that is what made the field untypeable:
  // auto-detection fires on the key name alone, so typing "Authorization"
  // locked the value box before anything had been put in it. Revealing on
  // focus keeps the shoulder-surf protection where it matters (at rest)
  // and removes the need to lock the field at all.
  const hidden = isSecret && !revealed && !isNew && !focused;
  const keyRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef<HTMLInputElement | null>(null);
  const descRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focusField) return;
    const el =
      focusField === "key" ? keyRef.current
      : focusField === "value" ? valueRef.current
      : descRef.current;
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
    onFocusHandled?.();
  }, [focusField, onFocusHandled]);

  return (
    <div className="grid grid-cols-[24px_1fr_1fr_132px] items-center gap-1 px-2 py-1 border-t border-signal-border">
      <input
        type="checkbox"
        checked={row.enabled}
        onChange={(e) => onUpdate(row.id, { enabled: e.target.checked })}
        className="accent-signal-accent"
        aria-label="Toggle enabled"
      />
      <input
        ref={keyRef}
        className="input"
        value={row.key}
        placeholder={placeholderKey}
        onChange={(e) => onUpdate(row.id, { key: e.target.value })}
      />
      <input
        ref={valueRef}
        className="input"
        type={hidden ? "password" : "text"}
        value={hidden ? maskValue(row.value) : row.value}
        placeholder={placeholderValue}
        onChange={(e) => onUpdate(row.id, { value: e.target.value })}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <div className="flex items-center justify-end gap-1">
        {!isNew && (
          <>
            <button
              type="button"
              className="text-[10px] whitespace-nowrap text-signal-muted hover:text-white px-1 rounded border border-signal-border"
              title={row.secret ? "Unmark as secret" : "Mark value as secret"}
              aria-label={row.secret ? "Unmark secret" : "Mark as secret"}
              onClick={() => onUpdate(row.id, { secret: !row.secret })}
            >
              {row.secret ? "secret" : "mark secret"}
            </button>
            {isSecret && (
              <button
                type="button"
                className="text-[10px] text-signal-muted hover:text-white px-1"
                title={revealed ? "Hide value" : "Reveal value"}
                aria-label={revealed ? "Hide value" : "Reveal value"}
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? "hide" : "show"}
              </button>
            )}
            <button
              type="button"
              className="text-signal-muted hover:text-signal-err px-1"
              title="Remove"
              aria-label="Remove row"
              onClick={() => onRemove(row.id)}
            >×</button>
          </>
        )}
      </div>
      {showDescription && !isNew && (
        <input
          ref={descRef}
          className="input col-span-4 mt-1"
          placeholder="description"
          value={row.description ?? ""}
          onChange={(e) => onUpdate(row.id, { description: e.target.value })}
        />
      )}
    </div>
  );
}
