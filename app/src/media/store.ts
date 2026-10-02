/**
 * Yerel disk üzerinde çalışan `MediaStore`.
 *
 * GÜVENLİK NOTU (bu dosyanın en kritik kısmı): `storageKey` HTTP gövdesinden
 * gelebilen bir dizgi. `path.join(dir, key)` çağrısı tek başına güvenli
 * DEĞİLDİR: `../../appsettings.json` ve `C:\...` gibi anahtarlar depodaki
 * başka dosyaları okumaya/yazmaya açar. Bu yüzden anahtarı *yol birleştirmeden
 * önce* ayrıştırıyoruz ve her segmenti tek tek denetliyoruz. Ayrıca çözümlenen
 * mutlak yolun depo kökünün içinde kaldığını ikinci bir kez doğruluyoruz
 * (savunma katmanı: tek bir kontrolün kaçırması tek başına veri sızdırmaz).
 *
 * `publicUrl` imzası: `HMAC-SHA256(secret, "<key>:<exp>")`. İmza, `exp` değerini
 * de içerdiği için süresi dolmuş bağlantı *geçerli görünerek* kullanamaz; sunucu
 * saati aştığında doğrulama başarısız olur. Karşılaştırma `timingSafeEqual`
 * ile yapılır.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import type { MediaStore, PublicMediaUrl } from "../ports/index.js";

/** İmzasız/çok kısa ömürlü bağlantı kaza değil kural: her zaman imzalı. */
export const DEFAULT_URL_TTL_SEC = 86_400; // 24 saat

const MAX_KEY_LENGTH = 512;

/**
 * Windows'ta ayrılmış cihaz adları. `CON` adlı bir anahtar Windows'ta bir
 * klasör değildir; sessizce yanlış yere yazabilir.
 */
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export class UnsafeStorageKeyError extends Error {
  constructor(readonly key: string, reason: string) {
    super(`Güvensiz storageKey (${reason}): ${JSON.stringify(key)}`);
    this.name = "UnsafeStorageKeyError";
  }
}

export class MediaStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaStoreError";
  }
}

function isReservedSegment(segment: string): boolean {
  const base = segment.split(".")[0]?.toLowerCase() ?? "";
  return RESERVED_NAMES.has(base);
}

/**
 * Anahtarı çözümlemeden önce doğrular. Reddedilenler:
 *   `..`, `.`, boş segment, `a:b` (sürücü harfi **ve** NTFS ADS), mutlak yol
 *   (`/x`, `\x`, `\\server\share`), ters eğik çizgi, NUL, ayrılmış cihaz adı,
 *   aşırı uzun anahtar ve URL-kodlanmış varyantları (`%2e%2e%2fx`).
 * Geçerli anahtarlar: `2026/09/abc.mp4`, `covers/abc.jpg`.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new UnsafeStorageKeyError(String(key), "boş");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new UnsafeStorageKeyError(key, `çok uzun (>${MAX_KEY_LENGTH})`);
  }
  if (key.includes("\0")) throw new UnsafeStorageKeyError(key, "NUL baytı");
  if (key.includes(":")) {
    throw new UnsafeStorageKeyError(key, "':' yasak (sürücü harfi / ADS)");
  }
  if (key.includes("\\")) {
    throw new UnsafeStorageKeyError(key, "ters eğik çizgi yasak");
  }
  if (key.startsWith("/")) throw new UnsafeStorageKeyError(key, "mutlak yol");
  if (key.endsWith("/")) throw new UnsafeStorageKeyError(key, "sondaki eğik çizgi");

  for (const segment of key.split("/")) {
    if (segment.length === 0) throw new UnsafeStorageKeyError(key, "boş segment");
    if (segment === "." || segment === "..") {
      throw new UnsafeStorageKeyError(key, "göreli yol segmenti");
    }
    if (segment !== segment.trim()) {
      throw new UnsafeStorageKeyError(key, "baştaki/sondaki boşluk");
    }
    if (isReservedSegment(segment)) {
      throw new UnsafeStorageKeyError(key, "ayrılmış cihaz adı");
    }
  }

  // Aynı saldırı URL-kodlanmış gelebilir; çözüp yeniden denetle.
  let decoded: string | null = null;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = null; // geçerli bir kodlama değil, ham anahtar zaten denetlendi
  }
  if (decoded !== null && decoded !== key) {
    assertSafeKey(decoded);
  }
  return key;
}

// ── İmzalı bağlantı ───────────────────────────────────────────────────────

export function signKey(secret: string, key: string, expires: number): string {
  return createHmac("sha256", secret)
    .update(`${key}:${expires}`, "utf8")
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifySignature(
  secret: string,
  key: string,
  expires: number,
  signature: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(expires) || !Number.isFinite(nowSec)) return false;
  if (expires <= nowSec) return false; // süresi dolmuş
  return safeEqual(signature, signKey(secret, key, expires));
}

export interface SignedUrlParts {
  key: string;
  expires: number;
  signature: string;
}

export function encodeKeyForUrl(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * `basePathname` verilirse (örn. "/media") baştaki önek atılır; imzalı URL'de
 * önek imzanın parçası değildir, sadece adres çözümlemesidir.
 */
export function parseSignedUrl(
  url: string,
  opts?: { basePathname?: string },
): SignedUrlParts | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const expiresRaw = parsed.searchParams.get("expires");
  const signature = parsed.searchParams.get("sig");
  if (expiresRaw === null || signature === null) return null;
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires)) return null;

  let pathname = parsed.pathname;
  const prefix = opts?.basePathname ?? "";
  if (prefix) {
    const norm = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (!pathname.startsWith(norm)) return null;
    pathname = pathname.slice(norm.length);
  }
  const key = pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
  if (key.length === 0) return null;
  return { key, expires, signature };
}

export type UrlVerification =
  | { ok: true; key: string; expires: number }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

export function verifySignedUrl(
  url: string,
  secret: string,
  opts?: { nowSec?: number; basePathname?: string },
): UrlVerification {
  const parts = parseSignedUrl(url, opts);
  if (!parts) return { ok: false, reason: "malformed" };
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  if (parts.expires <= nowSec) return { ok: false, reason: "expired" };
  if (!verifySignature(secret, parts.key, parts.expires, parts.signature, nowSec)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, key: parts.key, expires: parts.expires };
}

// ── Disk deposu ───────────────────────────────────────────────────────────

export interface FsMediaStoreOptions {
  /** null ise hiçbir dışarı adres üretilmez (yalnızca yerel kullanım). */
  publicBaseUrl: string | null;
  /** HMAC sırrı. Üretimde ortam değişkeninden gelmeli. */
  secret: string;
  /**
   * Yalnız `publicUrl(key, { ttlSec })` çağıranların varsayılan ömrü. Port
   * sözleşmesinde `ttlSec` verilmezse adres KALICIDIR, bu yüzden bu değer
   * "verilmezse imzalı üret" anlamına gelmez; panel/panel-dışı çağıranların
   * ömür unutmasını önlemek isteyenler `defaultUrlTtlSec` kullanabilir.
   * `null` (varsayılan) = hatırlatma yok.
   */
  defaultUrlTtlSec?: number | null;
}

export class FsMediaStore implements MediaStore {
  readonly root: string;
  private readonly publicBaseUrl: string | null;
  private readonly secret: string;
  /** null = `publicUrl(key)` kalıcı adres döndürür. */
  private readonly defaultTtlSec: number | null;
  private readonly basePathname: string;

  constructor(storageDir: string, opts: FsMediaStoreOptions) {
    if (!storageDir || !String(storageDir).trim()) {
      throw new MediaStoreError("storageDir boş olamaz");
    }
    if (typeof opts?.secret !== "string" || opts.secret.length < 8) {
      throw new MediaStoreError("secret en az 8 karakter olmalı");
    }
    this.root = resolve(storageDir);
    this.publicBaseUrl = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/+$/, "") : null;
    this.secret = opts.secret;
    this.defaultTtlSec = opts.defaultUrlTtlSec ?? null;
    this.basePathname = this.publicBaseUrl
      ? new URL(this.publicBaseUrl).pathname.replace(/\/+$/, "")
      : "";
    mkdirSyncSafe(this.root);
  }

  /** Anahtarı doğrular ve mutlak yola çevirir. Dizin YARATMAZ. */
  resolveKey(key: string): string {
    const safe = assertSafeKey(key);
    const target = resolve(this.root, ...safe.split("/"));
    const rel = relative(this.root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith("..\\") || isAbsolute(rel)) {
      throw new UnsafeStorageKeyError(key, "depo kökünün dışına çıkıyor");
    }
    return target;
  }

  pathFor(key: string): string {
    const target = this.resolveKey(key);
    mkdirSyncSafe(dirname(target));
    return target;
  }

  async put(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
  ): Promise<{ key: string; bytes: number }> {
    const safe = assertSafeKey(key);
    const target = this.pathFor(safe);
    if (Buffer.isBuffer(body)) {
      await writeFile(target, body);
      return { key: safe, bytes: body.length };
    }
    // Akış: önce geçici dosyaya yaz, sonra atomik olarak taşı. Yarım dosya
    // üzerinden okuma yapılabilmesini (yarış koşulu) böylece engelliyoruz.
    const tmp = `${target}.${randomBytes(6).toString("hex")}.part`;
    try {
      await pipeline(body as Readable, createWriteStream(tmp, { flags: "wx" }));
      const info = await stat(tmp);
      await rename(tmp, target);
      return { key: safe, bytes: info.size };
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async read(key: string): Promise<Buffer> {
    const target = this.resolveKey(key);
    try {
      return await readFile(target);
    } catch (err) {
      if (isNotFound(err)) {
        throw new MediaStoreError(`Medya bulunamadı: ${key}`);
      }
      throw err;
    }
  }

  /** Akışlı okuma: büyük dosyaları belleğe almadan sunmak için. */
  readStream(key: string): ReturnType<typeof createReadStream> {
    return createReadStream(this.resolveKey(key));
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    try {
      return (await stat(target)).isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await unlink(target);
    } catch (err) {
      if (!isNotFound(err)) throw err; // yoksa sorun değil: idempotent
    }
  }

  /**
   * Platformun çekeceği dışarı adres.
   *
   * `publicBaseUrl` null ise `null` döner: dışarıya açık adres yok demektir,
   * üstelik değişken bir adres uydurmak daha kötüdür (yanlış güven). Çağıran
   * bunu "yayınlanamaz" olarak ele almalı.
   *
   * `ttlSec` VERİLMEZSE kalıcı adres döner (`expiresAt: null`, imzasız). Port
   * sözleşmesi böyle: IG container'ı birkaç kez çekilebiliyor ve üç platformun
   * hiçbirinde zorunlu public URL yolu yok; `MediaRef.publicUrl` alanı
   * "yalnız gerçekten public URL gerektiren yol varsa" anlamlıdır.
   *
   * `ttlSec` VERİLİRSE imzalı ve süreli adres üretilir: ömür hem `expires`
   * sorgu argümanına hem imzaya gömülür, `expiresAt` ise **epoch ms** döner
   * (`PublicMediaUrl.expiresAt` sözleşmesi). `ttlSec <= 0` reddedilir: sıfır
   * ömürlü bir bağlantı üretmek, üretmemekten iyidir ama sessizce üretilmemelidir.
   */
  publicUrl(key: string, opts?: { ttlSec?: number }): PublicMediaUrl | null {
    if (!this.publicBaseUrl) return null;
    const safe = assertSafeKey(key);
    const base = `${this.publicBaseUrl}/${encodeKeyForUrl(safe)}`;
    const ttlSec = opts?.ttlSec ?? this.defaultTtlSec ?? undefined;
    if (ttlSec === undefined) {
      // Kalıcı adres: imza yok, süre yok. `expiresAt: null` bunu açıkça bildirir.
      return { url: base, expiresAt: null };
    }
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      throw new MediaStoreError(
        `ttlSec pozitif olmalı (kalıcı adres için ttlSec VERİLMEZ): ${String(ttlSec)}`,
      );
    }
    const expires = Math.floor(Date.now() / 1000) + Math.floor(ttlSec);
    const signature = signKey(this.secret, safe, expires);
    return {
      url: `${base}?expires=${expires}&sig=${signature}`,
      expiresAt: expires * 1000,
    };
  }

  /** Bu deposun ürettiği adresi doğrular (süre + imza). */
  verifyPublicUrl(url: string, opts?: { nowSec?: number }): UrlVerification {
    return verifySignedUrl(url, this.secret, {
      nowSec: opts?.nowSec,
      basePathname: this.basePathname,
    });
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function mkdirSyncSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
