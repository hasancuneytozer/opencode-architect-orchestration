/**
 * Metin alanı sınırları ve platform metinlerinin birleştirilmesi. SAF.
 *
 * KURAL: Sınırdan büyük metin KIRPILMAZ. Sessizce kırpılan bir açıklamanın
 * kullanıcı farkına varmadan kaybolmuş kısmı vardır; panel metni olduğu gibi
 * gösterir, sınırı aştığını kırmızı ile söyler ve kullanıcı düzeltir.
 */
import type { PerPlatformCopy, Platform, PlatformCopyOverride } from "../../../src/contract/index.js";
import { charUsage } from "./format.js";
import type { CharUsage } from "./format.js";

/** Sözleşmedeki zod şemalarıyla birebir aynı sınırlar. */
export const CAPTION_MAX = 2200;
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const HASHTAG_MAX = 60;
export const HASHTAG_COUNT_MAX = 30;
export const TAGS_MAX = 500;

export type CopyField = "caption" | "hashtags" | "title" | "description" | "tags";

export interface CopyFieldSpec {
  field: CopyField;
  label: string;
  max: number;
  /** Bu alan hangi platformlarda anlamlı. */
  platforms: Platform[];
  multiline: boolean;
  hint: string;
}

export const COPY_FIELDS: Record<CopyField, CopyFieldSpec> = {
  caption: {
    field: "caption",
    label: "Açıklama",
    max: CAPTION_MAX,
    platforms: ["instagram", "tiktok"],
    multiline: true,
    hint: "Instagram ve TikTok için ayrı ayrı yazılır.",
  },
  hashtags: {
    field: "hashtags",
    label: "Hashtag",
    max: HASHTAG_MAX,
    platforms: ["instagram", "tiktok"],
    multiline: false,
    hint: `Başına en fazla ${HASHTAG_MAX} karakter, en fazla ${HASHTAG_COUNT_MAX} adet.`,
  },
  title: {
    field: "title",
    label: "Başlık",
    max: TITLE_MAX,
    platforms: ["youtube"],
    multiline: false,
    hint: `Shorts başlığı. En fazla ${TITLE_MAX} karakter.`,
  },
  description: {
    field: "description",
    label: "Uzun açıklama",
    max: DESCRIPTION_MAX,
    platforms: ["youtube"],
    multiline: true,
    hint: `En fazla ${DESCRIPTION_MAX} karakter.`,
  },
  tags: {
    field: "tags",
    label: "Etiketler",
    max: HASHTAG_MAX,
    platforms: ["youtube"],
    multiline: false,
    hint: " virgülle ayrılmış etiket listesi.",
  },
};

/** Platformda görünür metin alanları (o platforma ait olanlar). */
export function fieldsForPlatform(platform: Platform): CopyFieldSpec[] {
  return (Object.keys(COPY_FIELDS) as CopyField[])
    .map((key) => COPY_FIELDS[key])
    .filter((spec) => spec.platforms.includes(platform));
}

/** Bir alanın karakter kullanımı (sayaç + yaklaşma uyarısı). */
export function usageForField(value: string | null | undefined, field: CopyField): CharUsage {
  return charUsage(value, COPY_FIELDS[field].max);
}

export function usageForHashtags(tags: readonly string[] | null | undefined): CharUsage {
  return charUsage((tags ?? []).join(" "), HASHTAG_COUNT_MAX);
}

/** "a, b, c" → ["a","b","c"]; boş ve tekrarlar temizlenir. */
export function splitTags(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim().replace(/^#/, "");
    if (tag === "") continue;
    const key = tag.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** ["a","b"] → "a, b" */
export function joinTags(tags: readonly string[]): string {
  return tags.join(", ");
}

/** Sınırı aşan alanlar var mı? (yayın öncesi uyarı için) */
export function overLimitFields(copy: PerPlatformCopy | null | undefined): string[] {
  const problems: string[] = [];
  if (!copy) return problems;
  for (const platform of ["instagram", "tiktok", "youtube"] as const) {
    const override = copy[platform];
    if (!override) continue;
    for (const spec of fieldsForPlatform(platform)) {
      const value = override[spec.field];
      const text = Array.isArray(value) ? value.join(" ") : value;
      if (typeof text !== "string") continue;
      const usage = usageForField(text, spec.field);
      if (usage.over) problems.push(`${spec.label} (${platform}): ${usage.length}/${usage.max}`);
    }
  }
  return problems;
}

/** Tek bir platformun metinini güncelle (immutable). Sunucuya yalnızca değişen gönderilir. */
export function mergeCopy(
  current: PerPlatformCopy,
  platform: Platform,
  patch: PlatformCopyOverride,
): PerPlatformCopy {
  const base = current[platform] ?? {};
  return { ...current, [platform]: { ...base, ...patch } };
}

/** Bir platformun tek bir metin alanını oku. */
export function readField(copy: PerPlatformCopy, platform: Platform, field: CopyField): string {
  const override = copy[platform];
  if (!override) return "";
  const value = override[field];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return joinTags(value);
  return "";
}

/** Etiket listesini string'den oku (yayına giden biçim dizi). */
export function readTags(copy: PerPlatformCopy, platform: Platform, field: "hashtags" | "tags"): string[] {
  const override = copy[platform];
  if (!override) return [];
  const value = override[field];
  return Array.isArray(value) ? value : [];
}