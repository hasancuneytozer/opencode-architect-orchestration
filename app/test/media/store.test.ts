/**
 * `FsMediaStore` testleri.
 *
 * EN ÖNEMLİ KISIM: path traversal. `storageKey` HTTP gövdesinden gelebiliyor;
 * `path.join(dir, key)` tek başına savunma değil. Aşağıdaki testler hem anahtarı
 * reddettiği hem de depodan DIŞARIDAKİ bir dosyanın ezilmediğini kanıtlıyor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  FsMediaStore,
  MediaStoreError,
  UnsafeStorageKeyError,
  assertSafeKey,
  encodeKeyForUrl,
  parseSignedUrl,
  signKey,
  verifySignature,
  verifySignedUrl,
} from "../../src/media/store.js";

const SECRET = "test-secret-0123456789";
const BASE = "https://cdn.example.com/media";

let tmpRoot: string;
let storeDir: string;
let outsideFile: string;
let store: FsMediaStore;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sp-store-"));
  storeDir = join(tmpRoot, "storage");
  // Depo dışında, saldırganın yazmak istediği yer.
  outsideFile = join(tmpRoot, "secret.txt");
  writeFileSync(outsideFile, "HAYIR-BU-DOSYAYA-DOKUNMA", "utf8");
  store = new FsMediaStore(storeDir, { publicBaseUrl: BASE, secret: SECRET });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("put / read / exists / remove turu", () => {
  it("Buffer yazar, okur, sayar, siler", async () => {
    const body = Buffer.from("merhaba medya deposu");
    const res = await store.put("2026/09/ornek.mp4", body);
    expect(res.key).toBe("2026/09/ornek.mp4");
    expect(res.bytes).toBe(body.length);
    expect(await store.exists("2026/09/ornek.mp4")).toBe(true);
    expect((await store.read("2026/09/ornek.mp4")).toString("utf8")).toBe("merhaba medya deposu");
    await store.remove("2026/09/ornek.mp4");
    expect(await store.exists("2026/09/ornek.mp4")).toBe(false);
  });

  it("akış (stream) yazar ve bayt sayar", async () => {
    const chunks = [Buffer.from("abc"), Buffer.from("defgh")];
    const res = await store.put("streams/v1.bin", Readable.from(chunks));
    expect(res.bytes).toBe(8);
    expect((await store.read("streams/v1.bin")).length).toBe(8);
  });

  it("aynı anahtar ikinci kez yazılabilir (üzerine yazma)", async () => {
    await store.put("a/b.txt", Buffer.from("birinci"));
    await store.put("a/b.txt", Buffer.from("ikinci"));
    expect((await store.read("a/b.txt")).toString("utf8")).toBe("ikinci");
  });

  it("okunmayan anahtar net hata verir", async () => {
    await expect(store.read("yok/olmayan.txt")).rejects.toThrow(MediaStoreError);
  });

  it("remove var olmayan dosyada hata vermez (idempotent)", async () => {
    await expect(store.remove("yok/olmayan.txt")).resolves.toBeUndefined();
  });

  it("pathFor mutlak yol döner ve dizini oluşturur", () => {
    const p = store.pathFor("derin/ic/klasor/dosya.mp4");
    expect(p.startsWith(store.root)).toBe(true);
    expect(p).toContain("derin");
  });
});

describe("GÜVENLİK: path traversal reddi", () => {
  const badKeys = [
    "../x",
    "../../etc/passwd",
    "a/../../b",
    "a/..",
    "./a",
    "a/./b",
    "/etc/passwd",
    "\\windows\\system32",
    "C:\\Windows\\system32\\config",
    "c:/windows",
    "a:b",
    "C:x",
    "file.txt:stream",
    "%2e%2e%2fx",
    "..%2fsecret.txt",
    "con",
    "con/x.mp4",
    "NUL/x",
    "a//b",
    "a/",
    "",
    "   ",
    " x/y",
  ];

  for (const key of badKeys) {
    it(`reddeder: ${JSON.stringify(key)}`, () => {
      expect(() => assertSafeKey(key)).toThrow(UnsafeStorageKeyError);
      expect(() => store.pathFor(key)).toThrow(UnsafeStorageKeyError);
    });
  }

  it("saldırgan depodan DIŞINDAKİ dosyayı ezemiyor", async () => {
    for (const key of ["../secret.txt", "..%2fsecret.txt", "..\\secret.txt", "/tmp/secret.txt"]) {
      await expect(store.put(key, Buffer.from("SOMEDONE"))).rejects.toThrow(
        UnsafeStorageKeyError,
      );
    }
    // Kanıt: dışarıdaki dosya hâlâ dokunulmamış.
    expect(readFileSync(outsideFile, "utf8")).toBe("HAYIR-BU-DOSYAYA-DOKUNMA");
  });

  it("geçerli anahtarlar kabul edilir", () => {
    for (const key of [
      "a.mp4",
      "2026/09/12/abc-def_123.mp4",
      "covers/kapak.jpg",
      "deep/a/b/c/d/e/f.bin",
      "unicode/şarkı-ölçü.mp4",
    ]) {
      expect(assertSafeKey(key)).toBe(key);
      expect(store.pathFor(key).startsWith(store.root)).toBe(true);
    }
  });
});

describe("publicUrl", () => {
  it("publicBaseUrl null ise null döner (uydurma adres üretmez)", () => {
    const local = new FsMediaStore(join(tmpRoot, "local"), {
      publicBaseUrl: null,
      secret: SECRET,
    });
    expect(local.publicUrl("a/b.mp4")).toBeNull();
  });

  it("ttlSec VERİLMEZSE kalıcı adres döner (expiresAt: null)", () => {
    const res = store.publicUrl("2026/09/a.mp4");
    expect(res).not.toBeNull();
    // Port sözleşmesi: kalıcı adres İMZASIZDIR ve süresi bildirilmez.
    expect(res?.expiresAt).toBeNull();
    const parsed = new URL(res?.url ?? "");
    expect(parsed.searchParams.get("expires")).toBeNull();
    expect(parsed.searchParams.get("sig")).toBeNull();
    expect(parsed.origin).toBe("https://cdn.example.com");
    expect(parsed.pathname).toBe("/media/2026/09/a.mp4");
  });

  it("imzalı ve süreli URL üretir (expiresAt epoch ms)", () => {
    const res = store.publicUrl("2026/09/a.mp4", { ttlSec: 600 });
    expect(res).not.toBeNull();
    expect(res?.url).toContain("https://cdn.example.com/media/2026/09/a.mp4");
    const parsed = new URL(res?.url ?? "");
    expect(parsed.origin).toBe("https://cdn.example.com");
    expect(parsed.pathname).toBe("/media/2026/09/a.mp4");
    const expires = Number(parsed.searchParams.get("expires"));
    const sig = parsed.searchParams.get("sig") ?? "";
    expect(Number.isInteger(expires)).toBe(true);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(sig.length).toBeGreaterThan(20);
    // expiresAt ms cinsinden ve URL'deki saniye değerine birebir uyar.
    expect(res?.expiresAt).toBe(expires * 1000);
    expect(typeof res?.expiresAt).toBe("number");
  });

  it("ttlSec 600 → ömür yaklaşık 600 saniye", () => {
    const now = Math.floor(Date.now() / 1000);
    const res = store.publicUrl("a.mp4", { ttlSec: 600 });
    const expires = Number(new URL(res?.url ?? "").searchParams.get("expires"));
    const ttl = expires - now;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("süresi dolmuş imza doğru şekilde reddedilir", () => {
    const url = store.publicUrl("a.mp4", { ttlSec: 600 })?.url ?? "";
    const parts = parseSignedUrl(url, { basePathname: "/media" });
    expect(parts).not.toBeNull();
    const expiredAt = (parts as { expires: number }).expires;
    const future = store.verifyPublicUrl(url, { nowSec: expiredAt + 1 });
    expect(future.ok).toBe(false);
    expect(future.ok === false && future.reason).toBe("expired");
    // Süresi dolmadan hemen önce geçerli.
    const justBefore = store.verifyPublicUrl(url, { nowSec: expiredAt - 1 });
    expect(justBefore.ok).toBe(true);
  });

  it("imza değiştirilirse reddedilir (timingSafeEqual yolu)", () => {
    const url = store.publicUrl("a.mp4", { ttlSec: 600 })?.url ?? "";
    const parts = parseSignedUrl(url, { basePathname: "/media" }) as {
      key: string;
      expires: number;
      signature: string;
    };
    const tampered =
      `${BASE}/${encodeKeyForUrl(parts.key)}` +
      `?expires=${parts.expires}&sig=${parts.signature.slice(0, -2)}xx`;
    const result = store.verifyPublicUrl(tampered);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("bad_signature");
  });

  it("başka anahtarla imzalanmış sig reddedilir", () => {
    const url = new URL(store.publicUrl("a.mp4", { ttlSec: 600 })?.url ?? "");
    url.pathname = "/media/b.mp4";
    const result = store.verifyPublicUrl(url.toString());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("bad_signature");
  });

  it("başka sır ile imzalanmış sig reddedilir", () => {
    const parts = parseSignedUrl(store.publicUrl("a.mp4", { ttlSec: 600 })?.url ?? "", {
      basePathname: "/media",
    }) as { key: string; expires: number; signature: string };
    const other = verifySignature("baska-sir-0123456789", parts.key, parts.expires, parts.signature);
    expect(other).toBe(false);
  });

  it("ttlSec <= 0 reddedilir; kalıcı adres için ttlSec verilmez", () => {
    expect(() => store.publicUrl("a.mp4", { ttlSec: 0 })).toThrow(MediaStoreError);
    expect(() => store.publicUrl("a.mp4", { ttlSec: -5 })).toThrow(MediaStoreError);
    expect(() => store.publicUrl("a.mp4", { ttlSec: Number.NaN })).toThrow(MediaStoreError);
    // Kalıcı adres bir İSTİSNA değil, ayrı bir yol: ttlSec hiç verilmez.
    expect(store.publicUrl("a.mp4")?.expiresAt).toBeNull();
  });

  it("varsayılan ömür tanımlanmışsa ttlSec verilmemiş çağrıyı da kapsar", () => {
    const withDefault = new FsMediaStore(join(tmpRoot, "with-default"), {
      publicBaseUrl: BASE,
      secret: SECRET,
      defaultUrlTtlSec: 3600,
    });
    expect(withDefault.publicUrl("a.mp4")?.expiresAt).toBeGreaterThan(Date.now());
    // Tanımlıysa ttlSec yine üstüne yazar.
    expect(withDefault.publicUrl("a.mp4", { ttlSec: 60 })?.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("imza yardımcıları (ayrı test)", () => {
  it("signKey aynı girdi için aynı, farklı girdi için farklı imza üretir", () => {
    const a = signKey(SECRET, "k", 100);
    expect(a).toBe(signKey(SECRET, "k", 100));
    expect(a).not.toBe(signKey(SECRET, "k", 101));
    expect(a).not.toBe(signKey(SECRET, "k2", 100));
    expect(a).not.toBe(signKey("other-secret-0123", "k", 100));
  });

  it("verifySignature süreyi ayrıca denetler", () => {
    const sig = signKey(SECRET, "k", 1000);
    expect(verifySignature(SECRET, "k", 1000, sig, 999)).toBe(true);
    expect(verifySignature(SECRET, "k", 1000, sig, 1000)).toBe(false);
    expect(verifySignature(SECRET, "k", 1000, sig, 1001)).toBe(false);
    expect(verifySignature(SECRET, "k", 1000, "kisa", 999)).toBe(false);
  });

  it("verifySignedUrl bozuk girdide 'malformed' döner", () => {
    expect(verifySignedUrl("https://x/y", SECRET)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignedUrl("https://x/y?expires=abc&sig=zz", SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseSignedUrl("gectersiz-adres")).toBeNull();
  });
});

describe("constructor doğrulaması", () => {
  it("kısa sır ve boş dizin reddedilir", () => {
    expect(() => new FsMediaStore(join(tmpRoot, "x"), { publicBaseUrl: null, secret: "kisa" })).toThrow(
      MediaStoreError,
    );
    expect(() => new FsMediaStore("", { publicBaseUrl: null, secret: SECRET })).toThrow(
      MediaStoreError,
    );
  });
});
