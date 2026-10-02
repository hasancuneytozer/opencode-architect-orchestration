/**
 * Kalıcı durum çubuğu ve **SAHTE YAYIN MODU** şeridi.
 *
 * Şerit kasıtlı olarak kapatılamaz: `mode === "mock"` iken hiçbir yayın gerçek
 * değildir ve kullanıcı bunu ekranın en üstünde, her sayfada görmelidir.
 * Bir panelin en önemli dürüstlük göstergesidir; tasarım gereği göz ardı
 * edilemeyecek şekilde yerleştirilmiştir.
 */
import type { HealthSummary } from "../lib/apiShape.js";
import type { StatusRow } from "../lib/apiShape.js";
import { formatDurationSec } from "../lib/format.js";
import { Badge } from "./Badge.js";

/** Mock mod şeridi. Sunucuya bağlanılamadığında da gösterilir (daha kötü bir durum). */
export function MockModeRibbon({
  mode,
  serverDown = false,
}: {
  mode: "mock" | "live" | null;
  serverDown?: boolean;
}) {
  if (serverDown) {
    return (
      <div
        role="alert"
        className="sticky top-0 z-40 border-b border-danger/60 bg-danger/20 px-3 py-2 text-[12px] font-bold tracking-wide text-danger"
      >
        SUNUCUYA ULAŞILAMIYOR — panel veri gösteremiyor. API çalışmıyor olabilir; yayın durumu
        HAKKINDA HİÇBİR ŞEY BİLİNMEZ.
      </div>
    );
  }
  if (mode !== "mock") return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="sticky top-0 z-40 border-b-2 border-warn bg-warn/20 px-3 py-2 text-[13px] font-bold tracking-wide text-warn"
    >
      SAHTE YAYIN MODU — hiçbir içerik gerçekten Instagram/TikTok/YouTube'a
      yayınlanmıyor. Yayın durumu ekrandaki gibi görünür, gerçek değildir.
    </div>
  );
}

export function HealthBar({ health, version }: { health: HealthSummary; version: string | null }) {
  const dbTone =
    health.db === null ? "idle" : /ok|ready|up|open|connected/i.test(health.db) ? "ok" : "warn";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1.5 text-[11px]">
      <Badge tone={health.mode === "live" ? "ok" : health.mode === "mock" ? "warn" : "idle"}>
        {health.mode === "live" ? "Canlı mod" : health.mode === "mock" ? "Sahte mod (mock)" : "Mod bilinmiyor"}
      </Badge>
      <span className="text-muted">
        sürüm <span className="font-mono text-fg">{version ?? "—"}</span>
      </span>
      <span className="text-muted">
        veritabanı{" "}
        <Badge tone={dbTone}>{health.db ?? "bilinmiyor"}</Badge>
      </span>
      <span className="text-muted">
        çalışma süresi <span className="font-mono text-fg">{formatDurationSec(health.uptimeSec)}</span>
      </span>
    </div>
  );
}

export function StatusTable({ rows, caption }: { rows: StatusRow[]; caption: string }) {
  if (rows.length === 0) {
    return <p className="px-1 py-2 text-[12px] text-muted">Sunucudan durum alanı gelmedi.</p>;
  }
  return (
    <table className="w-full border-collapse text-[12px]">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-b border-line-soft last:border-0">
            <th scope="row" className="w-1/2 py-1 text-left font-normal text-muted">
              {row.label}
            </th>
            <td className={`py-1 text-right font-mono ${row.warn ? "text-danger" : "text-fg"}`}>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}