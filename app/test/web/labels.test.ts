/**
 * `web/src/lib/labels.ts` — sözleşmedeki HER `PublishErrorKind`, 8 iş durumu,
 * 8 içerik durumu.
 *
 * Kapsam testi kasıtlıdır: sözleşmede (`src/contract`) bir `PublishErrorKind`
 * eklendiğinde veya etiketi düzeltildiğinde burada kırılır. Sessizce eksik bir
 * sınıf kalmaması için tablolar sözleşmeyle KARŞILAŞTIRILIR.
 *
 * ⚠️ Sınıf SAYISI SERT KODLANMAZ. Daha önce "13" yazılmıştı; sözleşmede 12
 * sınıf vardır ve `labels.ts` de 12 anahtarlıydı — yani sayı yanlıştı, tablo
 * değil. Doğru kıyas noktası tek kaynaktır: `PUBLISH_ERROR_KINDS`. Yeni bir
 * sınıf eklendiğinde hem bu test hem `Record<PublishErrorKind, …>` tipi
 * (derleyici) kırmızıya döner ve karşılığı yazılmak zorunda kalır.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_CONTENT_STATES,
  ALL_JOB_STATES,
  PUBLISH_ERROR_KINDS,
  isRetryableKind,
} from "../../src/contract/index.js";
import type { ContentState, JobState, PublishErrorKind } from "../../src/contract/index.js";
import {
  ACCOUNT_STATUS_META,
  CONTENT_STATE_META,
  ERROR_KIND_META,
  JOB_STATE_META,
  PLATFORM_META,
  SEVERITY_META,
  errorKindMeta,
  isFuture,
  platformLabel,
  trLower,
} from "../../web/src/lib/labels.js";

describe("sözleşmedeki HER PublishErrorKind değeri etiketlenmiş", () => {
  it("sözleşme boş değil ve sınıfları tekil", () => {
    expect(PUBLISH_ERROR_KINDS.length).toBeGreaterThan(0);
    expect(PUBLISH_ERROR_KINDS).toHaveLength(new Set<string>(PUBLISH_ERROR_KINDS).size);
  });

  it("etiket tablosu sözleşmedeki sınıf sayısıyla birebir aynı", () => {
    // SERT KOD YOK. Sözleşmede 12 sınıf var ve tablo da 12 anahtarlı.
    expect(Object.keys(ERROR_KIND_META)).toHaveLength(PUBLISH_ERROR_KINDS.length);
  });

  it("her sınıfın tam olarak bir karşılığı var", () => {
    for (const kind of PUBLISH_ERROR_KINDS) {
      expect(ERROR_KIND_META[kind], `${kind} karşılığı eksik`).toBeDefined();
      expect(Object.keys(ERROR_KIND_META)).toContain(kind);
    }
  });

  it("tabloda sözleşmede olmayan fazladan anahtar yok", () => {
    const contractKinds = new Set<string>(PUBLISH_ERROR_KINDS);
    for (const key of Object.keys(ERROR_KIND_META)) {
      expect(contractKinds.has(key), `${key} sözleşmede yok`).toBe(true);
    }
  });

  it("her sınıfın etiketi, açıklaması ve yönlendirmesi boş değil", () => {
    for (const kind of PUBLISH_ERROR_KINDS) {
      const meta = errorKindMeta(kind);
      expect(meta.label.length, `${kind} etiketi boş`).toBeGreaterThan(0);
      expect(meta.detail.length, `${kind} açıklaması boş`).toBeGreaterThan(4);
      expect(meta.action.length, `${kind} yönlendirmesi boş`).toBeGreaterThan(4);
    }
  });

  it("etiketler çıplak kod değil, insan dilinde cümle", () => {
    expect(ERROR_KIND_META.quota.label).toBe("Günlük kota doldu");
    expect(ERROR_KIND_META.quota.detail).toContain("YAYINLANMADI");
    expect(ERROR_KIND_META.ratelimit.label).toBe("Hız sınırı");
    expect(ERROR_KIND_META.container_expired.label).toBe("Kapsayıcı süresi doldu");
    expect(ERROR_KIND_META.media_rejected.label).toBe("Video reddedildi");
    expect(ERROR_KIND_META.not_public.label).toBe("İçerik herkese açık değil");
    expect(ERROR_KIND_META.auth.label).toBe("Yetki hatası");
    expect(ERROR_KIND_META.policy.label).toBe("Platform politikası");
    expect(ERROR_KIND_META.validation.label).toBe("Doğrulama hatası");
    expect(ERROR_KIND_META.network.label).toBe("Ağ hatası");
    expect(ERROR_KIND_META.server.label).toBe("Sağlayıcı hatası");
    expect(ERROR_KIND_META.transient.label).toBe("Geçici hata");
    expect(ERROR_KIND_META.unknown.label).toBe("Sınıflandırılamayan hata");
  });

  it("otomatik tekrar bayrağı sözleşmedeki politikayla aynı", () => {
    for (const kind of PUBLISH_ERROR_KINDS) {
      expect(ERROR_KIND_META[kind].autoRetryable, `${kind} politikayla çelişiyor`).toBe(
        isRetryableKind(kind),
      );
    }
  });

  it("geçici sınıflar otomatik, kalıcı sınıflar elle müdahale ister", () => {
    const auto = PUBLISH_ERROR_KINDS.filter((k) => ERROR_KIND_META[k].autoRetryable);
    expect(auto.sort()).toEqual(["network", "ratelimit", "server", "transient"]);
    // "quota" geçici olsa da yayın yapmaz; otomatik tekrar listede değil
    expect(ERROR_KIND_META.quota.autoRetryable).toBe(false);
    expect(ERROR_KIND_META.quota.detail).toContain("YAYINLANMADI");
  });
});

describe("8 JobState", () => {
  it("sözleşmede 8 iş durumu var ve hepsi etiketli", () => {
    expect(ALL_JOB_STATES).toHaveLength(8);
    expect(Object.keys(JOB_STATE_META)).toHaveLength(8);
    for (const state of ALL_JOB_STATES) {
      expect(JOB_STATE_META[state].label.length).toBeGreaterThan(0);
      expect(JOB_STATE_META[state].help.length).toBeGreaterThan(4);
    }
  });

  it("published ve published_no_link farklı rozetlerdir", () => {
    expect(JOB_STATE_META.published.label).toBe("Yayınlandı");
    expect(JOB_STATE_META.published_no_link.label).toBe("Yayınlandı, link yok");
    expect(JOB_STATE_META.published.tone).not.toBe(JOB_STATE_META.published_no_link.tone);
  });

  it("hareketli durumlar progress tonundadır", () => {
    for (const state of ["preparing", "uploading", "processing"] as const) {
      expect(JOB_STATE_META[state].tone).toBe("progress");
    }
  });

  it("iptal soluk, başarısız kırmızı", () => {
    expect(JOB_STATE_META.canceled.tone).toBe("muted");
    expect(JOB_STATE_META.failed.tone).toBe("danger");
    expect(JOB_STATE_META.queued.tone).toBe("idle");
  });
});

describe("8 ContentState", () => {
  it("sözleşmede 8 içerik durumu var ve hepsi etiketli", () => {
    expect(ALL_CONTENT_STATES).toHaveLength(8);
    expect(Object.keys(CONTENT_STATE_META)).toHaveLength(8);
    for (const state of ALL_CONTENT_STATES) {
      expect(CONTENT_STATE_META[state].label.length).toBeGreaterThan(0);
      expect(CONTENT_STATE_META[state].help.length).toBeGreaterThan(4);
    }
  });

  it("partial uyarı tonunda, published yeşil", () => {
    expect(CONTENT_STATE_META.partial.tone).toBe("warn");
    expect(CONTENT_STATE_META.published.tone).toBe("ok");
  });

  it("ilerleyen durumlar progress tonundadır", () => {
    expect(CONTENT_STATE_META.validating.tone).toBe("progress");
    expect(CONTENT_STATE_META.scheduled.tone).toBe("info");
  });
});

describe("hesap durumu", () => {
  it("needs_reauth kırmızı ve öncelikli görünür", () => {
    expect(ACCOUNT_STATUS_META.needs_reauth.tone).toBe("danger");
    expect(ACCOUNT_STATUS_META.needs_reauth.help).toContain("yayın yapamaz");
  });

  it("üç durumun da etiketi var", () => {
    for (const status of ["active", "needs_reauth", "disabled"] as const) {
      expect(ACCOUNT_STATUS_META[status].label.length).toBeGreaterThan(0);
    }
  });
});

describe("platform ve şiddet etiketleri", () => {
  it("üç platformun etiketi ve kısaltması var", () => {
    expect(platformLabel("instagram")).toBe("Instagram");
    expect(platformLabel("tiktok")).toBe("TikTok");
    expect(platformLabel("youtube")).toBe("YouTube");
    for (const p of ["instagram", "tiktok", "youtube"] as const) {
      expect(PLATFORM_META[p].short.length).toBeGreaterThan(0);
      expect(PLATFORM_META[p].className.length).toBeGreaterThan(0);
    }
  });

  it("üç şiddet seviyesi de etiketli", () => {
    for (const severity of ["error", "warning", "info"] as const) {
      expect(SEVERITY_META[severity].label.length).toBeGreaterThan(0);
    }
    expect(SEVERITY_META.error.tone).toBe("danger");
    expect(SEVERITY_META.warning.tone).toBe("warn");
    expect(SEVERITY_META.info.tone).toBe("info");
  });
});

describe("yardımcılar", () => {
  it("gelecek/past ayrımı", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(isFuture("2026-10-02T12:00:00Z", now)).toBe(true);
    expect(isFuture("2026-09-30T12:00:00Z", now)).toBe(false);
    expect(isFuture(null, now)).toBe(false);
  });

  it("Türkçe küçük harf: I → ı, İ → i", () => {
    expect(trLower("İSTANBUL")).toBe("istanbul");
    expect(trLower("IRAK")).toBe("ırak");
  });
});

describe("tip güvenliği", () => {
  it("tablolar sözleşme union'larının tamamını kapsar", () => {
    const kinds: PublishErrorKind[] = [...PUBLISH_ERROR_KINDS];
    const jobStates: JobState[] = [...ALL_JOB_STATES];
    const contentStates: ContentState[] = [...ALL_CONTENT_STATES];
    // SERT KOD YOK (12 + 8 + 8 = 28): üç tablonun toplamı, üç sözleşme
    // listesinin toplamına eşit olmalı. Sözleşmede bir sınıf eklenirse
    // `Record<…>` tipi zaten derlemeyi durdurur; buradaki eşitlik de kırılır.
    expect(
      Object.keys(ERROR_KIND_META).length +
        Object.keys(JOB_STATE_META).length +
        Object.keys(CONTENT_STATE_META).length,
    ).toBe(kinds.length + jobStates.length + contentStates.length);
  });
});