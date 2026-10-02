/**
 * Kimlik şifreleme — `credentials.access_token_enc` / `refresh_token_enc`
 * sütunlarının içeriğini üreten tek yer.
 *
 * KUTU BİÇİMİ SÖZLEŞMEDİR (`src/ports/index.ts`):
 *
 *   `v1:<base64url(nonce)>:<base64url(tag)>:<base64url(ciphertext)>`
 *
 * Bu dosya ALGORİTMANIN uygulamasıdır; biçimi değiştirmek `open`ı sessizce
 * okunamaz hale getirir. Yeni sürüm (`v2`) gerektiğinde `SUPPORTED_VERSIONS`'a
 * eklenir; ESKİ KUTULAR okunmaya devam eder.
 *
 * ── ANAHTAR NORMALİZASYONU ──────────────────────────────────────────────────
 * `SP_MASTER_KEY` base64 metindir ve normalde 32 bayt verir:
 *   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 *
 * KURAL (bilinçli tercih, geri alınırsa kullanıcı verisi kilitlenir):
 *   1. metin standart base64 olarak GEÇERLİ ve çözülürse → ÇÖZÜLEN baytlar
 *      anahtar malzemesidir;
 *   2. çözülemezse → metnin UTF-8 baytları anahtar malzemesidir
 *      (`base64 olmayan bir parola da çalışsın diye; base64 gibi görünüp
 *      çözülemeyen bir girdide sessizce farklı bir anahtar üretmek daha kötüdür);
 *   3. malzeme TAM 32 bayt ise olduğu gibi kullanılır (kullanıcının ürettiği
 *      anahtarla birebir aynı);
 *   4. DEĞİLSE `createHash("sha256")` ile deterministik olarak 32 bayta türetilir.
 *
 * 4. madde "kullanıcı 32 bayttan kısa/uzun bir anahtar koydu ve sürpriz
 * yaşadı" durumunu kapatır: AES-256-GCM 16/24/32 bayt kabul eder, biz yalnızca
 * 32 baytla çalışır ve türetme her zaman aynı sonucu verir (rastgelelik yok).
 *
 * ── NEDEN `expiresInSec` YOK ────────────────────────────────────────────────
 * Bir OAuth erişim belirteci zaten `access_token_expires_at` sütununda zaman
 * damgalıdır. Kutunun kendisine son kullanma damgası koymak ikinci bir
 * doğruluk kaynağı yaratır ve "kutu süresi doldu" ile "belirteç süresi doldu"
 * ayrımını bulanıklaştırır. Kimlikler KALICIDIR; yenileme ayrı bir işçi
 * kararıdır (`src/services` tarafında).
 *
 * ── NEDEN `open` HATA FIRLATIYOR ────────────────────────────────────────────
 * GCM şifre çözmede tag doğrulanamazsa sonuç ZAMAN İÇİNDE ANLAMSIZ bir metindir
 * ("Emoji kodu çözülemedi" gibi okunur). Sessizce eski metne düşmek, o
 * hesabın YANLIŞ hesap bilgisiyle yayın yapması demektir. Bu yüzden her
 * şüpheli durum `CredentialCipherError` fırlatır ve çağıran işi durdurur.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CredentialCipher } from "../ports/index.js";

/** Ürettiğimiz kutu sürümü. */
export const CIPHER_VERSION = "v1";

/** Okuyabildiğimiz sürümler. Bilinmeyen sürüm REDDEDİLİR (aşağı bak). */
export const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set([CIPHER_VERSION]);

/** GCM nonce boyutu. 96 bit tavsiye edilen değerdir. */
export const NONCE_BYTES = 12;
/** GCM kimlik doğrulama etiketi boyutu. */
export const TAG_BYTES = 16;
/** AES-256 anahtar boyutu. */
export const KEY_BYTES = 32;

const CIPHER_ALGORITHM = "aes-256-gcm";
/** Kutu ayracı. base64url `:` içermez, yani bölme tekildir. */
const SEPARATOR = ":";

export class CredentialCipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialCipherError";
  }
}

/** Anahtar hatası: yanlış anahtarla açma denemesi de BUDUR. */
export class MasterKeyError extends CredentialCipherError {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

// ── base64 yardımcıları ────────────────────────────────────────────────────

/** base64url sözlüğü: `+`/`/` yok, `-`/`_` var, dolgu `=` yok. */
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
/** Standart base64 (dolgu dâhil). Anahtar çözümü için. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Node'un base64 çözücüsü GEVŞEKTİR: geçersiz baytları SESSİZCE atar ve
 * kısaltılmış bir girdiden "başarılı" bir tampon üretir. Bu, bozuk kutu
 * yanlış metne çözülmesi demektir. Bu yüzden girdi DESENLE ve GERİ
 * KODLAMA denkliğiyle doğrulanır: ikisi de tutmuyorsa hata fırlatılır.
 */
function decodeBase64Url(part: string, label: string): Buffer {
  if (typeof part !== "string" || !BASE64URL_RE.test(part)) {
    throw new CredentialCipherError(
      `Kimlik kutusu bozuk: "${label}" alanı base64url değil (${JSON.stringify(part).slice(0, 40)}).`,
    );
  }
  const buf = Buffer.from(part, "base64url");
  if (buf.toString("base64url") !== part) {
    throw new CredentialCipherError(
      `Kimlik kutusu bozuk: "${label}" alanı çözülemiyor (${JSON.stringify(part).slice(0, 40)}).`,
    );
  }
  return buf;
}

/** Standart base64 metnini bayta çevirir; GEÇERLİ DEĞİLSE null döner. */
function decodeStandardBase64Strict(text: string): Buffer | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  const buf = Buffer.from(text, "base64");
  // Dolgu varyasyonları (`=` sayısı) dışında birebir aynı olmalı.
  return buf.toString("base64") === text ? buf : null;
}

// ── Anahtar ────────────────────────────────────────────────────────────────

/**
 * Anahtar malzemesini 32 bayta indirger. Dosya başındaki kuralların uygulanmış
 * hâli; saf fonksiyondur, test edilebilir.
 */
export function normalizeMasterKey(input: string | Buffer): Buffer {
  let material: Buffer;
  if (Buffer.isBuffer(input)) {
    material = Buffer.from(input);
  } else if (typeof input === "string") {
    // Boşluk KIRPILMAZ: anahtarın ne olduğu tahmin etmek, sessizce başka bir
    // anahtarla şifre çözmeYE çalışmaktan daha kötüdür (o zaman hata fırlatır).
    material = decodeStandardBase64Strict(input) ?? Buffer.from(input, "utf8");
  } else {
    throw new MasterKeyError(
      `Anahtar string ya da Buffer olmalı, gelen: ${typeof input}.`,
    );
  }

  if (material.length === 0) {
    throw new MasterKeyError("Anahtar boş olamaz (SP_MASTER_KEY tanımlı mı?).");
  }
  if (material.length === KEY_BYTES) return material;
  // Kısa/uzun anahtar: deterministik türetme. Rastgelelik YOK — aynı girdi
  // her zaman aynı anahtarı verir, yoksa veritabanındaki kutular açılmaz.
  return createHash("sha256").update(material).digest();
}

/**
 * `SP_MASTER_KEY` ile üretilmiş şifre çözücü.
 *
 * `seal` her çağrıda YENİ ve rastgele 12 baytlık nonce üretir: aynı düz metni
 * iki kez şifrelemek iki farklı kutu verir. Aksi halde aynı belirteç için iki
 * satırdaki zaman damgaları eşit olur ve "kaç ayrı hesap paylaşıyor" sorusu
 * cevaplanamaz hale gelir.
 */
export class AesGcmCipher implements CredentialCipher {
  /** 32 bayt. Dışarı verilmez ama testler uzunluğunu doğrulayabilsin diye okunur. */
  readonly key: Buffer;

  constructor(masterKey: string | Buffer) {
    this.key = normalizeMasterKey(masterKey);
    if (this.key.length !== KEY_BYTES) {
      // normalizeMasterKey bunu garanti eder; yine de savunma ayrımı kalsın:
      // "güvenliğe güveniyorum" diye bir varsayım olmasın.
      throw new MasterKeyError(`Anahtar ${KEY_BYTES} bayt olmalı, ${this.key.length} bayt geldi.`);
    }
  }

  seal(plain: string): string {
    if (typeof plain !== "string") {
      throw new CredentialCipherError(
        `seal düz metin (string) bekler, gelen: ${typeof plain}.`,
      );
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER_ALGORITHM, this.key, nonce, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      CIPHER_VERSION,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(SEPARATOR);
  }

  /**
   * Kutuyu açar. BİR KOŞULDA bile emin değilsek hata fırlatır:
   * biçim, sürüm, base64url geçerliliği, nonce/etiket boyutu, GCM etiketi.
   */
  open(sealed: string): string {
    if (typeof sealed !== "string" || sealed.length === 0) {
      throw new CredentialCipherError("Kimlik kutusu boş; çözülecek metin yok.");
    }

    const parts = sealed.split(SEPARATOR);
    if (parts.length !== 4) {
      throw new CredentialCipherError(
        `Kimlik kutusu bozuk: ${parts.length} alan bulundu, 4 bekleniyordu ` +
          `(sürüm:nonce:tag:ciphertext).`,
      );
    }
    const [version, noncePart, tagPart, dataPart] = parts as [string, string, string, string];

    if (!SUPPORTED_VERSIONS.has(version)) {
      throw new CredentialCipherError(
        `Desteklenmeyen kimlik kutusu sürümü: "${version}". ` +
          `Bu sürüm: ${[...SUPPORTED_VERSIONS].join(", ")}. ` +
          `ESKİ METNE DÜNÜLMEZ: kutu başka bir sürümle yazılmış, anahtar yanlış olabilir.`,
      );
    }

    const nonce = decodeBase64Url(noncePart, "nonce");
    const tag = decodeBase64Url(tagPart, "tag");
    const data = decodeBase64Url(dataPart, "ciphertext");

    if (nonce.length !== NONCE_BYTES) {
      throw new CredentialCipherError(
        `Kimlik kutusu bozuk: nonce ${nonce.length} bayt, ${NONCE_BYTES} bekleniyordu.`,
      );
    }
    if (tag.length !== TAG_BYTES) {
      throw new CredentialCipherError(
        `Kimlik kutusu bozuk: etiket ${tag.length} bayt, ${TAG_BYTES} bekleniyordu.`,
      );
    }

    try {
      const decipher = createDecipheriv(CIPHER_ALGORITHM, this.key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return plain.toString("utf8");
    } catch (err) {
      // `final()` GCM etiketi doğrulayamadığında fırlatır: kutu DEĞİŞTİRİLMİŞ,
      // anahtar YANLIŞ ya da veri bozuk. Üçü de "bu belirteci güvenme" demek.
      throw new CredentialCipherError(
        "Kimlik kutusu çözülemedi: şifre çözme etiketi doğrulanmadı " +
          "(kutu değiştirilmiş, anahtar farklı veya veri bozuk). " +
          "ESKİ METNE DÜNÜLMEZ.",
        { cause: err },
      );
    }
  }
}

/**
 * Anahtardan çözücü kurar. Anahtar yoksa `null` — çağıran "kimlik çözülemez"
 * durumunu bir çökme değil, GEREKÇELİ bir atlama olarak ele alır.
 */
export function createCipher(masterKey: string | Buffer | null | undefined): AesGcmCipher | null {
  if (masterKey === null || masterKey === undefined) return null;
  if (typeof masterKey !== "string" && !Buffer.isBuffer(masterKey)) {
    throw new MasterKeyError(`SP_MASTER_KEY string olmalı, gelen: ${typeof masterKey}.`);
  }
  return new AesGcmCipher(masterKey);
}

/** Ortam değişkeninden üretim çözücüsü (yoksa null). */
export function cipherFromEnv(env: NodeJS.ProcessEnv = process.env): AesGcmCipher | null {
  return createCipher(env["SP_MASTER_KEY"]);
}
