/**
 * 9:16 güvenli alan önizlemesi. Video üzerine `src/media/safeArea.ts` dikdörtgenleri
 * çizilir; kullanıcının girdiği metin kutusu kırmızıya döner.
 *
 * ⚠️ Uyarı metni bilinçli olarak kalıcı: bu dikdörtgenler KURGUSAL YERLEŞİMDİR
 * (bkz. `SAFE_AREA_PROVENANCE`); uygulama ekranları ölçülmemiştir.
 */
import { useState } from "react";
import type { ReactNode } from "react";

import type { Platform } from "../api/types.js";
import type { TextBoxRect } from "../lib/safeAreaUi.js";
import {
  checkTextBox,
  isValidTextBox,
  percentStyle,
  redLinePercent,
  safeAreaRows,
} from "../lib/safeAreaUi.js";
import { SAFE_AREA_PROVENANCE } from "../lib/safeAreaUi.js";
import { trNumber } from "../lib/format.js";
import { SAFE_AREA_RECTS } from "./safeAreaRectangles.js";
import { PlatformBadge } from "./PlatformBits.js";
import { Badge } from "./Badge.js";
import { Button, Field, TextInput } from "./Ui.js";

const KIND_COLOR: Record<string, string> = {
  actions: "rgba(248, 81, 73, 0.30)",
  caption: "rgba(210, 153, 34, 0.28)",
  title: "rgba(88, 166, 255, 0.26)",
  audio: "rgba(139, 148, 158, 0.30)",
  bottom: "rgba(219, 138, 60, 0.24)",
};

/** Sabit 9:16 oranlı kutu; video `object-contain` ile taşmadan sığar. */
export function VerticalFrame({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="relative mx-auto w-full max-w-[280px] overflow-hidden rounded border border-line bg-black"
      style={{ aspectRatio: "9 / 16" }}
    >
      {children}
    </div>
  );
}

export function SafeAreaOverlay({
  platform,
  textBox,
}: {
  platform: Platform;
  textBox: Partial<TextBoxRect>;
}) {
  const rows = safeAreaRows(platform);
  const check = checkTextBox(textBox, platform);
  const hasBox = isValidTextBox(textBox);
  return (
    <>
      <div className="absolute inset-0" aria-hidden="true">
        {rows.map((row) => {
          const rect = SAFE_AREA_RECTS[platform][row.id];
          if (rect === undefined) return null;
          return (
            <div
              key={row.id}
              className="absolute border border-white/25"
              style={{
                ...percentStyle(rect),
                backgroundColor: KIND_COLOR[rect.kind] ?? KIND_COLOR["actions"],
              }}
            />
          );
        })}
        {hasBox ? (
          <div
            className={`absolute border-2 ${check.ok ? "border-ok" : "border-danger"}`}
            style={percentStyle(check.rect)}
          />
        ) : null}
      </div>
      <p className="sr-only">
        {rows.map((r) => `${r.label}: kare alanının yüzde ${trNumber(r.areaPercent, 1)}'i`).join(". ")}.
        {hasBox ? check.message : "Metin kutusu girilmedi."}
      </p>
    </>
  );
}

/** `describeSafeArea` çıktısı `id` veriyor; dikdörtgenin kendisi güvenli alanda. */


export function TextBoxControls({
  value,
  onChange,
  platform,
}: {
  value: Partial<TextBoxRect>;
  onChange: (next: Partial<TextBoxRect>) => void;
  platform: Platform;
}) {
  const check = checkTextBox(value, platform);
  const fields: Array<{ key: keyof TextBoxRect; label: string }> = [
    { key: "x", label: "x %" },
    { key: "y", label: "y %" },
    { key: "w", label: "genişlik %" },
    { key: "h", label: "yükseklik %" },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`tb-${f.key}`}>
            <TextInput
              id={`tb-${f.key}`}
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              value={value[f.key] === undefined || value[f.key] === null ? "" : String(value[f.key])}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                const next = { ...value };
                if (raw === "") {
                  delete next[f.key];
                  onChange(next);
                  return;
                }
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                next[f.key] = parsed;
                onChange(next);
              }}
            />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={check.ok ? "ok" : "danger"}>{check.ok ? "Güvenli alanda" : "İhlal var"}</Badge>
        <span className="text-[11px] text-fg">{check.message}</span>
        <Button
          variant="subtle"
          onClick={() => onChange({ x: 8, y: 16, w: 70, h: 12 })}
          title="Sol üste, üç platformda da ortak güvenli alan örneği"
        >
          Güvenli örnek
        </Button>
        <Button variant="subtle" onClick={() => onChange({})}>
          Temizle
        </Button>
      </div>
      {check.violations.length > 0 ? (
        <ul className="list-inside list-disc text-[11px] text-danger">
          {check.violations.map((v) => (
            <li key={v.id}>{v.label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SafeAreaSummary({ platform }: { platform: Platform }) {
  const rows = safeAreaRows(platform);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={platform} full />
        <Badge tone="warn">UI alanı karein %{trNumber(redLinePercent(platform), 1)}'ini kapatıyor</Badge>
      </div>
      <table className="w-full border-collapse text-[11px]">
        <caption className="sr-only">{platform} güvenli alan bölgeleri ve kapladıkları alan</caption>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="py-1 font-medium">
              Bölge
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Kare alanı
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-line-soft last:border-0">
              <td className="py-1 text-fg">{row.label}</td>
              <td className="py-1 text-right font-mono text-fg">%{trNumber(row.areaPercent, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-warn">⚠ {SAFE_AREA_PROVENANCE}</p>
    </div>
  );
}

/** Metin kutusu denetimi açık/kapalı (yerel durum, sunucuya gitmez). */
export function useTextBox(): [Partial<TextBoxRect>, (next: Partial<TextBoxRect>) => void] {
  const [box, setBox] = useState<Partial<TextBoxRect>>({});
  return [box, setBox];
}