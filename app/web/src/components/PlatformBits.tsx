import { useEffect, useState } from "react";

import type { Platform } from "../api/types.js";
import { PLATFORM_META } from "../lib/labels.js";
import { Badge } from "./Badge.js";

export function PlatformBadge({ platform, full = false }: { platform: Platform; full?: boolean }) {
  const meta = PLATFORM_META[platform];
  return (
    <Badge tone={meta.tone} className={meta.className} title={meta.label}>
      <span aria-hidden="true">{meta.short}</span>
      <span className="sr-only">Platform: </span>
      <span>{full ? meta.label : meta.short}</span>
    </Badge>
  );
}

/**
 * Zaman dilimi seçici. Sınırlı bir liste + serbest metin girişi: IANA adı
 * ("Europe/Istanbul") yazılabilir, çünkü sözleşme yalnız IANA adı kabul ediyor.
 */
export const COMMON_TIMEZONES = [
  "Europe/Istanbul",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Amsterdam",
  "Europe/Paris",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "UTC",
];

export function isValidTimeZoneName(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function TimeZonePicker({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  id: string;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const shown = custom === null ? value : custom;
  const invalid = !isValidTimeZoneName(shown);

  useEffect(() => {
    setCustom(null);
  }, [value]);

  return (
    <div className="flex items-center gap-1.5">
      <select
        id={id}
        value={custom === null && COMMON_TIMEZONES.includes(value) ? value : "__custom__"}
        onChange={(e) => {
          const next = e.currentTarget.value;
          if (next === "__custom__") {
            setCustom(COMMON_TIMEZONES.includes(value) ? "" : value);
            return;
          }
          setCustom(null);
          onChange(next);
        }}
        className="rounded border border-line bg-elev px-2 py-1.5 text-[12px] text-fg"
      >
        {COMMON_TIMEZONES.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
        <option value="__custom__">Diğer (yaz)…</option>
      </select>
      {custom === null ? null : (
        <input
          type="text"
          value={custom}
          aria-label="IANA saat dilimi adı"
          aria-invalid={invalid}
          placeholder="Europe/Istanbul"
          onChange={(e) => {
            setCustom(e.currentTarget.value);
            if (isValidTimeZoneName(e.currentTarget.value)) onChange(e.currentTarget.value);
          }}
          className={`w-44 rounded border bg-elev px-2 py-1.5 font-mono text-[12px] ${
            invalid ? "border-danger/60 text-danger" : "border-line text-fg"
          }`}
        />
      )}
      {invalid && custom !== null ? (
        <span className="text-[11px] text-danger">Geçerli IANA adı değil (örn. Europe/Istanbul)</span>
      ) : null}
    </div>
  );
}