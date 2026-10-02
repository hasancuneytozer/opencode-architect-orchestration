/**
 * Doğrulama bulgularını sunucudan alıp okunur hale getirme. SAF.
 *
 * En önemli kural: **geçici (provisional) sınırlar saklanmaz.** Resmî dokümanla
 * doğrulanmamış bir sınır `provisional: true` taşır; panel bunu "henüz
 * doğrulanmadı" rozetiyle gösterir. Aksi halde kullanıcı geçici bir kurala
 * güvenip yayın hatasına düşer.
 */
import type { Platform, Severity, ValidationFinding } from "../../../src/contract/index.js";

export type FindingGroups = Record<Severity, ValidationFinding[]>;

export const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "info"];

export function emptyGroups(): FindingGroups {
  return { error: [], warning: [], info: [] };
}

/** Bulguları şiddete göre üç gruba ayır. Girdi sırası korunur. */
export function groupBySeverity(findings: readonly ValidationFinding[] | null | undefined): FindingGroups {
  const groups = emptyGroups();
  for (const finding of findings ?? []) {
    if (finding.severity === "error" || finding.severity === "warning" || finding.severity === "info") {
      groups[finding.severity].push(finding);
    }
  }
  return groups;
}

export function filterBySeverity(
  findings: readonly ValidationFinding[] | null | undefined,
  severity: Severity,
): ValidationFinding[] {
  return (findings ?? []).filter((f) => f.severity === severity);
}

export function countBySeverity(findings: readonly ValidationFinding[] | null | undefined): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings ?? []) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

/** `provisional === true` olan bulgular. */
export function provisionalFindings(findings: readonly ValidationFinding[] | null | undefined): ValidationFinding[] {
  return (findings ?? []).filter((f) => f.provisional === true);
}

export function countProvisional(findings: readonly ValidationFinding[] | null | undefined): number {
  return provisionalFindings(findings).length;
}

/**
 * "Yayına hazır" kararı. Tek bir `error` varsa HAYIR — uyarı ve bilgi engel
 * değildir. Bu, panelin en çok yanıltıcı olabileceği yerdir; eşiksiz kural bilerek
 * sadeleştirilmiştir: `error` → yayınlanmaz, `warning` → yayınlanır ama uyarılır.
 */
export function isPublishReady(findings: readonly ValidationFinding[] | null | undefined): boolean {
  return (findings ?? []).every((f) => f.severity !== "error");
}

export interface FindingSummary {
  errors: number;
  warnings: number;
  infos: number;
  provisional: number;
  total: number;
  ready: boolean;
}

export function summarize(findings: readonly ValidationFinding[] | null | undefined): FindingSummary {
  const counts = countBySeverity(findings);
  const list = findings ?? [];
  return {
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    provisional: countProvisional(list),
    total: list.length,
    ready: isPublishReady(list),
  };
}

/**
 * Bulgunun "ölçülen ↔ sınır" satırı. Alanlardan biri yoksa yalnızca olan yazılır;
 * alan uydurulmaz.
 */
export function findingDetail(finding: ValidationFinding): string {
  const parts: string[] = [];
  if (finding.observed !== undefined && finding.observed !== "") parts.push(`ölçülen ${finding.observed}`);
  if (finding.limit !== undefined && finding.limit !== "") parts.push(`sınır ${finding.limit}`);
  if (parts.length === 0) return finding.message;
  return `${finding.message} (${parts.join(" · ")})`;
}

/** Bulguları okunur sıraya dizer: hata → uyarı → bilgi, sonra kod. */
export function sortFindings(findings: readonly ValidationFinding[] | null | undefined): ValidationFinding[] {
  const weight = (s: Severity): number => {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  return [...(findings ?? [])].sort((a, b) => {
    const d = weight(a.severity) - weight(b.severity);
    if (d !== 0) return d;
    return a.code.localeCompare(b.code, "tr");
  });
}

/** Bulgu kodu → insan dili başlığı (bulgu `code`'u ham bir makine adıdır). */
export const FINDING_CODE_LABELS: Readonly<Record<string, string>> = {
  aspect_ratio: "En boy oranı",
  duration_max: "Azami süre",
  duration_min: "Asgari süre",
  fps_range: " Kare hızı aralığı",
  resolution_min: "Asgari çözünürlük",
  resolution_max: "Azami çözünürlük",
  resolution: "Çözünürlük",
  container: "Kapsayıcı biçimi",
  video_codec: "Video kodeği",
  audio_codec: "Ses kodeği",
  pixel_format: "Piksel biçimi",
  bitrate_max: "Azami bit hızı",
  file_size_max: "Azami dosya boyutu",
  has_audio: "Ses kanalı",
  orientation: "Yön (dikey/yatay)",
  width: "Genişlik",
  height: "Yükseklik",
};

export function findingCodeLabel(code: string): string {
  return FINDING_CODE_LABELS[code] ?? code;
}

/** Platform raporundan tek satır özet. */
export interface PlatformReportRow {
  platform: Platform;
  findings: ValidationFinding[];
  summary: FindingSummary;
  provisionalCodes: string[];
}

export function platformReport(
  platform: Platform,
  findings: readonly ValidationFinding[] | null | undefined,
): PlatformReportRow {
  const list = findings ?? [];
  return {
    platform,
    findings: sortFindings(list),
    summary: summarize(list),
    provisionalCodes: provisionalFindings(list).map((f) => f.code),
  };
}