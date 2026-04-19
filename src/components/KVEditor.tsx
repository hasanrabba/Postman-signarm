"use client";

import type { KeyValue } from "@/lib/types";
import { uid } from "@/lib/id";

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  showDescription?: boolean;
}

export function KVEditor({ rows, onChange, keyPlaceholder = "key", valuePlaceholder = "value", showDescription }: Props) {
  const visible = [...rows, { id: "__new", key: "", value: "", enabled: true } as KeyValue];

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (id === "__new") {
      onChange([...rows, { id: uid("kv"), key: "", value: "", enabled: true, ...patch }]);
      return;
    }
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));

  return (
    <div className="border border-signal-border rounded overflow-hidden">
      <div className="grid grid-cols-[24px_1fr_1fr_24px] text-xs bg-signal-panel px-2 py-1 text-signal-muted">
        <div />
        <div>Key</div>
        <div>Value</div>
        <div />
      </div>
      {visible.map((r) => (
        <div key={r.id} className="grid grid-cols-[24px_1fr_1fr_24px] items-center gap-1 px-2 py-1 border-t border-signal-border">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
            className="accent-signal-accent"
          />
          <input
            className="input"
            value={r.key}
            placeholder={keyPlaceholder}
            onChange={(e) => update(r.id, { key: e.target.value })}
          />
          <input
            className="input"
            value={r.value}
            placeholder={valuePlaceholder}
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          {r.id !== "__new" ? (
            <button className="text-signal-muted hover:text-signal-err" onClick={() => remove(r.id)}>×</button>
          ) : (
            <span />
          )}
          {showDescription && r.id !== "__new" && (
            <input
              className="input col-span-4 mt-1"
              placeholder="description"
              value={r.description ?? ""}
              onChange={(e) => update(r.id, { description: e.target.value })}
            />
          )}
        </div>
      ))}
    </div>
  );
}
