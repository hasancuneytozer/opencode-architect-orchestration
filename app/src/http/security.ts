/**
 * OTURUM, PAROLA, CSRF ve GİRİŞ HIZ SINIRI.
 *
 * ── TEHLİKE MODELİ ───────────────────────────────────────────────────────────
 * Uygulama yerelde çalışır ama `SP_PUBLIC_BASE_URL` verilirse tünelle
 * internete açılır. Varsayılan güvenli olsun:
 *
 *  1. `SP_ADMIN_PASSWORD` YOKSA oturum açılamaz. Bu bir arıza değil, bilinçli
 *     kör mod: parolasız panel, parolasız da açık demektir.
 *  2. Parola karşılaştırması `timingSafeEqual` ile ve HASH ÜZERİNDEN yapılır.
 *  3. Oturum token'ı 32 bayt rastgele, BELLEKTE saklanır. Sunucu yeniden
 *     başlayınca oturumlar düşer — kabul edilmiş sadeleştirmedir (diskte
 *     token saklamak, token'ı diskte tutmaktır).
 *  4. `sameSite=lax` TEK BAŞINA yetmez: `POST` formu gönderimi için lax her
 *     zaman çerez ekler. Bu yüzden durum değiştiren isteklerde `Origin`/
 *     `Referer` kontrolü YAPILIR.
 *  5. Giriş denemeleri sınırlandırılır: parola tahmin etmek 5 denemede
 *     pahalılaşır.
 *
 * Parola düz metni ASLA loglanmaz ve `redact` listesinde adı geçer.
 *
 * ── PAROLA HASHİ ────────────────────────────────────────────────────────────
 * `scrypt` + rastgele 16 bayt tuz. Biçim:
 *   `scrypt$N$r$p$<base64url(tuz)>$<base64url(anahtar)>`
 * Saklama `SP_ADMIN_PASSWORD`'ün düz metnini ASLA tutmaz; `main.ts` hash'ler,
 * karşılaştırma `verifyPassword` ile yapılır. Parametreler biçimde taşınır
 * ki varsayılanlar ileride değişirse eski hash'ler AÇILMAYA devam etsin.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Parola özeti. `scrypt` parametreleri biçimin parçasıdır; `N=16384` Node'un
 * önerdiği çalışma faktörüdür (~50 ms). `p` paralellik, `maxmem` Node'un
 * varsayılanıdır (sıfır → varsayılan).
 */
export interface PasswordDigest {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  saltB64: string;
  hashB64: string;
}

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * `scrypt` bellek tavanı (bayt).
 *
 * Gerekli bellek `128 * N * r` = 16 MiB. Node'un varsayılanı 32 MiB'dir ve bu
 * parametreler için yeterlidir, ama sınır AÇIKÇA yazılır: `N`/`r` bir gün
 * yükseltilirse "varsayılan değişti, hash üretimi patladı" yerine "gereken
 * bellek tavanını da yükselt" hatası alınır.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** `digest` nesnesini tek metne çevirir (saklama/aktarım biçimi). */
export function serializePassword(digest: PasswordDigest): string {
  return [
    digest.algorithm,
    digest.N,
    digest.r,
    digest.p,
    digest.saltB64,
    digest.hashB64,
  ].join("$");
}

/** Ters işlem. Bozuk metin `null` döner: sessizce "parola doğru" demek YANLIŞ. */
export function parsePassword(text: string): PasswordDigest | null {
  const parts = text.split("$");
  if (parts.length !== 6) return null;
  const [algorithm, n, r, p, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== "scrypt") return null;
  const toNum = (v: string): number => {
    const n2 = Number(v);
    return Number.isInteger(n2) && n2 > 0 ? n2 : NaN;
  };
  const N = toNum(n);
  const R = toNum(r);
  const P = toNum(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(saltB64) || !/^[A-Za-z0-9_-]+$/.test(hashB64)) return null;
  return { algorithm: "scrypt", N, r: R, p: P, saltB64, hashB64 };
}

/** Düz metinden özet üretir. `randomBytes` enjekte edilebilir (testler). */
export function hashPassword(
  password: string,
  random: { bytes: (n: number) => Buffer } = { bytes: (n) => cryptoRandom(n) },
): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Parola boş olamaz.");
  }
  const salt = random.bytes(SALT_BYTES);
  // Node 22 imzası: `scryptSync(password, salt, keylen, options)`. `N/r/p`
  // ayrı konumsal argüman DEĞİLDİR; seçenek nesnesi içinde verilir.
  const derived = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return serializePassword({
    algorithm: "scrypt",
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    saltB64: salt.toString("base64url"),
    hashB64: derived.toString("base64url"),
  });
}

/**
 * Sabit zamanlı doğrulama.
 *
 * `timingSafeEqual` FARKLI UZUNLUKTA tamponları reddeder; uzunluk farkı bir
 * sırrı ifade etmez (özet uzunluğu sabittir) ama karşılaştırma yine de
 * "eşleşmedi" olarak döner. Düz `===` yerine `timingSafeEqual` kullanılmasının
 * sebebi: `===` ilk farklı baytta döner ve parola uzunluğunu/öneki kademeli
 * sızdırır.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const digest = parsePassword(stored);
  if (!digest) return false;
  const salt = Buffer.from(digest.saltB64, "base64url");
  const expected = Buffer.from(digest.hashB64, "base64url");
  let actual: Buffer;
  try {
    // Doğrulama, özetteki `N/r/p` DEĞERLERİNİ kullanır: saklanan biçim parametreleri
    // taşır ki varsayılanlar ileride değişse bile eski hash'ler AÇILMAYA devam etsin.
    actual = scryptSync(password, salt, expected.length, {
      N: digest.N,
      r: digest.r,
      p: digest.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ── Oturum ──────────────────────────────────────────────────────────────────

/** Oturum token'ı bayt sayısı. 32 bayt = 256 bit. */
export const SESSION_TOKEN_BYTES = 32;
/** Oturum ömrü (ms). 12 saat: "gün içi unutuldu" ile "kapalı kaldı" arası. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Çerez adı. `__Host-` öneki kullanılmaz: geliştirmede `http://` üzerinde de
 *  çalışmalı ve `Secure` zorunluluğu localhost'ta da hata verir. */
export const SESSION_COOKIE = "sp_session";

export interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Bellekte oturum deposu. Süreç yeniden başlayınca boşalır (bilinçli).
 */
export class SessionStore {
  private readonly byToken = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number = SESSION_TTL_MS,
    private readonly random: (n: number) => Buffer = cryptoRandom,
    private readonly now: () => number = Date.now,
  ) {}

  /** Yeni oturum açar ve token'ı döner. Token yalnız burada üretilir. */
  create(now = this.now()): Session {
    const token = this.random(SESSION_TOKEN_BYTES).toString("base64url");
    const session: Session = { token, createdAt: now, expiresAt: now + this.ttlMs };
    this.byToken.set(token, session);
    return session;
  }

  /** Geçerli oturum; süresi dolmuşsa `null` ve kayıt SİLİNİR. */
  get(token: string | undefined | null, now = this.now()): Session | null {
    if (!token) return null;
    const found = this.byToken.get(token);
    if (!found) return null;
    if (found.expiresAt <= now) {
      this.byToken.delete(token);
      return null;
    }
    return found;
  }

  /** Çıkış: token silinir. "Sadece unuttur" değil — oturum GERÇEKTEN biter. */
  destroy(token: string | undefined | null): boolean {
    if (!token) return false;
    return this.byToken.delete(token);
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Süresi dolmuş kayıtları temizler (uzun ömürlü süreçte bellek şişmesin). */
  sweep(now = this.now()): number {
    let removed = 0;
    for (const [token, session] of this.byToken) {
      if (session.expiresAt <= now) {
        this.byToken.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

// ── Giriş hız sınırı ────────────────────────────────────────────────────────

/**
 * Kayan pencere sayaç. Dakikada 5 deneme.
 *
 * Neden "dakika" kovası değil kayan pencere: kova sınırı, sınırın tam
 * sınırındaki 5 isteği kabul edip 61. saniyede yine 5 isteği kabul eder;
 * kaba kuvvet saldırganı dakika başına 10 deneme yapar. Kayan pencere
 * "son 60 saniyede en fazla 5" der ve sınırı delmez.
 */
/**
 * Giriş hız sınırı: pencere içinde kabul edilen deneme sayısı.
 *
 * Değer `LOGIN_LIMIT_PER_WINDOW`/`LOGIN_WINDOW_MS` çifti olarak TEK yerden
 * dışa aktarılır; `server.ts` limiti kendisi uydurmaz. Kayan pencere kovasından
 * seçilmiştir: kova sınırındaki 5 isteği kabul edip bir sonraki kovada yine 5
 * isteği kabul eder ve kaba kuvvet saldırganı dakikada 10 deneme yapar.
 */
export const LOGIN_LIMIT_PER_WINDOW = 5;
/** Kayan pencere uzunluğu (ms). */
export const LOGIN_WINDOW_MS = 60_000;

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: RateLimitOptions) {
    if (opts.limit <= 0 || opts.windowMs <= 0) {
      throw new Error("Hız sınırı limit/pencere pozitif olmalı.");
    }
  }

  /** Bu anahtar için istek SAĞLANIR MI? Sayaç her çağrıda ilerler. */
  allow(key: string, now = (this.opts.now ?? Date.now)()): boolean {
    const cutoff = now - this.opts.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.opts.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }

  /** Kalan hak. Panelde "3 deneme hakkınız kaldı" göstermek için. */
  remaining(key: string, now = (this.opts.now ?? Date.now)()): number {
    const cutoff = now - this.opts.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    return Math.max(0, this.opts.limit - kept.length);
  }

  /** Kilit süresi (ms): geri sayım göstergesi için. Kilit yoksa 0. */
  retryAfterMs(key: string, now = (this.opts.now ?? Date.now)()): number {
    const cutoff = now - this.opts.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length < this.opts.limit) return 0;
    const oldest = Math.min(...kept);
    return Math.max(0, oldest + this.opts.windowMs - now);
  }

  /** Başarılı girişten sonra sayacı sıfırlar: kullanıcı kendi hatasını
   * "tüketmiş" olmamalı. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Testler ve ölü anahtar temizliği için. */
  prune(now = (this.opts.now ?? Date.now)()): void {
    const cutoff = now - this.opts.windowMs;
    for (const [key, times] of this.hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

// ── CSRF ────────────────────────────────────────────────────────────────────

/**
 * Durum değiştiren istek için `Origin`/`Referer` kontrolü.
 *
 * `sameSite=lax` çerezi `POST` FORM gönderiminde de gider (lax yalnız
 * üst düzey gezinmede engeller). REST + cookie için asıl koruma buradadır:
 * tarayıcı, kökeni eşleşmeyen bir `fetch`/`form` isteğinde `Origin` başlığını
 * gönderir ve biz onu reddederiz.
 *
 * KURALLAR:
 *   * `Origin` varsa BEKLENEN kökenlerden biri olmalı.
 *   * `Origin` yoksa `Referer`in kökeni kontrol edilir.
 *   * İkisi de yoksa REDDEDİLİR: tarayıcı mutlaka birini gönderir, yokluğu
 *     "bu bir tarayıcı isteği değil" demektir ve o zaman oturum zaten
 *     kullanılmamalıdır (CLI `X-Api-Key` kullanır).
 */
export interface CsrfOptions {
  /** Bu isteğin kendi kökeni (`http://127.0.0.1:4317` gibi). */
  expectedOrigins: readonly string[];
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/** `Origin`/`Referer` kontrolü. `true` = geçti. */
export function csrfOk(opts: CsrfOptions): boolean {
  if (!isStateChanging(opts.method)) return true;
  const allowed = new Set(opts.expectedOrigins.map(normalizeOrigin).filter(Boolean));
  if (allowed.size === 0) return false;

  const origin = firstHeader(opts.headers["origin"]);
  if (origin) {
    // `Origin: null` (sandbox iframe, `file://`) ASLA kabul edilmez.
    return normalizeOrigin(origin) !== null && allowed.has(normalizeOrigin(origin) as string);
  }
  const referer = firstHeader(opts.headers["referer"]);
  if (!referer) return false;
  const refOrigin = normalizeOrigin(referer);
  return refOrigin !== null && allowed.has(refOrigin);
}

export function isStateChanging(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `https://a:443` → `https://a`. Karşılaştırma metin değil KÖKENDİR. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function cryptoRandom(n: number): Buffer {
  return randomBytes(n);
}