/**
 * Kimlik şifreleme testleri.
 *
 * Buradaki testler kriptografinin "iyi görünmesini" değil, ÜÇ DAVRANIŞI
 * kanıtlar:
 *   1) aynı düz metin iki kez şifrelendiğinde İKİ FARKLI kutu çıkar (nonce),
 *   2) kutu bir bayt değiştiğinde `open` HATA FIRLATIYOR (sessiz çözme yok),
 *   3) anahtar uzunluğu ne olursa olsun 32 bayttan farklı bir anahtar
 *      TAHMİN EDİLMEZ, deterministik türetilir.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AesGcmCipher,
  CIPHER_VERSION,
  CredentialCipherError,
  MasterKeyError,
  NONCE_BYTES,
  cipherFromEnv,
  createCipher,
  normalizeMasterKey,
} from "../../src/security/cipher.js";

const KEY_32 = randomBytes(32).toString("base64");

describe("AesGcmCipher — kutu biçimi", () => {
  it("sözleşmedeki biçimi üretir: v1:nonce:tag:ciphertext", () => {
    const cipher = new AesGcmCipher(KEY_32);
    const sealed = cipher.seal("IGQVABC123token");

    const parts = sealed.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(CIPHER_VERSION);
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(Buffer.from(parts[1] as string, "base64url")).toHaveLength(NONCE_BYTES);
    expect(Buffer.from(parts[2] as string, "base64url")).toHaveLength(16);
  });

  it("gidiş-dönüş: şifrelenen metin aynen geri gelir", () => {
    const cipher = new AesGcmCipher(KEY_32);
    const plain = "ya29.a0AfH6SMB-token|with|pipes";
    expect(cipher.open(cipher.seal(plain))).toBe(plain);
  });

  it("unicode ve boş metni de gidiş-dönüş yapar", () => {
    const cipher = new AesGcmCipher(KEY_32);
    for (const plain of ["", "şğüöçİğÜ 🎬 视频", "x".repeat(5000)]) {
      expect(cipher.open(cipher.seal(plain))).toBe(plain);
    }
  });

  it("her seal çağrısında YENİ nonce üretir: aynı metin → iki farklı kutu", () => {
    const cipher = new AesGcmCipher(KEY_32);
    const a = cipher.seal("aynı-belirteç");
    const b = cipher.seal("aynı-belirteç");

    expect(a).not.toBe(b);
    // nonce farklı olduğu için kutu metni de farklıdır (ciphertext da değişir).
    expect(a.split(":")[1]).not.toBe(b.split(":")[1]);
    // ...ama ikisi de doğru çözülür.
    expect(cipher.open(a)).toBe("aynı-belirteç");
    expect(cipher.open(b)).toBe("aynı-belirteç");
  });
});

describe("AesGcmCipher — reddedilen kutular (ESKİ METNE DÜNÜLMEZ)", () => {
  const cipher = new AesGcmCipher(KEY_32);
  const sealed = cipher.seal("gizli-belirteç");

  it("metin değiştirilince open patlar", () => {
    const parts = sealed.split(":");
    const data = parts[3] as string;
    // Son baytı değiştir: base64url'da son karakterin alt bitleri farklı
    // çözümler üretebilir; bu yüzden TÜM veri alanını yeniden kodlarız.
    const bytes = Buffer.from(data, "base64url");
    bytes[0] = (bytes[0] as number) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], bytes.toString("base64url")].join(":");

    expect(cipher.open(sealed)).toBe("gizli-belirteç");
    expect(() => cipher.open(tampered)).toThrow(CredentialCipherError);
  });

  it("etiket (tag) değiştirilince open patlar", () => {
    const parts = sealed.split(":");
    const tag = Buffer.from(parts[2] as string, "base64url");
    tag[0] = (tag[0] as number) ^ 0xff;
    const tampered = [parts[0], parts[1], tag.toString("base64url"), parts[3]].join(":");

    expect(() => cipher.open(tampered)).toThrow(CredentialCipherError);
  });

  it("v2 kutu reddedilir (sürüm zaten şifreleme yapmadan görünür)", () => {
    const parts = sealed.split(":");
    const asV2 = ["v2", ...parts.slice(1)].join(":");
    expect(() => cipher.open(asV2)).toThrow(/sürüm/i);
  });

  it("alan sayısı yanlışsa reddeder", () => {
    expect(() => cipher.open("v1:abc")).toThrow(CredentialCipherError);
    expect(() => cipher.open(`${sealed}:fazla`)).toThrow(CredentialCipherError);
    expect(() => cipher.open("")).toThrow(CredentialCipherError);
  });

  it("bozuk base64 reddedilir", () => {
    const parts = sealed.split(":");
    // '!' base64url sözlüğünde yok; sessizce atlanırsa yanlış metin çözülür.
    expect(() => cipher.open([parts[0], parts[1], parts[2], "!!!!"].join(":"))).toThrow(
      CredentialCipherError,
    );
    expect(() => cipher.open([parts[0], "değil-base64!!", parts[2], parts[3]].join(":"))).toThrow(
      CredentialCipherError,
    );
  });

  it("yanlış nonce/etiket boyutlarını reddeder", () => {
    const parts = sealed.split(":");
    const shortNonce = Buffer.alloc(8).toString("base64url");
    expect(() => cipher.open([parts[0], shortNonce, parts[2], parts[3]].join(":"))).toThrow(
      CredentialCipherError,
    );
  });

  it("başka bir anahtarla açılamaz", () => {
    const other = new AesGcmCipher(randomBytes(32).toString("base64"));
    expect(() => other.open(sealed)).toThrow(CredentialCipherError);
  });
});

describe("anahtar normalizasyonu", () => {
  it("32 bayttan kısa ve uzun anahtarlarla da çalışır", () => {
    const short = new AesGcmCipher("kısa-anahtar");
    const long = new AesGcmCipher(randomBytes(64).toString("base64"));

    for (const cipher of [short, long]) {
      const sealed = cipher.seal("token");
      expect(cipher.open(sealed)).toBe("token");
      expect(cipher.key).toHaveLength(32);
    }
  });

  it("32 bayttan farklı bir anahtar deterministik olarak türetilir", () => {
    // Aynı girdi iki kez → aynı anahtar: aksi hâlde veritabanındaki kutular
    // bir sonraki açılışta açılmaz.
    expect(normalizeMasterKey("kısa-anahtar").equals(normalizeMasterKey("kısa-anahtar"))).toBe(true);
    // 32 baytlık base64 anahtar olduğu gibi kullanılır (kullanıcının ürettiği
    // anahtarla birebir aynı olmalı).
    const raw = randomBytes(32);
    expect(normalizeMasterKey(raw.toString("base64")).equals(raw)).toBe(true);
  });

  it("boş anahtar reddedilir", () => {
    expect(() => createCipher("")).toThrow(MasterKeyError);
  });

  it("anahtar yoksa null döner (motor çökmez, kimlik çözülemez)", () => {
    expect(createCipher(null)).toBeNull();
    expect(createCipher(undefined)).toBeNull();
    expect(cipherFromEnv({})).toBeNull();
    const key = randomBytes(32).toString("base64");
    expect(cipherFromEnv({ SP_MASTER_KEY: key })?.seal("x")).toMatch(/^v1:/);
  });
});
