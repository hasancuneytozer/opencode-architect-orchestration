/**
 * Video yükleme ÇEKİRDEĞİ — tamamen saf: DOM, ağ ve zamanlayıcı YOK.
 *
 * Neden ayrı dosya: yükleme alanındaki HER karar burada test edilir. React
 * bileşeni yalnız bu fonksiyonları çağırır; "kabul edilecek mi", "yüzde kaç",
 * "hangi Türkçe mesaj" sorularının cevabı DOM'a gömülü kalırsa test edilemez
 * (jsdom kurmak da bu pakette bilinçli bir bağımlılık değil).
 *
 * ── SINIRLAR NEREDEN ────────────────────────────────────────────────────────
 * `MAX_UPLOAD_BYTES` ve `INSTAGRAM_MAX_BYTES` sunucudaki
 * `MAX_UPLOAD_BYTES` (2 GB) ile `INSTAGRAM_MAX_BYTES` (300 MB) DEĞERLERİNİ
 * tekrar eder. Kopya bilinçlidir: sunucu zaten son sözü söyler, panel yalnız
 * kullanıcıyı yollamadan önce uyarır. Değerler ayrışırsa panel yanlış
 * "kabul edilir" der; o yüzden ikisi de burada SABİT yazılıdır.
 */

/** `<input type=file accept>` değeri. */
export const UPLOAD_ACCEPT = "video/*";

/** Sunucunun multipart üst sınırı: 2 GB. Buradan büyük dosya reddedilir. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Instagram dosya sınırı (doğrulanmış): 300 MB. TikTok/YouTube 4 GB. */
export const INSTAGRAM_MAX_BYTES = 300 * 1024 * 1024;

/**
 * Uzantıya göre video kabulü.
 *
 * Neden `accept="video/*"` yetmiyor: (a) tarayıcı `type` alanını doldurmayabilir
 * (özellikle `.mkv`, `.mts`), (b) bazı sistemler `video/quicktime` yerine boş
 * string verir. Uzantı son çare; `type` VEYA uzantı yeterlidir.
 */
export const VIDEO_EXTENSIONS: readonly string[] = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".mpeg",
  ".mpg",
  ".mxf",
  ".hevc",
  ".mts",
  ".m2ts",
  ".flv",
  ".wmv",
  ".3gp",
];

// ── Aday dosya ──────────────────────────────────────────────────────────────

/** Yalnız üç alan: gerçek `File` de bu biçimi karşılar. */
export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/** `<input>`/`DataTransfer` okuma sonucu. Dizgi-benzeri yapı kabul edilir. */
export function filesFromInput(
  input: { files?: ArrayLike<unknown> | null } | null | undefined,
): FileLike[] {
  const raw = input?.files;
  if (raw === null || raw === undefined) return [];
  const out: FileLike[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object") continue;
    const file = entry as Partial<FileLike>;
    if (typeof file.name !== "string" || file.name === "") continue;
    out.push({
      name: file.name,
      size: typeof file.size === "number" && Number.isFinite(file.size) ? file.size : 0,
      type: typeof file.type === "string" ? file.type : "",
    });
  }
  return out;
}

/** Küçük harfe çevrilmiş uzantı (`"a.MP4"` → `".mp4"`), yoksa `null`. */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

export function isVideoCandidate(file: FileLike): boolean {
  if (file.type.toLowerCase().startsWith("video/")) return true;
  const ext = extensionOf(file.name);
  return ext !== null && VIDEO_EXTENSIONS.includes(ext);
}

// ── Kabul kriterleri ────────────────────────────────────────────────────────

export interface CandidateCheck {
  ok: boolean;
  /** Reddedildiyse kullanıcı dilinde gerekçe; kabul edildiyse `null`. */
  reason: string | null;
  /**
   * Instagram 300 MB sınırı aşıldı mı?
   *
   * ⚠️ ENGELLEME DEĞİL. Dosya yüklenebilir (sunucu 2 GB'a kadar kabul eder,
   * TikTok/YouTube 4 GB'a kadar); yalnız Instagram hedefi seçildiyse yayın
   * sonrası reddedilir. Bu yüzden "uyarı" ayrı bir alandır.
   */
  warnInstagram: boolean;
}

/** 300 MB üstü dosyanın Instagram uyarısı (`null` = uyarı yok). */
export function instagramWarning(size: number): string | null {
  if (!(size > INSTAGRAM_MAX_BYTES)) return null;
  return `Instagram bu dosyayı kabul etmez (sınır 300 MB). TikTok/YouTube için sorun yok.`;
}

export function checkCandidate(file: FileLike): CandidateCheck {
  if (file.size <= 0) {
    return { ok: false, reason: "Dosya boş (0 bayt).", warnInstagram: false };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `Dosya çok büyük: sunucu en çok 2 GB kabul ediyor.`,
      warnInstagram: false,
    };
  }
  if (!isVideoCandidate(file)) {
    return {
      ok: false,
      reason: "Desteklenmeyen dosya türü. Yalnız video yükleyin (mp4, mov, webm, mkv).",
      warnInstagram: false,
    };
  }
  return { ok: true, reason: null, warnInstagram: instagramWarning(file.size) !== null };
}

// ── Kuyruk ──────────────────────────────────────────────────────────────────

export type UploadState = "pending" | "uploading" | "done" | "error";

export interface QueuedUpload {
  id: string;
  name: string;
  size: number;
  type: string;
  state: UploadState;
  /** 0..100 (tam sayı). `done` olduğunda 100. */
  percent: number;
  /** Sunucuya gönderilen bayt. */
  loaded: number;
  error: string | null;
  warnInstagram: boolean;
}

export interface RejectedFile {
  name: string;
  reason: string;
}

export interface PreparedFiles {
  /** Kabul edilenler: boyuta göre küçükten büyüğe. */
  accepted: QueuedUpload[];
  rejected: RejectedFile[];
  /** Zaten kuyrukta olan dosya (ad + boyut aynı). */
  duplicates: RejectedFile[];
  /** Instagram 300 MB uyarısı taşıyan dosya adları. */
  warnings: string[];
}

/**
 * Aynı dosya mı? Ad + boyut eşitse AYNI dosyadır.
 *
 * Neden boyut da: iki farklı klip aynı adı taşıyabilir (`vlog.mp4` iki kez).
 * Yalnız ada bakmak gerçek bir dosyayı çift yüklemeyi engellemez.
 */
export function isSameFile(a: FileLike, b: FileLike): boolean {
  return a.name === b.name && a.size === b.size;
}

/** Kuyruktaki en büyük `uNN` numarası + 1. Yeni kimlik üretmez, sayar. */
export function nextUploadSeq(existing: readonly QueuedUpload[]): number {
  let max = 0;
  for (const item of existing) {
    const n = Number.parseInt(item.id.replace(/^u/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Sürükle-bırak / dosya seçici sonucunu kuyruğa çevirir. Saf. */
export function prepareFiles(
  incoming: readonly FileLike[],
  existing: readonly QueuedUpload[],
): PreparedFiles {
  const accepted: QueuedUpload[] = [];
  const rejected: RejectedFile[] = [];
  const duplicates: RejectedFile[] = [];
  const warnings: string[] = [];
  let seq = nextUploadSeq(existing);

  for (const file of incoming) {
    const already = existing.some((item) => isSameFile(item, file)) ||
      accepted.some((item) => isSameFile(item, file));
    if (already) {
      duplicates.push({
        name: file.name,
        reason: `"${file.name}" kuyrukta zaten var; iki kez yüklenmedi.`,
      });
      continue;
    }
    const check = checkCandidate(file);
    if (!check.ok) {
      rejected.push({ name: file.name, reason: check.reason ?? "Dosya kabul edilmedi." });
      continue;
    }
    if (check.warnInstagram) {
      warnings.push(`"${file.name}": ${instagramWarning(file.size) ?? ""}`.trim());
    }
    accepted.push({
      id: `u${seq}`,
      name: file.name,
      size: file.size,
      type: file.type,
      state: "pending",
      percent: 0,
      loaded: 0,
      error: null,
      warnInstagram: check.warnInstagram,
    });
    seq += 1;
  }

  // Küçük dosya önce: kullanıcı ilk dosyasını daha erken tamamlar görmek ister
  // (500 MB + 8 MB seçildiğinde 8 MB'nin bitmesi 500 MB'yi beklemekten iyi).
  accepted.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return { accepted, rejected, duplicates, warnings };
}

// ── Durum makinesi ──────────────────────────────────────────────────────────

/**
 * `loaded/total` → yüzde (0..100 tam sayı).
 *
 * `total` bilinmiyorsa/0 ise `0` döner: gösterge "belirsiz" demek yerine
 * baştan sıfır gösterir, son `onload` çağrısında 100 olur. `NaN`/`Infinity`
 * yutulmaz — `0`.
 */
export function progressPercent(loaded: number, total: number | null | undefined): number {
  if (!Number.isFinite(loaded) || loaded < 0) return 0;
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.floor((loaded / total) * 100);
  if (ratio < 0) return 0;
  return ratio > 100 ? 100 : ratio;
}

function patch(list: readonly QueuedUpload[], id: string, changes: Partial<QueuedUpload>): QueuedUpload[] {
  return list.map((item) => (item.id === id ? { ...item, ...changes } : item));
}

/** `pending → uploading`. Aynı satır için ikinci çağrı no-op'tur. */
export function beginUpload(list: readonly QueuedUpload[], id: string): QueuedUpload[] {
  return patch(list, id, { state: "uploading", percent: 0, loaded: 0, error: null });
}

/** `uploading` sırasında ilerleme. `loaded` korunur (ileri geri sıçrama olmaz). */
export function advanceUpload(
  list: readonly QueuedUpload[],
  id: string,
  loaded: number,
  total: number | null | undefined,
): QueuedUpload[] {
  const item = list.find((entry) => entry.id === id);
  if (item === undefined || item.state !== "uploading") return [...list];
  return patch(list, id, { loaded, percent: progressPercent(loaded, total) });
}

/** `uploading → done`. Yüzde 100'e sabitlenir (sunucu onayı geldi). */
export function completeUpload(list: readonly QueuedUpload[], id: string): QueuedUpload[] {
  return patch(list, id, { state: "done", percent: 100, loaded: 0, error: null });
}

/** `uploading|pending → error`. Gerekçe Türkçe olmalıdır. */
export function failUpload(
  list: readonly QueuedUpload[],
  id: string,
  message: string,
): QueuedUpload[] {
  return patch(list, id, { state: "error", error: message === "" ? "Yükleme başarısız." : message });
}

/** Kuyruktan düşürür (biten satır temizleme, iptal). */
export function removeUpload(list: readonly QueuedUpload[], id: string): QueuedUpload[] {
  return list.filter((item) => item.id !== id);
}

export function activeUploads(list: readonly QueuedUpload[]): QueuedUpload[] {
  return list.filter((item) => item.state === "uploading" || item.state === "pending");
}

export function hasActiveUploads(list: readonly QueuedUpload[]): boolean {
  return list.some((item) => item.state === "uploading" || item.state === "pending");
}

export function countUploadsByState(
  list: readonly QueuedUpload[],
  state: UploadState,
): number {
  return list.filter((item) => item.state === state).length;
}

/** Satırın durum metni: `bekliyor` / `yükleniyor %N` / `tamamlandı` / `hata`. */
export function uploadStatusLabel(item: QueuedUpload): string {
  switch (item.state) {
    case "pending":
      return "bekliyor";
    case "uploading":
      return `yükleniyor %${item.percent}`;
    case "done":
      return "tamamlandı";
    case "error":
      return "hata";
  }
}

// ── Hata mesajı eşlemesi ────────────────────────────────────────────────────

export interface UploadFailure {
  /** HTTP durum kodu. Ağ hatasında `null`. */
  status: number | null;
  /** Sunucunun makine kodu (`payload_too_large` vb.). */
  code: string | null;
  /** Sunucunun Türkçe mesajı. */
  message: string | null;
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * HTTP sonucunu kullanıcı dilinde tek satıra çevirir.
 *
 * SIRA ÖNEMLİ: önce `validation_failed` (400) çözülür çünkü sunucunun mesajı
 * ZATEN Türkçe ve alan adıyla gelir ("En az bir geçerli platform seçilmeli.");
 * kendi genel metnimiz onu gölgelemesin diye AYnen gösterilir.
 */
export function uploadErrorMessage(f: UploadFailure): string {
  const server = clean(f.message);
  const code = clean(f.code);

  if (code === "aborted" || f.status === null) {
    return code === "aborted" ? "Yükleme iptal edildi." : "Sunucuya ulaşılamadı. API çalışıyor mu?";
  }
  if (f.status === 401 || code === "unauthorized") {
    return "Oturumunuz sona erdi. Çıkış yapıp tekrar giriş yapın.";
  }
  if (f.status === 403 || code === "csrf_failed" || code === "forbidden") {
    return "İstek kökeni reddedildi (CSRF). Paneli kendi adresinden açın.";
  }
  if (f.status === 413 || code === "payload_too_large") {
    return server === ""
      ? "Dosya çok büyük. Sunucu 2 GB sınırını uyguluyor."
      : `Dosya çok büyük. ${server}`;
  }
  if (f.status === 415 || code === "unsupported_media_type") {
    return server === ""
      ? "Desteklenmeyen dosya türü. Yalnız video yükleyin."
      : `Desteklenmeyen dosya türü. ${server}`;
  }
  if (f.status === 400 && code === "validation_failed") {
    // Sunucunun Türkçe gerekçesi AYNEN gösterilir.
    return server === "" ? "Sunucu gövdeyi geçersiz buldu." : server;
  }
  if (code === "timeout") {
    return "Yükleme zaman aşımına uğradı. Dosya çok büyük olabilir.";
  }
  if (typeof f.status === "number" && f.status >= 500) {
    return `Sunucu hatası (HTTP ${f.status}). ${server}`.trim();
  }
  return server === "" ? `Yükleme başarısız (HTTP ${String(f.status)}).` : server;
}

// ── Besleme formu ───────────────────────────────────────────────────────────

/** Panelin gönderdiği besleme alanları. */
export interface FeedForm {
  project: string;
  platforms: string[];
  description: string;
  hashtags: string;
}

export const FEED_PLATFORMS: readonly string[] = ["instagram", "tiktok", "youtube"];

/** Varsayılan: `genel` projesi + ÜÇ platform da işaretli. */
export function emptyFeedForm(): FeedForm {
  return { project: "genel", platforms: [...FEED_PLATFORMS], description: "", hashtags: "" };
}

/**
 * Serbest metinden hashtag listesi: `#` atılır, boşlar düşer, tekrar elenir.
 *
 * Sınır 30 (sözleşme `hashtags: max(30)`). Fazlası KIRPILMAZ gibi davranıp
 * sessizce düşmez — `tagLimit` rozeti panelde sayıyı gösterir.
 */
export function parseHashtags(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, "").trim();
    if (tag === "") continue;
    if (tag.length > 60) continue;
    seen.add(tag);
    if (seen.size >= 30) break;
  }
  return [...seen];
}

/** Sözleşmedeki sert üst sınır (30). Panelde sayaç olarak gösterilir. */
export const HASHTAG_LIMIT = 30;

/**
 * Besleme formu → multipart metin alanları (`POST /api/v1/ingest`).
 *
 * JSON alanlar (`defaultCopy`) SUNUCUDA `decodeJsonFields` ile çözülür; panel
 * metni elle JSON'a çevirip `FormData`'ya koyar. `autoSchedule` YOK: içerik
 * taslak kalsın, yayın insan onayına bağlı olsun.
 */
export function toIngestFields(
  form: FeedForm,
  selected: readonly string[],
): Record<string, string> {
  const platforms = selected.filter((p) => FEED_PLATFORMS.includes(p));
  const fields: Record<string, string> = {
    project: form.project.trim() === "" ? "genel" : form.project.trim(),
    platforms: platforms.join(","),
    autoSchedule: "false",
  };
  const description = form.description.trim();
  const hashtags = parseHashtags(form.hashtags);
  if (description !== "" || hashtags.length > 0) {
    const copy: Record<string, unknown> = {};
    if (description !== "") copy["description"] = description;
    if (hashtags.length > 0) copy["hashtags"] = hashtags;
    fields["defaultCopy"] = JSON.stringify(copy);
  }
  return fields;
}
