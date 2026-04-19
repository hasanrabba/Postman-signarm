"use client";

import { useState } from "react";
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

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (id === "__new") {
      onChange([...rows, { id: uid("kv"), key: "", value: "", enabled: true, ...patch }]);
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
      <div className="grid grid-cols-[24px_1fr_1fr_72px] text-xs bg-signal-panel px-2 py-1 text-signal-muted">
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
          />
        );
      })}
    </div>
  );
}

function KVRow({
  row, placeholderKey, placeholderValue, isSecret, showDescription, onUpdate, onRemove,
}: {
  row: KeyValue;
  placeholderKey: string;
  placeholderValue: string;
  isSecret: boolean;
  showDescription?: boolean;
  onUpdate: (id: string, patch: Partial<KeyValue>) => void;
  onRemove: (id: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const isNew = row.id === "__new";

  return (
    <div className="grid grid-cols-[24px_1fr_1fr_72px] items-center gap-1 px-2 py-1 border-t border-signal-border">
      <input
        type="checkbox"
        checked={row.enabled}
        onChange={(e) => onUpdate(row.id, { enabled: e.target.checked })}
        className="accent-signal-accent"
        aria-label="Toggle enabled"
      />
      <input
        className="input"
        value={row.key}
        placeholder={placeholderKey}
        onChange={(e) => onUpdate(row.id, { key: e.target.value })}
      />
      <input
        className="input"
        type={isSecret && !revealed && !isNew ? "password" : "text"}
        value={isSecret && !revealed && !isNew ? maskValue(row.value) : row.value}
        placeholder={placeholderValue}
        onChange={(e) => onUpdate(row.id, { value: e.target.value })}
        readOnly={isSecret && !revealed && !isNew}
      />
      <div className="flex items-center justify-end gap-1">
        {!isNew && (
          <>
            <button
              type="button"
              className="text-[10px] text-signal-muted hover:text-white px-1 rounded border border-signal-border"
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
          className="input col-span-4 mt-1"
          placeholder="description"
          value={row.description ?? ""}
          onChange={(e) => onUpdate(row.id, { description: e.target.value })}
        />
      )}
    </div>
  );
}
