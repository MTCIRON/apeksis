// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { DecodingMethod } from "../engine";
import { OPT, OPT_NOTE, OPT_TEXT, OPT_TITLE, Select } from "./Select";

/** Bars lit per method: one, two or three. */
const LEVEL: Record<DecodingMethod, number> = { greedy: 1, beam: 2, "beam-lm": 3 };
const BAR_HEIGHTS = ["h-1.5", "h-2.5", "h-3.5"];

const METHODS: { value: DecodingMethod; label: string; note: string }[] = [
  { value: "beam-lm", label: "En doğru", note: "Dil modeliyle; özel adlarda ve uzun cümlelerde daha az hata." },
  { value: "beam", label: "Dengeli", note: "Dil modeli olmadan, dört yollu arama." },
  { value: "greedy", label: "Hızlı", note: "Tek yollu arama, en kısa sürede biter." },
];

export function MethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: DecodingMethod;
  onChange: (m: DecodingMethod) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      label="Doğruluk"
      value={value}
      options={METHODS}
      onChange={onChange}
      disabled={disabled}
      render={(o, inList) => (
        <span className={OPT}>
          <span className="flex h-3.5 flex-none items-end gap-0.5" aria-hidden>
            {BAR_HEIGHTS.map((h, i) => (
              <span key={h} className={`w-1 rounded-[1px] ${h} ${i < LEVEL[o.value] ? "bg-wave-played" : "bg-line"}`} />
            ))}
          </span>
          <span className={OPT_TEXT}>
            <span className={OPT_TITLE}>{o.label}</span>
            {inList && <span className={OPT_NOTE}>{METHODS.find((m) => m.value === o.value)!.note}</span>}
          </span>
        </span>
      )}
    />
  );
}

export const methodTitle = (id: DecodingMethod) => METHODS.find((m) => m.value === id)!.label;
