/**
 * Yeniden deneme politikası testleri. Tamamı deterministik: jitter kaynağı
 * `random` parametresi olarak enjekte edilir, saat hiç okunmaz.
 *
 * KİLİTLENEN SIRA: ilk retry TAM `baseDelayMs` bekler, sonrakiler İKİYE KATLAR.
 * Bu sıra bir kez bozulduğunda ilk hata en çok bekler, sonrakiler daha çabuk
 * gelir — yani en pahalı hatada daha az sabır. Test tablosu bunu sabitler.
 */
import { describe, expect, it } from "vitest";

import { PUBLISH_ERROR_KINDS, isRetryableKind } from "../../src/contract/index.js";
import type { PublishErrorKind } from "../../src/contract/index.js";
import {
  DEFAULT_RETRY_POLICY,
  effectiveMaxAttempts,
  nextDelayMs,
  shouldRetry,
} from "../../src/domain/retry.js";

/** Jitter'ı kapatan deterministik kaynak. */
const noJitter = (): number => 0.5;
const BASE = 2_000;
const CAP = 300_000;

describe("nextDelayMs — geri çekilme sırası", () => {
  it("ilk retry TAM baseDelayMs bekler (jitter kapalı)", () => {
    expect(nextDelayMs(2, { jitter: 0 })).toBe(BASE);
    expect(nextDelayMs(2, { random: noJitter })).toBe(BASE);
  });

  it("sonraki retry'ler ikiye katlar", () => {
    const seen = [2, 3, 4, 5].map((a) => nextDelayMs(a, { jitter: 0 }));
    expect(seen).toEqual([BASE, 2 * BASE, 4 * BASE, 8 * BASE]);
  });

  it("1. deneme için de makul bir değer döner (formülün alt kenarı)", () => {
    // attempt=1 için üs -1 olurdu; base/2 beklemenin anlamı yok, tabana klamp edilir.
    expect(nextDelayMs(1, { jitter: 0 })).toBe(BASE);
    expect(nextDelayMs(0, { jitter: 0 })).toBe(BASE);
  });

  it("tavanı aşmaz", () => {
    expect(nextDelayMs(30, { jitter: 0 })).toBe(CAP);
    // jitter ile birlikte de tavanı aşamaz (+%20 -> 360s olurdu).
    expect(nextDelayMs(30, { random: () => 1 })).toBe(CAP);
  });

  it("özel politika değerlerini uygular", () => {
    expect(nextDelayMs(3, { baseDelayMs: 1_000, jitter: 0 })).toBe(2_000);
    // Tavan yalnız DÜŞÜRür: 4. denemede 8000 -> 1500.
    expect(nextDelayMs(4, { baseDelayMs: 1_000, maxDelayMs: 1_500, jitter: 0 })).toBe(1_500);
    // Tavanın altındaki değere dokunmaz.
    expect(nextDelayMs(2, { baseDelayMs: 1_000, maxDelayMs: 1_500, jitter: 0 })).toBe(1_000);
  });

  it("jitter enjekte edilen random ile birebir deterministik", () => {
    expect(nextDelayMs(2, { random: () => 0 })).toBe(1_600); // -%20
    expect(nextDelayMs(2, { random: () => 1 })).toBe(2_400); // +%20
    expect(nextDelayMs(2, { random: () => 0.5 })).toBe(BASE); // 0 sapma
  });

  it("varsayılan jitter %20'dir (DEFAULT_RETRY_POLICY)", () => {
    expect(DEFAULT_RETRY_POLICY.jitter).toBe(0.2);
    expect(nextDelayMs(4, { random: () => 1 })).toBe(9_600); // 8000 * 1.2
  });

  it("ratelimit ve network için çok daha uzun bekler (tavuk–karşı–la)", () => {
    expect(nextDelayMs(2, { kind: "ratelimit", jitter: 0 })).toBe(8_000);
    expect(nextDelayMs(2, { kind: "network", jitter: 0 })).toBe(4_000);
    expect(nextDelayMs(2, { kind: "server", jitter: 0 })).toBe(2_000);
    expect(nextDelayMs(3, { kind: "ratelimit", jitter: 0 })).toBe(16_000);
    expect(nextDelayMs(3, { kind: "network", jitter: 0 })).toBe(8_000);
  });

  it("retryAfterMs ALT SINIR olur, ama tavanı aşmaz", () => {
    expect(nextDelayMs(2, { jitter: 0, retryAfterMs: 9_000 })).toBe(9_000);
    // Sağlayıcı daha kısa bir bekleme istiyorsa hesabımız ağır basar.
    expect(nextDelayMs(2, { jitter: 0, retryAfterMs: 100 })).toBe(2_000);
    // 10 dakikalık Retry-After bile 300s tavanına kırpılır.
    expect(nextDelayMs(2, { jitter: 0, retryAfterMs: 600_000 })).toBe(CAP);
  });

  it("geçersiz attempt için hata fırlatır (sessizce yanlış programlanmaz)", () => {
    expect(() => nextDelayMs(Number.NaN)).toThrow(RangeError);
  });

  it("bozuk politika değerlerini varsayılana döndürür", () => {
    expect(nextDelayMs(3, { baseDelayMs: 0, jitter: 0 })).toBe(4_000);
    expect(nextDelayMs(3, { baseDelayMs: -5, jitter: 0 })).toBe(4_000);
  });
});

describe("shouldRetry", () => {
  it("geçici sınıfları kabul eder", () => {
    for (const kind of ["network", "ratelimit", "server", "transient"] as const) {
      expect(shouldRetry(kind, 2)).toBe(true);
    }
  });

  it("kalıcı sınıfları reddeder", () => {
    for (const kind of [
      "validation",
      "auth",
      "policy",
      "quota",
      "media_rejected",
      "container_expired",
      "not_public",
      "unknown",
    ] as const) {
      expect(shouldRetry(kind, 1)).toBe(false);
    }
  });

  it("sözleşmedeki geçici sınıflarla birebir uyuşur", () => {
    for (const kind of PUBLISH_ERROR_KINDS) {
      expect(shouldRetry(kind, 1)).toBe(isRetryableKind(kind));
    }
  });

  it("maxAttempts (varsayılan 5) sonrası durur", () => {
    expect(shouldRetry("network", 5)).toBe(true);
    expect(shouldRetry("network", 6)).toBe(false);
    expect(shouldRetry("network", 4, { maxAttempts: 3 })).toBe(false);
    expect(shouldRetry("network", 3, { maxAttempts: 3 })).toBe(true);
  });

  it("perKindMaxAttempts genel sınırı ezer", () => {
    const policy = { maxAttempts: 5, perKindMaxAttempts: { ratelimit: 2 } };
    expect(effectiveMaxAttempts("ratelimit", policy)).toBe(2);
    expect(effectiveMaxAttempts("network", policy)).toBe(5);
    expect(shouldRetry("ratelimit", 2, policy)).toBe(true);
    expect(shouldRetry("ratelimit", 3, policy)).toBe(false);
    expect(shouldRetry("network", 3, policy)).toBe(true);
  });

  it("kalıcı hata tüm denemelerde reddedilir (deneme sayısı hiçbir şeyi değiştirmez)", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(shouldRetry("quota", attempt)).toBe(false);
      expect(shouldRetry("auth", attempt)).toBe(false);
    }
  });

  it("tüm sınıflar için tanımlı politika ile çalışır", () => {
    const policy: Parameters<typeof shouldRetry>[2] = {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitter: 0,
    };
    for (const kind of PUBLISH_ERROR_KINDS) {
      const decided = shouldRetry(kind, 2, policy);
      expect(typeof decided).toBe("boolean");
      expect(decided).toBe(isRetryableKind(kind as PublishErrorKind));
    }
  });
});