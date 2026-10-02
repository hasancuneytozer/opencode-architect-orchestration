/**
 * Sağlayıcı hata eşleme testleri.
 *
 * TEST, TABLOYU DEĞİL BRİEF'TEKİ GERÇEKLERİ KONTROL EDER: aşağıdaki beklenti
 * listeleri paket brifingindeki tabloların birebir kopyasıdır. Tabloyu
 * `for` döngüsüyle kendi kendine test etmek "tablo kendi kendini doğruladı"
 * olurdu ve yanlış sınıflandırmayı fark etmezdi.
 *
 * EK KURAL: her satır için `retryable === isRetryableKind(kind)` de doğrulanır.
 * `retryable` ayrı yazılmadığı için bu zaten yapısal olarak doğrudur; test
 * bir gün kural gevşerse kırılır.
 */
import { describe, expect, it } from "vitest";

import { isRetryableKind } from "../../src/contract/index.js";
import type { PublishErrorKind } from "../../src/contract/index.js";
import {
  META_ERROR_CODES,
  META_ERROR_SUBCODES,
  TIKTOK_FAIL_REASONS,
  YOUTUBE_REASONS,
  mapMetaError,
  mapMetaStatus,
  mapTikTokFailReason,
  mapYouTubeReason,
} from "../../src/domain/providerErrors.js";

function assertConsistent(kind: PublishErrorKind, retryable: boolean): void {
  expect(retryable).toBe(isRetryableKind(kind));
}

describe("TikTok fail_reason", () => {
  const EXPECTED: Array<[string, PublishErrorKind, boolean]> = [
    ["file_format_check_failed", "media_rejected", false],
    ["duration_check_failed", "media_rejected", false],
    ["frame_rate_check_failed", "media_rejected", false],
    ["picture_size_check_failed", "media_rejected", false],
    ["internal", "transient", true],
    ["video_pull_failed", "transient", true],
    ["photo_pull_failed", "transient", true],
    ["publish_cancelled", "policy", false],
    ["auth_removed", "auth", false],
    ["spam_risk_too_many_posts", "quota", false],
    ["spam_risk_user_banned_from_posting", "policy", false],
    ["spam_risk_text", "policy", false],
    ["spam_risk", "policy", false],
  ];

  for (const [reason, kind, retryable] of EXPECTED) {
    it(`${reason} → ${kind} (${retryable ? "geçici" : "kalıcı"})`, () => {
      const r = mapTikTokFailReason(reason);
      expect(r.kind).toBe(kind);
      expect(r.retryable).toBe(retryable);
      expect(r.providerCode).toBe(reason);
      expect(r.message.length).toBeGreaterThan(10);
      assertConsistent(r.kind, r.retryable);
    });
  }

  it("tablodaki her satır brifing tablosunda da var", () => {
    expect([...TIKTOK_FAIL_REASONS.keys()].sort()).toEqual(EXPECTED.map(([c]) => c).sort());
  });

  it("null / boş / bilinmeyen → unknown ve KALICI", () => {
    for (const input of [null, undefined, "", "   ", "bilinmeyen_kod", "INTERNAL"]) {
      const r = mapTikTokFailReason(input as string | null | undefined);
      expect(r.kind).toBe("unknown");
      expect(r.retryable).toBe(false);
    }
  });

  it("baştaki/sondaki boşluk temizlenir", () => {
    expect(mapTikTokFailReason("  internal  ").kind).toBe("transient");
  });
});

describe("Meta error code/subcode", () => {
  const SUBCODES: Array<[[number, number], PublishErrorKind, boolean]> = [
    [[9, 2207042], "quota", false],
    [[4, 2207051], "policy", false],
    [[25, 2207050], "policy", false],
    [[-2, 2207003], "transient", true],
  ];

  for (const [[code, subcode], kind, retryable] of SUBCODES) {
    it(`code ${code} / subcode ${subcode} → ${kind} (${retryable ? "geçici" : "kalıcı"})`, () => {
      const r = mapMetaError({ code, subcode });
      expect(r.kind).toBe(kind);
      expect(r.retryable).toBe(retryable);
      expect(r.providerCode).toBe(`${code}/${subcode}`);
      assertConsistent(r.kind, r.retryable);
    });
  }

  const CODES: Array<[number, PublishErrorKind, boolean]> = [
    [9004, "network", true],
    [80002, "ratelimit", true],
  ];

  for (const [code, kind, retryable] of CODES) {
    it(`error.code ${code} → ${kind} (${retryable ? "geçici" : "kalıcı"})`, () => {
      const r = mapMetaError({ errorCode: code });
      expect(r.kind).toBe(kind);
      expect(r.retryable).toBe(retryable);
      expect(r.providerCode).toBe(String(code));
      assertConsistent(r.kind, r.retryable);
    });
  }

  it("subcodes ve codes tabloları brifingle birebir", () => {
    expect([...META_ERROR_SUBCODES.keys()].sort()).toEqual(
      SUBCODES.map(([[c, s]]) => `${c}/${s}`).sort(),
    );
    expect([...META_ERROR_CODES.keys()].sort()).toEqual(CODES.map(([c]) => String(c)).sort());
  });

  it("bilinmeyen code/subcode → unknown ve KALICI (sessizce geçici sayılmaz)", () => {
    const r = mapMetaError({ code: 999, subcode: 999999 });
    expect(r.kind).toBe("unknown");
    expect(r.retryable).toBe(false);
    expect(r.message).toContain("999/999999");
  });

  it("subcodesiz code 9 doğrulanmış satır olmadığı için unknown", () => {
    const r = mapMetaError({ code: 9 });
    expect(r.kind).toBe("unknown");
    expect(r.retryable).toBe(false);
  });

  it("tamamen boş girdi → unknown", () => {
    expect(mapMetaError({}).kind).toBe("unknown");
    expect(mapMetaError({ code: null, subcode: null }).retryable).toBe(false);
  });

  it("error.code önceliklidir, status_code'a göre", () => {
    const r = mapMetaError({ errorCode: 80002, code: 9, subcode: 2207042, statusCode: "ERROR" });
    expect(r.kind).toBe("ratelimit");
  });

  it("status_code, hata alanı yoksa devreye girer", () => {
    const r = mapMetaError({ statusCode: "EXPIRED" });
    expect(r.kind).toBe("container_expired");
    expect(r.retryable).toBe(false);
  });
});

describe("Meta status_code", () => {
  it("IN_PROGRESS → processing, terminal değil", () => {
    const r = mapMetaStatus("IN_PROGRESS");
    expect(r.status).toBe("processing");
    expect(r.terminal).toBe(false);
    expect(r.kind).toBeNull();
    expect(r.retryable).toBe(true);
  });

  it("FINISHED → hazır (yayınlama adımı bekliyor), terminal değil", () => {
    const r = mapMetaStatus("FINISHED");
    expect(r.status).toBe("ready");
    expect(r.terminal).toBe(false);
    expect(r.kind).toBeNull();
  });

  it("PUBLISHED → yayında, terminal, hata değil", () => {
    const r = mapMetaStatus("PUBLISHED");
    expect(r.status).toBe("published");
    expect(r.terminal).toBe(true);
    expect(r.kind).toBeNull();
    expect(r.retryable).toBe(false);
  });

  it("ERROR → kalıcı medya hatası, terminal", () => {
    const r = mapMetaStatus("ERROR");
    expect(r.status).toBe("failed");
    expect(r.kind).toBe("media_rejected");
    expect(r.retryable).toBe(false);
    expect(r.terminal).toBe(true);
  });

  it("EXPIRED → container_expired, kalıcı, terminal", () => {
    const r = mapMetaStatus("EXPIRED");
    expect(r.status).toBe("expired");
    expect(r.kind).toBe("container_expired");
    expect(r.retryable).toBe(false);
    expect(r.terminal).toBe(true);
  });

  it("küçük harf ve boşluk normalize edilir", () => {
    expect(mapMetaStatus("  in_progress ").status).toBe("processing");
  });

  it("bilinmeyen/null durum kodu → unknown, kalıcı, ama iş kapatılmaz", () => {
    for (const input of [null, undefined, "", "WAT"]) {
      const r = mapMetaStatus(input as string | null | undefined);
      expect(r.status).toBe("unknown");
      expect(r.kind).toBe("unknown");
      expect(r.retryable).toBe(false);
      expect(r.terminal).toBe(false);
    }
  });
});

describe("YouTube reason", () => {
  const EXPECTED: Array<[string, PublishErrorKind, boolean]> = [
    ["uploadLimitExceeded", "quota", false],
    ["dailyLimitExceeded", "quota", false],
    ["rateLimitExceeded", "ratelimit", true],
    ["invalidVideo", "media_rejected", false],
    ["invalidPublishAtTime", "validation", false],
    ["unauthorized", "auth", false],
    // YouTube, OAuth kapsamı eksikken `forbidden` değil `insufficientPermissions`
    // döner. Ayrı satır: kalıcı ve "yeniden yetkilendir" yönlendirmesi gerekir.
    ["insufficientPermissions", "auth", false],
    ["forbidden", "policy", false],
    ["internalServerError", "server", true],
    ["serviceUnavailable", "server", true],
    ["youtubeSignupRequired", "policy", false],
  ];

  for (const [reason, kind, retryable] of EXPECTED) {
    it(`${reason} → ${kind} (${retryable ? "geçici" : "kalıcı"})`, () => {
      const r = mapYouTubeReason(reason);
      expect(r.kind).toBe(kind);
      expect(r.retryable).toBe(retryable);
      expect(r.providerCode).toBe(reason);
      assertConsistent(r.kind, r.retryable);
    });
  }

  it("tablo brifingle birebir", () => {
    expect([...YOUTUBE_REASONS.keys()].sort()).toEqual(EXPECTED.map(([c]) => c).sort());
  });

  it("null / boş / bilinmeyen → unknown ve KALICI", () => {
    for (const input of [null, undefined, "", "quotaExceeded"]) {
      const r = mapYouTubeReason(input as string | null | undefined);
      expect(r.kind).toBe("unknown");
      expect(r.retryable).toBe(false);
    }
  });

  it("YouTube 5xx sınıfı GEÇİCİ, kota/politika KALICI", () => {
    expect(mapYouTubeReason("internalServerError").retryable).toBe(true);
    expect(mapYouTubeReason("serviceUnavailable").retryable).toBe(true);
    expect(mapYouTubeReason("dailyLimitExceeded").retryable).toBe(false);
  });
});

describe("üç eşleme tablosu birbirinden bağımsız", () => {
  it("aynı ham kod farklı platformda farklı sınıfa düşebilir", () => {
    // Meta "ERROR" kalıcı medya hatasıdır; YouTube'da "ERROR" diye bir reason yok.
    expect(mapMetaStatus("ERROR").kind).toBe("media_rejected");
    expect(mapYouTubeReason("ERROR").kind).toBe("unknown");
  });

  it("prototip anahtarları tabloya sızmaz (constructor/toString)", () => {
    expect(mapTikTokFailReason("constructor").kind).toBe("unknown");
    expect(mapTikTokFailReason("__proto__").kind).toBe("unknown");
    expect(mapYouTubeReason("toString").kind).toBe("unknown");
    expect(mapMetaStatus("hasOwnProperty").status).toBe("unknown");
  });

  it("her eşleme mesaj üretir (panelde boş metin gösterilmez)", () => {
    for (const code of TIKTOK_FAIL_REASONS.keys()) {
      expect(mapTikTokFailReason(code).message.trim().length).toBeGreaterThan(5);
    }
    for (const code of YOUTUBE_REASONS.keys()) {
      expect(mapYouTubeReason(code).message.trim().length).toBeGreaterThan(5);
    }
    for (const code of META_ERROR_SUBCODES.keys()) {
      const [c, s] = code.split("/") as [string, string];
      expect(mapMetaError({ code: Number(c), subcode: Number(s) }).message.trim().length).toBeGreaterThan(
        5,
      );
    }
  });
});