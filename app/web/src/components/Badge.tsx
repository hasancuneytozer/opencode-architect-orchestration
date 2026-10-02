import type { ReactNode } from "react";

import type { Tone } from "../lib/labels.js";

/** Ton → sınıf. Renk TEK BAŞINA anlam taşımaz; rozet her zaman metin içerir. */
const TONE_CLASS: Record<Tone, string> = {
  idle: "border-idle/40 bg-idle/10 text-idle",
  info: "border-info/40 bg-info/10 text-info",
  progress: "border-info/40 bg-info/10 text-info sp-live",
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  orange: "border-orange/40 bg-orange/10 text-orange",
  danger: "border-danger/40 bg-danger/10 text-danger",
  muted: "border-line bg-elev text-faint",
  accent: "border-accent/40 bg-accent-soft text-accent",
};

export function toneClass(tone: Tone): string {
  return TONE_CLASS[tone];
}

export interface BadgeProps {
  tone: Tone;
  children: ReactNode;
  title?: string;
  /** Canlı/ilerleyen durumlarda `aria-live` eklenir. */
  live?: boolean;
  className?: string;
}

/** Her rozet metin içerir; ekran okuyucu renkten bağımsız bilgi alır. */
export function Badge({ tone, children, title, live = false, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${toneClass(tone)} ${className}`}
      title={title}
      {...(live ? { "aria-live": "polite" as const } : {})}
    >
      {children}
    </span>
  );
}

export interface CopyableKeyProps {
  /** `.env` anahtarı. */
  envKey: string;
}

/** `.env` anahtarı tıklanınca panoya kopyalanır (yapılandırma ekranında). */
export function CopyableKey({ envKey }: CopyableKeyProps) {
  return (
    <button
      type="button"
      aria-label={`${envKey} değerini kopyala`}
      title="Panoya kopyala"
      onClick={() => {
        void navigator.clipboard?.writeText(envKey).catch(() => undefined);
      }}
      className="rounded border border-line bg-elev px-1.5 py-0.5 font-mono text-[11px] text-accent hover:border-accent/60"
    >
      {envKey}
    </button>
  );
}