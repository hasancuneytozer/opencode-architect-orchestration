/**
 * MOTOR TESTLERİ — uçtan uca.
 *
 * Her senaryo GERÇEK kuyruk davranışını kanıtlar (geçici dizin + better-sqlite3
 * + gerçek `FsMediaStore`). Sahte repository kullanılmaz: "kiralama ikinci tick'te
 * işi tekrar almıyor" ancak gerçek atomik kiralama varsa kanıtlanır.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextEligibleTime, statePath } from "../../src/services/publisher.js";
import { canTransition } from "../../src/domain/stateMachine.js";
import type { JobState } from "../../src/contract/index.js";
import {
  FakeTranscoder,
  adapterOf,
  auditActions,
  createFixture,
  jobOf,
  seedScenario,
  uploadsOf,
  type Fixture,
} from "./helpers.js";

let openFixtures: Fixture[] = [];

function fixture(...args: Parameters<typeof createFixture>): Fixture {
  const fx = createFixture(...args);
  openFixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of openFixtures.splice(0)) fx.cleanup();
});

// ════════════════════════════════════════════════════════════════════════════
// 1) UÇTAN UCA YAYIN
// ════════════════════════════════════════════════════════════════════════════

describe("uçtan uca yayın", () => {
  it("içerik + varlık + hesap + sahte adaptör → tick() → published (permalink dolu)", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { withCover: true });

    const result = await fx.service.tick();

    // Konsol çıktısı: kabul kriteri "published durumu görünsün".
    console.log("[E2E] tick sonucu:", JSON.stringify(result, null, 2));

    expect(result.claimed).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    const job = jobOf(fx, seeded.job.id);
    console.log("[E2E] iş durumu:", job.state, "| remoteId:", job.remoteId, "| permalink:", job.permalink);

    expect(job.state).toBe("published");
    expect(job.remoteId).toMatch(/^mock_/);
    expect(job.permalink).toMatch(/^https:\/\/example\.invalid\/instagram\/mock_/);
    expect(job.error).toBeNull();
    expect(job.finishedAt).not.toBeNull();

    // İçerik durumu platform işlerinden türetilir.
    const content = fx.repos.contents.getById(seeded.content.id);
    expect(content?.state).toBe("published");

    // Kiralama terminal durumda serbest bırakılır (kuyruk "meşgul" görünmez).
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();

    // Yayın sağlayıcıya SADECE bir kez gitti (mükerrer yayın yok).
    const adapter = adapterOf(fx, "instagram");
    expect(adapter.callCounts().start).toBe(1);
    expect(adapter.world()).toHaveLength(1);
  });

  it("attempts sayacı yalnız fiziksel denemede artar", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx);
    await fx.service.tick();
    expect(jobOf(fx, seeded.job.id).attempts).toBe(1);
    // İş terminal: ikinci tick hiçbir şey yapmaz, sayaç da artmaz.
    await fx.service.tick();
    expect(jobOf(fx, seeded.job.id).attempts).toBe(1);
  });

  it("üç platforma birden yayın: her biri kendi permalink'ini alır", async () => {
    const fx = fixture();
    const seeds = (["instagram", "tiktok", "youtube"] as const).map((platform) =>
      seedScenario(fx, { platform }),
    );

    const result = await fx.service.tick();
    expect(result.published).toBe(3);
    for (const seeded of seeds) {
      const job = jobOf(fx, seeded.job.id);
      expect(job.state).toBe("published");
      expect(job.permalink).toContain(`/${seeded.job.platform}/`);
    }
    for (const seeded of seeds) {
      expect(fx.repos.contents.getById(seeded.content.id)?.state).toBe("published");
    }
  });

  it("denetim kaydı her adımda 'scheduler' aktörüyle yazılır", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx);
    await fx.service.tick();

    const events = fx.repos.audit.listForTarget("publish_job", seeded.job.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("publish.pending");
    expect(actions).toContain("publish.published");
    expect(events.every((e) => e.actor === "scheduler")).toBe(true);
    expect(events.every((e) => e.targetType === "publish_job")).toBe(true);
  });

  it("kimlik damgası ilk gönderimde yazılır (mükerrer yayın soruşturması)", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx);
    expect(jobOf(fx, seeded.job.id).idempotencyFirstUsedAt).toBeNull();

    await fx.service.tick();
    const job = jobOf(fx, seeded.job.id);
    expect(job.idempotencyFirstUsedAt).not.toBeNull();
    expect(job.idempotencyKey).toBe(`job:instagram:${job.idempotencyKey.split(":")[2]}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) ONAY
// ════════════════════════════════════════════════════════════════════════════

describe("onay akışı", () => {
  it("onay bekleyen içerik atlanır: iş queued kalır, attempts ARTMAZ", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { requiresApproval: true, approvedAt: null });

    const result = await fx.service.tick();

    expect(result.skipped).toBe(1);
    expect(result.published).toBe(0);
    expect(result.details[0]?.reason).toMatch(/onay bekliyor/i);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.leaseOwner).toBeNull();
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
  });

  it("onay verilince aynı iş yayınlanır", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { requiresApproval: true, approvedAt: null });

    await fx.service.tick();
    fx.repos.contents.approve(seeded.content.id, "editor-1");

    const result = await fx.service.tick();
    expect(result.published).toBe(1);
    expect(jobOf(fx, seeded.job.id).state).toBe("published");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) KİRALAMA
// ════════════════════════════════════════════════════════════════════════════

describe("kiralama", () => {
  it("canlı kiralama varken ikinci tick aynı işi TEKRAR İŞLEMEZ", async () => {
    // Uzun yoklama aralığı: iş 'processing'de kalır ve kirası ileri gider.
    const fx = fixture({ script: { processingPolls: 10 } });
    const service = fx.withService({ pollIntervalMs: 120_000 });
    const seeded = seedScenario(fx);

    const first = await service.tick();
    expect(first.claimed).toBe(1);
    expect(first.details[0]?.outcome).toBe("processing");

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("processing");
    expect(job.leaseOwner).toBe("test-worker-1");
    expect(job.leaseExpiresAt).toBeGreaterThan(fx.clock.ms);

    const second = await service.tick();
    expect(second.claimed).toBe(0);
    expect(second.details).toHaveLength(0);
    expect(jobOf(fx, seeded.job.id).state).toBe("processing");

    // Kiralama dolduktan sonra iş yeniden alınır (kendi kendini iyileştirme).
    fx.clock.advance(130_000);
    const third = await service.tick();
    expect(third.claimed).toBe(1);
  });

  it("recoverLeases süresi dolmuş işi kuyruğa geri alır ve attempts artırır", async () => {
    const fx = fixture({ script: { processingPolls: 10 } });
    const service = fx.withService({ pollIntervalMs: 120_000 });
    const seeded = seedScenario(fx);
    await service.tick();

    fx.clock.advance(130_000);
    expect(service.recoverLeases()).toBe(1);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(2);
    expect(job.error).toBeNull();
    expect(job.leaseOwner).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4) YENİDEN DENEME
// ════════════════════════════════════════════════════════════════════════════

describe("yeniden deneme", () => {
  it("failFirstN=2 → 1. ve 2. tick retried, 3. tick published (attempts doğru artar)", async () => {
    const fx = fixture({ script: { failFirstN: 2, failKind: "ratelimit" } });
    const seeded = seedScenario(fx);

    const first = await fx.service.tick();
    expect(first.retried).toBe(1);
    expect(first.failed).toBe(0);
    let job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.error?.kind).toBe("ratelimit");
    expect(job.error?.retryable).toBe(true);
    expect(job.nextAttemptAt).toBeGreaterThan(fx.clock.ms);
    expect(job.finishedAt).toBeNull(); // retryable → iş kuyrukta kalır

    // Bekleme dolmadan ikinci tick işi ALMAZ.
    const tooEarly = await fx.service.tick();
    expect(tooEarly.claimed).toBe(0);

    fx.clock.advance(60_000);
    const second = await fx.service.tick();
    expect(second.retried).toBe(1);
    job = jobOf(fx, seeded.job.id);
    expect(job.attempts).toBe(2);

    fx.clock.advance(60_000);
    const third = await fx.service.tick();
    expect(third.published).toBe(1);
    job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("published");
    expect(job.attempts).toBe(3);
    expect(job.error).toBeNull();
    expect(job.nextAttemptAt).toBeNull();
  });

  it("kalıcı hata (validation) → TEK SEFER: ikinci tick tekrar denemez", async () => {
    const fx = fixture({ script: { failFirstN: 1, failKind: "validation" } });
    const seeded = seedScenario(fx);

    const first = await fx.service.tick();
    expect(first.failed).toBe(1);
    expect(first.retried).toBe(0);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.error?.kind).toBe("validation");
    expect(job.error?.retryable).toBe(false);
    expect(job.nextAttemptAt).toBeNull(); // ← yeniden deneme YOK
    expect(job.finishedAt).not.toBeNull(); // kalıcı → iş kuyruktan çıkar
    expect(job.attempts).toBe(1);

    const second = await fx.service.tick();
    expect(second.claimed).toBe(0);
    expect(second.failed).toBe(0);
    expect(jobOf(fx, seeded.job.id).attempts).toBe(1);
  });

  it("retry bütçesi bitince kalıcı hataya düşer (maxAttempts)", async () => {
    const fx = fixture({ script: { failFirstN: 99, failKind: "server" } });
    const service = fx.withService({ retryPolicy: { maxAttempts: 2, baseDelayMs: 1_000, jitter: 0 } });
    const seeded = seedScenario(fx);

    for (let i = 0; i < 4; i += 1) {
      const r = await service.tick();
      fx.clock.advance(60_000);
      expect(r.published).toBe(0);
    }
    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.nextAttemptAt).toBeNull();
    expect(job.attempts).toBeGreaterThan(1);
  });

  it("içerik durumu tek platform başarısız olduğunda 'failed' olur", async () => {
    const fx = fixture({ script: { failFirstN: 1, failKind: "auth" } });
    const seeded = seedScenario(fx);
    await fx.service.tick();
    expect(fx.repos.contents.getById(seeded.content.id)?.state).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5) MÜKERRER YAYIN YOK
// ════════════════════════════════════════════════════════════════════════════

describe("mükerrer yayın koruması", () => {
  it("yarım kalan yükleme ikinci tick'te yeniden BAŞLATILMAZ: aynı externalId döner", async () => {
    // TikTok yolu: upload_url alınır, işçi parça yüklerken çöker, kiralama dolar.
    const fx = fixture({ script: { uploadUrlTtlSec: 3600, processingPolls: 5 } });
    const service = fx.withService({ pollIntervalMs: 60_000 });
    const seeded = seedScenario(fx, { platform: "tiktok" });

    await service.tick();
    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("processing");
    const externalId = job.externalId;
    expect(externalId).toMatch(/^mock_/);
    expect(job.uploadUrl).not.toBeNull();

    // Yükleyici bir parça gönderdi ama işçi çöktü: uploadedParts > 0.
    fx.repos.jobs.markState(seeded.job.id, "processing", { uploadedParts: 1, totalParts: 4 });
    fx.clock.advance(120_000);

    await service.tick();

    const adapter = adapterOf(fx, "tiktok");
    // startPublish İKİ kez çağrıldı (ikincisi "devam" çağrısı) ama...
    expect(adapter.callCounts().start).toBe(2);
    // ...sağlayıcı tarafında TEK yayın var ve kimlik DEĞİŞMEDİ.
    expect(adapter.world()).toHaveLength(1);
    expect(adapter.record(externalId ?? "")?.startCalls).toBe(2);
    expect(jobOf(fx, seeded.job.id).externalId).toBe(externalId);
  });

  it("kiralama düşmeden aynı iş ikinci kez ALINMAZ", async () => {
    const fx = fixture({ script: { processingPolls: 10 } });
    const service = fx.withService({ pollIntervalMs: 120_000 });
    const seeded = seedScenario(fx);

    await service.tick();
    await service.tick();
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6) PERMALİNKSİZ YAYIN
// ════════════════════════════════════════════════════════════════════════════

describe("permalinksiz yayın", () => {
  it("permalink null ise published_no_link (yayın tamam, adres yok)", async () => {
    const fx = fixture({ script: { omitPermalink: true } });
    const seeded = seedScenario(fx, { platform: "tiktok" });

    const result = await fx.service.tick();
    expect(result.published).toBe(1);
    expect(result.details.some((d) => d.outcome === "published_no_link")).toBe(true);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("published_no_link");
    expect(job.permalink).toBeNull();
    expect(job.remoteId).toMatch(/^mock_/);
    // Yayın yine de BAŞARILI sayılır: ölçülemez, ama kaybolmaz.
    expect(fx.repos.contents.getById(seeded.content.id)?.state).toBe("published");
  });

  it("published_no_link da terminaldir: yeniden yayınlanmaz", async () => {
    const fx = fixture({ script: { omitPermalink: true } });
    const seeded = seedScenario(fx);
    await fx.service.tick();

    const second = await fx.service.tick();
    expect(second.claimed).toBe(0);
    expect(jobOf(fx, seeded.job.id).state).toBe("published_no_link");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7) SESSİZ SAAT
// ════════════════════════════════════════════════════════════════════════════

describe("sessiz saat", () => {
  // 2030-01-15 23:30Z = Europe/Istanbul 02:30 → 23:00–07:00 aralığında.
  const QUIET_NOW = "2030-01-15T23:30:00.000Z";

  it("sessiz saatte yayın yapılmaz, sıra quietHours.end'e kaydırılır", async () => {
    const fx = fixture();
    fx.clock.setIso(QUIET_NOW);
    const seeded = seedScenario(fx, {
      scheduledAt: QUIET_NOW,
      quietHours: { start: "23:00", end: "07:00" },
      timezone: "Europe/Istanbul",
    });

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.published).toBe(0);
    expect(result.details[0]?.reason).toMatch(/Sessiz saat/);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);

    // Hesaplanan erteleme anı: 07:00 Istanbul = 04:00Z.
    const events = fx.repos.audit.listForTarget("publish_job", seeded.job.id);
    const deferred = events.find((e) => e.action === "publish.deferred_quiet_hours");
    expect(deferred?.detail["until"]).toBe("2030-01-16T04:00:00.000Z");
  });

  /**
   * ERTELEME, DEPOLARIN SÖZLEŞMESİDİR.
   *
   * Bu test ESKİDEN TERSİNİ savunuyordu: `markState` tipte `scheduledAt`
   * vaat ediyor ama `scheduled_at` sütununu YAZMIYORDU (bilinen depo kusuru);
   * motor bu kusuru telafi ediyordu ve test telafiyi kilitliyordu.
   * Kusur DÜZELTİLDİ → beklenti de TERSİNE döndü. Bu zayıflatma DEĞİLDİR:
   * test artık DOĞRU davranışı kilitler ve depo sütunu yeniden düşürürse
   * (sessiz saat ertelemesi çalışmaz, kuyruk sıcak döngüye girer) yine
   * kırmızıya döner.
   */
  it("markState scheduledAt'ı YAZIYOR (erteleme sözleşmesi)", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, {
      quietHours: { start: "23:00", end: "07:00" },
      timezone: "Europe/Istanbul",
    });

    const ok = fx.repos.jobs.markState(seeded.job.id, "queued", {
      scheduledAt: "2031-05-05T05:05:05.000Z",
    });
    expect(ok).toBe(true);
    expect(jobOf(fx, seeded.job.id).scheduledAt).toBe("2031-05-05T05:05:05.000Z");
  });

  /**
   * ESKİDEN bu test şunu varsayıyordu: `markState` `scheduled_at`'ı yazamadığı
   * için ertelenen iş HER TICK yeniden alınır, motor bunu kiralama ile sınırlar
   * ve kusur her turda denetime yazılır. Depo hatası düzeltildiği için artık
   * şunu varsayıyoruz: erteleme GERÇEKTEN yazılır, iş kuyruktan ÇIKAR ve
   * telafi kodunun (kiralama yeniden arm etme) izi yoktur.
   */
  it("ertelenen iş bir sonraki tick'te YENİDEN ALINMAZ (sessiz döngü yok)", async () => {
    const fx = fixture();
    fx.clock.setIso("2030-03-05T12:00:00.000Z");
    const seeded = seedScenario(fx, {
      quietHours: { start: "09:00", end: "17:00" },
      timezone: "UTC",
    });

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/Sessiz saat/);

    // Yazma DOĞRULANDI: sütun ileri yazıldı, kiralama serbest (telafi YOK).
    const deferred = jobOf(fx, seeded.job.id);
    expect(deferred.state).toBe("queued");
    expect(deferred.scheduledAt).toBe("2030-03-05T17:00:00.000Z");
    expect(Date.parse(deferred.scheduledAt)).toBeGreaterThan(fx.clock.ms);
    expect(deferred.leaseExpiresAt).toBeNull();
    expect(deferred.leaseOwner).toBeNull();

    const actions = fx.repos.audit.listForTarget("publish_job", seeded.job.id).map((e) => e.action);
    expect(actions).toContain("publish.deferred_quiet_hours");
    expect(actions.some((a) => a.startsWith("publish.defer_write"))).toBe(false);

    // Aynı saatte ikinci tur işi HİÇ ALMAZ: sıcak `skipped` döngüsü yok.
    const again = await fx.service.tick();
    expect(again.claimed).toBe(0);
    expect(again.skipped).toBe(0);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
    expect(jobOf(fx, seeded.job.id).attempts).toBe(0);

    // Erteleme anı gelince iş yeniden alınır ve yayınlanır.
    fx.clock.advance(5 * 3_600_000);
    const later = await fx.service.tick();
    expect(later.published).toBe(1);
  });

  /**
   * TELAFİ SİLİNDİ, TESPİT KALDI.
   *
   * Depo sözleşmesi (`markState` `scheduled_at`'ı yazar) bir gün bozulursa
   * erteleme sessizce başarısız olur ve kuyruk, işi her tur yeniden vererek
   * sıcak `skipped` döngüsü kurar. Motorun bu durumda GÖRÜNÜR olması gerekir:
   * iş durdurulur ve gerekçe denetime yazılır. Burada GERÇEK depo nesnesi
   * üzerinden `scheduledAt` alanı düşürülür — kuyruk davranışı sahte değildir,
   * yalnız sözleşmenin ihlali taklit edilir.
   */
  it("erteleme yazılamazsa motor sessizce ertelemeye devam ETMEZ (tespit + döngü yok)", async () => {
    const fx = fixture();
    fx.clock.setIso("2030-03-05T12:00:00.000Z");
    const seeded = seedScenario(fx, {
      quietHours: { start: "09:00", end: "17:00" },
      timezone: "UTC",
    });

    const jobs = fx.repos.jobs;
    const gercekMarkState = jobs.markState.bind(jobs);
    const spy = vi.spyOn(jobs, "markState").mockImplementation((id, state, patch) => {
      const { scheduledAt: _yazilmayan, ...kalan } = patch ?? {};
      return gercekMarkState(id, state, kalan);
    });

    const result = await fx.service.tick();
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0); // "gerekçesiz atlama" sayılmadı
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(0);
    expect(job.leaseExpiresAt).toBeNull(); // kira takılı kalmaz
    expect(job.error?.message).toMatch(/ertelenemedi/);

    const actions = fx.repos.audit.listForTarget("publish_job", seeded.job.id).map((e) => e.action);
    expect(actions).toContain("publish.defer_write_rejected");

    // Döngü YOK: iş kuyruktan çıktığı için ikinci tur hiçbir şey yapmaz.
    const again = await fx.service.tick();
    expect(again.claimed).toBe(0);
    expect(again.skipped).toBe(0);

    spy.mockRestore();
  });

  it("sessiz saat bittikten sonra iş yayınlanır", async () => {
    const fx = fixture();
    fx.clock.setIso(QUIET_NOW);
    const seeded = seedScenario(fx, {
      scheduledAt: QUIET_NOW,
      quietHours: { start: "23:00", end: "07:00" },
      timezone: "Europe/Istanbul",
    });

    await fx.service.tick();
    fx.clock.setIso("2030-01-16T04:00:00.000Z"); // 07:00 yerel

    const result = await fx.service.tick();
    expect(result.published).toBe(1);
    expect(jobOf(fx, seeded.job.id).state).toBe("published");
  });

  it("gece yarısını geçmeyen aralık da doğru hesaplanır", () => {
    const tz = "Europe/Istanbul";
    // 03:00 yerel, sessiz saat 01:00–06:00 → 06:00'a kaydır.
    const now = new Date("2030-03-10T00:00:00.000Z"); // 03:00
    const next = nextEligibleTime(now, { start: "01:00", end: "06:00" }, tz);
    expect(next.toISOString()).toBe("2030-03-10T03:00:00.000Z");
  });

  it("gece yarısını aşan aralıkta sonraki sabaha atlanır", () => {
    const tz = "Europe/Istanbul";
    // 02:30 yerel, sessiz saat 23:00–07:00 → 07:00'a atlanır.
    const next = nextEligibleTime(
      new Date("2030-01-15T23:30:00.000Z"),
      { start: "23:00", end: "07:00" },
      tz,
    );
    expect(next.toISOString()).toBe("2030-01-16T04:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8) KİMLİK ÇÖZME
// ════════════════════════════════════════════════════════════════════════════

describe("kimlik şifreleme", () => {
  it("şifreli token adaptöre DÜZ METİN olarak geçer", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { token: "IGQV-gercek-token-123" });

    await fx.service.tick();

    const adapter = adapterOf(fx, "instagram");
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.starts[0]?.account.accessToken).toBe("IGQV-gercek-token-123");
    // Depolamada düz metin YOKTUR.
    const stored = fx.repos.credentials.getByAccountId(seeded.account.id);
    expect(stored?.accessTokenEnc).toMatch(/^v1:/);
    expect(stored?.accessTokenEnc).not.toContain("IGQV-gercek-token-123");
  });

  it("cipher null ise iş 'atlandı' olur, motor ÇÖKMEZ", async () => {
    const fx = fixture({ withCipher: false });
    const seeded = seedScenario(fx);

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/cipher_missing|Şifre çözücü yok/);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
  });

  it("bozuk kutu işi durdurmaz; gerekçe ve denetim kaydı yazılır", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { brokenToken: true });

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/credential_unreadable/);
    expect(jobOf(fx, seeded.job.id).state).toBe("queued");

    const actions = fx.repos.audit.listForTarget("publish_job", seeded.job.id).map((e) => e.action);
    expect(actions).toContain("publish.credential_unreadable");
  });

  it("kimlik kaydı yoksa atlanır", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { withCredential: false });
    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/credential_missing/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9) EKSİK BAĞLAMLAR
// ════════════════════════════════════════════════════════════════════════════

describe("eksik bağlamlar — gerekçeli atlama", () => {
  it("adaptör yoksa iş kuyrukta kalır (başarısız sayılmaz)", async () => {
    const fx = fixture({ withoutAdapter: ["tiktok"] });
    const seeded = seedScenario(fx, { platform: "tiktok" });

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.details[0]?.reason).toMatch(/adapter_missing/);
    expect(jobOf(fx, seeded.job.id).state).toBe("queued");
  });

  it("devre dışı hesapta yayın yapılmaz", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { accountStatus: "disabled" });
    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/account_disabled/);
  });

  it("needs_reauth hesabı boşuna denenmez", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { accountStatus: "needs_reauth" });
    const result = await fx.service.tick();
    expect(result.details[0]?.reason).toMatch(/account_needs_reauth/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
  });

  it("precheck hatası yayına GİTMEZ: kalıcı doğrulama hatası", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, {
      info: { width: null, height: null, videoCodec: null },
    });

    const result = await fx.service.tick();
    expect(result.failed).toBe(1);

    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.error?.kind).toBe("validation");
    expect(job.error?.message).toMatch(/media_rejected/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
    expect(job.attempts).toBe(0); // deneme bile yapılmadı
  });

  it("kota doluysa yayın ertelenir", async () => {
    const fx = fixture({ script: { quota: { used: 25, total: 25, windowSec: 3600 } } });
    const seeded = seedScenario(fx);

    const result = await fx.service.tick();
    expect(result.skipped).toBe(1);
    expect(result.details[0]?.reason).toMatch(/Kota dolu/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
    expect(jobOf(fx, seeded.job.id).state).toBe("queued");

    // Pencere bitimine kadar ertelendi: denetim kaydı kadar `scheduled_at` DA
    // yazıldı (kuyruk işi o ana kadar geri vermez).
    const events = fx.repos.audit.listForTarget("publish_job", seeded.job.id);
    const deferred = events.find((e) => e.action === "publish.deferred_quota");
    const until = new Date(fx.clock.ms + 3_600_000).toISOString();
    expect(deferred?.detail["until"]).toBe(until);
    expect(jobOf(fx, seeded.job.id).scheduledAt).toBe(until);
  });

  it("kota okunamadığında yayın ENGELLENMEZ", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx);
    // readQuota hata fırlatsaydı motor yine de yayınlamalı.
    const adapter = adapterOf(fx, "instagram");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).readQuota = async () => {
      throw new Error("quota endpoint 500");
    };

    const result = await fx.service.tick();
    expect(result.published).toBe(1);
    const actions = fx.repos.audit.listForTarget("publish_job", seeded.job.id).map((e) => e.action);
    expect(actions).toContain("publish.quota_read_failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10) StartResult / PollResult DALLARI
// ════════════════════════════════════════════════════════════════════════════

describe("adaptör dallarının işlenmesi", () => {
  it("immediate: tek turda published", async () => {
    const fx = fixture({ script: { startResult: "immediate" } });
    const seeded = seedScenario(fx);

    const result = await fx.service.tick();
    expect(result.published).toBe(1);
    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("published");
    expect(job.permalink).not.toBeNull();
    expect(adapterOf(fx, "instagram").callCounts().poll).toBe(0);
  });

  /**
   * ESKİDEN BURADA BİR TEST VARDI VE ŞUNU SAYIYORDU: "oturum açıldı → adres ve
   * süre yazıldı → yoklama → yayınlandı". `MockPublishAdapter` `uploadParts`
   * UYGULAMADIĞI için motor bayt göndermeden `processing`'e geçiyor, yoklama
   * zinciri tamamlanıyor ve iş `published` oluyordu. Test yeşildi.
   *
   * O ZAMAN BU BİR HATA DEĞİLDİ; şimdi öyle. `StartResult.uploadUrl` bir
   * ADRESTİR, yayın değildir; port sözleşmesi bu dalı açan adaptörün
   * `uploadParts` UYGULAMASINI zorunlu kılar. Bayt gönderen olmadan bir işi
   * `processing` (yani panelde "yayın sırasında") göstermek, hiçbir şey
   * yüklenmeyen bir yayını "sürüyor" diye sunmaktır — kullanıcının gördüğü
   * yalan. Motor artık bu yolda `processing`'e GİTMEZ; gerekçeli `skipped` +
   * `publish.upload_unsupported` yazar. Aşağıdaki testler bu sözleşmeyi
   * kilitler.
   */
  it("uploadParts UYGULAMAZ: iş skipped olur, upload_unsupported denetime düşer, processing'e GİRMEZ", async () => {
    const fx = fixture({
      unsupportedUpload: true,
      script: { uploadUrlTtlSec: 3600, processingPolls: 1 },
    });
    const seeded = seedScenario(fx);
    const adapter = adapterOf(fx, "instagram");

    // 1. TUR: oturum açılır. Adres + süre kalıcı yazılır ama bayt gitmez.
    const first = await fx.service.tick();
    expect(first.published).toBe(0);

    const opened = jobOf(fx, seeded.job.id);
    expect(opened.uploadUrl).toMatch(/example\.invalid\/upload/);
    expect(opened.uploadUrlExpiresAt).not.toBeNull();
    expect(opened.uploadedParts).toBe(0);
    expect(adapter.callCounts().start).toBe(1);

    const pollsBeforeUploadTurn = adapter.callCounts().poll;

    // 2. TUR: bayt gönderen yok. Motor zinciri YOKLAMAYA DEVAM ETTİRMEZ.
    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    expect(second.published).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.details[0]?.outcome).toBe("skipped");
    // Kullanıcıya giden gerekçe: ne olduğu ve NE YAPILMADIĞI açık.
    expect(second.details[0]?.reason).toMatch(/bayt GÖNDEREN YOK/);
    expect(second.details[0]?.reason).toMatch(/processing/);
    // MAKİNE OKUNUR kod gerekçe metnine değil DENETİME yazılır; bu test
    // `upload_unsupported`'ı orada arar (aşağıda).

    // "Yayın sırasında" GÖRÜNMEZ: kullanıcıya hiçbir şey yüklenmedi.
    const parked = jobOf(fx, seeded.job.id);
    expect(parked.state).toBe("queued");
    expect(parked.uploadedParts).toBe(0);
    expect(adapter.callCounts().poll).toBe(pollsBeforeUploadTurn); // yoklama YOK

    // Gerekçe DENETİMDE görünür (sessiz takılma yok).
    const actions = auditActions(fx, seeded.job.id);
    expect(actions).toContain("publish.upload_unsupported");
    expect(actions).not.toContain("publish.published");

    // Sıcak `skipped` döngüsü de yok: iş 15 dakika ileriye alınır.
    expect(Date.parse(parked.scheduledAt) - fx.clock.ms).toBe(15 * 60_000);
    const again = await fx.service.tick();
    expect(again.claimed).toBe(0);
    expect(again.skipped).toBe(0);
    expect(adapter.callCounts().start).toBe(1);
  });

  it("uploadUrl: adres + süre yazılır, BAYTLAR gönderilir, yoklama sonrası yayınlanır", async () => {
    const fx = fixture({
      script: { uploadUrlTtlSec: 3600, processingPolls: 1 },
      // `uploadParts` UYGULAYAN sahte adaptör: 4 parçalık yükleme.
      upload: { totalParts: 4, partsPerCall: 4 },
    });
    const seeded = seedScenario(fx);

    const first = await fx.service.tick();
    expect(first.published).toBe(0);
    const opened = jobOf(fx, seeded.job.id);
    expect(opened.state).toBe("processing");
    expect(opened.uploadUrl).toMatch(/example\.invalid\/upload/);
    expect(opened.uploadUrlExpiresAt).not.toBeNull();
    expect(opened.nextAttemptAt).toBeNull(); // polling dueForPoll ile gelir
    expect(opened.totalParts).toBeNull(); // parça sayısı adaptörün İÇİNDE
    expect(opened.uploadedParts).toBe(0); // HİÇBİR bayt gönderilmedi

    // Oturum açıldı ama bayt gönderilmedi: bu turda `uploadParts` ÇAĞRILMAZ.
    expect(uploadsOf(fx, "instagram")).toHaveLength(0);

    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    // Oturum → `uploadParts` → ilerleme yazıldı → done → processing → yoklama.
    const uploads = uploadsOf(fx, "instagram");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.session.uploadUrl).toBe(opened.uploadUrl);
    expect(uploads[0]?.session.uploadedParts).toBe(0);

    expect(second.published).toBe(1);
    const done = jobOf(fx, seeded.job.id);
    expect(done.state).toBe("published");
    expect(done.uploadedParts).toBe(4); // adaptörün bildirdiği kabul edilen parça
    expect(done.totalParts).toBe(4);

    const actions = auditActions(fx, seeded.job.id);
    expect(actions).toContain("publish.upload_cycle");
    expect(actions).toContain("publish.upload_progress");
    expect(actions).toContain("publish.published");
  });

  it("scheduled: iş 'scheduled' bildirir, iş durumu processing kalır", async () => {
    const fx = fixture({ script: { returnScheduled: true } });
    const seeded = seedScenario(fx);

    const first = await fx.service.tick();
    expect(first.scheduled).toBe(1);
    expect(first.details.some((d) => d.outcome === "scheduled")).toBe(true);
    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("processing"); // "scheduled" bir İŞ durumu değildir
    expect(job.remoteId).toMatch(/^mock_/);

    fx.clock.advance(5_000);
    const second = await fx.service.tick();
    expect(second.published).toBe(1);
    expect(jobOf(fx, seeded.job.id).state).toBe("published");
  });

  it("yoklamada container_expired kalıcı hatadır", async () => {
    const fx = fixture({ script: { uploadUrlTtlSec: 60, processingPolls: 5 } });
    const seeded = seedScenario(fx);
    await fx.service.tick();
    expect(jobOf(fx, seeded.job.id).state).toBe("processing");

    // Yükleme adresinin süresi doldu.
    fx.repos.jobs.markState(seeded.job.id, "processing", {
      uploadUrlExpiresAt: new Date(fx.clock.ms - 1_000).toISOString(),
    });
    fx.clock.advance(10_000);

    const result = await fx.service.tick();
    expect(result.failed).toBe(1);
    const job = jobOf(fx, seeded.job.id);
    expect(job.state).toBe("failed");
    expect(job.error?.kind).toBe("container_expired");
    expect(job.nextAttemptAt).toBeNull();
  });

  it("bilinmeyen externalId ile yoklama kalıcı hataya düşer", async () => {
    const fx = fixture({ script: { processingPolls: 5 } });
    const seeded = seedScenario(fx);
    await fx.service.tick();

    // Sunucu tarafındaki kayıt silinmiş (yoklama kuyruğu).
    adapterOf(fx, "instagram").reset();
    fx.clock.advance(10_000);

    const result = await fx.service.tick();
    expect(result.failed).toBe(1);
    expect(jobOf(fx, seeded.job.id).error?.kind).toBe("validation");
  });

  it("kapak baytları varlıkta varsa adaptöre taşınır", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx, { withCover: true });
    await fx.service.tick();
    expect(adapterOf(fx, "instagram").starts[0]?.coverBytes?.length).toBeGreaterThan(0);
    expect(seeded.storageKey).toBeTruthy();
  });

  it("kapak yoksa null gider (adaptör kapak zorunlu kılmaz)", async () => {
    const fx = fixture();
    seedScenario(fx, { withCover: false });
    await fx.service.tick();
    expect(adapterOf(fx, "instagram").starts[0]?.coverBytes).toBeNull();
  });

  it("zamanı gelmemiş iş publishNow ile yine de yayınlanır", async () => {
    const fx = fixture();
    // Saat ileri, iş daha sonrasına planlı: kuyruk vermez.
    const seeded = seedScenario(fx, { scheduledAt: new Date(fx.clock.ms + 3_600_000).toISOString() });
    const result = await fx.service.tick();
    expect(result.claimed).toBe(0);

    const forced = await fx.service.publishNow(seeded.job.id);
    expect(forced?.outcome).toBe("published");
    expect(jobOf(fx, seeded.job.id).state).toBe("published");
  });

  /**
   * ESKİDEN bu test şunu varsayıyordu: `publishNow` zaman damgasını ileri
   * çekemediği için (depo kusuru) iş hâlâ gelecektedir ve adaptör
   * "bu zaman yayınla" der. Depo hatası düzeltildiği için artık şunu varsayıyoruz:
   * "şimdi yayınla" ZAMANI BEKLEMEZ — zaman damgası şimdiye çekilir ve adaptöre
   * `scheduledAt: null` ("hemen") gider.
   */
  it("publishNow zamanı gelecekteki işi HEMEN yayar (adaptöre null gider)", async () => {
    const fx = fixture();
    const future = new Date(fx.clock.ms + 3_600_000).toISOString();
    const seeded = seedScenario(fx, { scheduledAt: future });
    await fx.service.publishNow(seeded.job.id);

    // Zaman damgası şimdiye çekildi: adaptör "gelecekte yayınla" DEĞİL,
    // "hemen yayınla" alır.
    expect(adapterOf(fx, "instagram").starts[0]?.scheduledAt).toBeNull();
    expect(jobOf(fx, seeded.job.id).state).toBe("published");

    // Zaten zamanı gelmiş işte de null ("hemen yayınla") gider.
    const fx2 = fixture();
    seedScenario(fx2);
    await fx2.service.tick();
    expect(adapterOf(fx2, "instagram").starts[0]?.scheduledAt).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11) TRANSKODE
// ════════════════════════════════════════════════════════════════════════════

describe("dönüştürme (transcode)", () => {
  it("türev varlık oluşturulur, kapak çıkarılır ve türev yayınlanır", async () => {
    const transcoder = new FakeTranscoder({ withinLimits: true });
    const fx = fixture({ transcoder });
    const seeded = seedScenario(fx);

    const result = await fx.service.tick();
    expect(result.published).toBe(1);

    const derived = fx.repos.assets.listDerivedFrom(seeded.asset.id);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.derivedForPlatform).toBe("instagram");
    expect(derived[0]?.coverKey).not.toBeNull();
    expect(transcoder.toFeedReadyCalls).toHaveLength(1);
    expect(transcoder.grabCoverCalls[0]?.percent).toBe(35);

    // Adaptöre TÜREV varlık gitti.
    const sent = adapterOf(fx, "instagram").starts[0];
    expect(sent?.media.storageKey).toBe(derived[0]?.storageKey);
  });

  it("withinLimits false ise yayına GİTMEZ, kalıcı hata", async () => {
    const transcoder = new FakeTranscoder({ withinLimits: false });
    const fx = fixture({ transcoder });
    const seeded = seedScenario(fx);

    const result = await fx.service.tick();
    expect(result.failed).toBe(1);
    expect(jobOf(fx, seeded.job.id).error?.message).toMatch(/sınırını aşıyor/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);
    expect(fx.repos.assets.listDerivedFrom(seeded.asset.id)).toHaveLength(0);
  });

  it("transcoder patlarsa iş 'failed' olur (sonsuz yeniden deneme yok)", async () => {
    const fx = fixture({ transcoder: new FakeTranscoder({ throwOn: "toFeedReady" }) });
    const seeded = seedScenario(fx);

    // Dönüştürme sağlayıcı hatası değil, kendi altyapımızın hatası: `transient`.
    // Bu tur yayına GİTMEZ; politika bir sonraki denemeyi planlar.
    const first = await fx.service.tick();
    expect(first.retried).toBe(1);
    expect(first.failed).toBe(0);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(0);

    // İş `failed` GÖRÜNÜR ama kuyruktan çıkmaz: geçici hata → `next_attempt_at`
    // dolu, `finished_at` boş (MIMARI.md "failed kalıcı mı geçici mi" tablosu).
    const planned = jobOf(fx, seeded.job.id);
    expect(planned.state).toBe("failed");
    expect(planned.error?.kind).toBe("transient");
    expect(planned.nextAttemptAt).toBeGreaterThan(fx.clock.ms);
    expect(planned.finishedAt).toBeNull();

    // SINIRLI: bütçe (`maxAttempts`) dolunca kalıcı hataya düşer ve iş kuyruğu
    // bırakır. Sayaç büyüdükçe politika "dene" demeyi bırakır — döngü sonsuz değil.
    const outcomes: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      fx.clock.advance(60_000);
      outcomes.push((await fx.service.tick()).failed);
    }
    expect(outcomes).toContain(1);
    const exhausted = jobOf(fx, seeded.job.id);
    expect(exhausted.state).toBe("failed");
    expect(exhausted.nextAttemptAt).toBeNull(); // bir daha sıraya girmeyecek
    expect(exhausted.attempts).toBeGreaterThan(1);
    const after = await fx.service.tick();
    expect(after.claimed).toBe(0);
  });

  it("var olan türev yeniden kullanılır (kiralama dolup dönen işçi yapmaz)", async () => {
    const transcoder = new FakeTranscoder();
    const fx = fixture({ transcoder });
    const seeded = seedScenario(fx);

    await fx.service.tick();
    fx.repos.jobs.remove(seeded.job.id);
    // tiktok hesabı ve KİMLİĞİ hazır olsun diye senaryo kurulur; üretilen iş
    // silinir, çünkü aşağıdaki tek iş instagram varlığının tiktok türevini
    // üretecek (aksi hâlde beklenen tek dönüştürme çağrısını o iş harcar).
    const second = seedScenario(fx, { platform: "tiktok" });
    fx.repos.jobs.remove(second.job.id);
    // Aynı varlıkla yeni iş kuruyoruz: instagram türevi varken tiktok için
    // AYRI bir türev gerekir (platform başına bir türev).
    const content2 = fx.repos.contents.create({
      projectId: seeded.project.id,
      assetId: seeded.asset.id,
      state: "ready",
      requiresApproval: false,
      approvedAt: "2030-01-01T00:00:00.000Z",
      approvedBy: "t",
      timezone: "Europe/Istanbul",
      copy: { tiktok: { caption: "ikinci" } },
      scheduledAt: new Date(fx.clock.ms - 1_000).toISOString(),
    });
    fx.repos.jobs.create({
      contentId: content2.id,
      platform: "tiktok",
      accountId: second.account.id,
      scheduledAt: new Date(fx.clock.ms - 1_000).toISOString(),
    });

    const before = transcoder.toFeedReadyCalls.length;
    await fx.service.tick();
    // instagram türevi vardı; tiktok için YENİ türev üretilir (platform başına bir).
    expect(transcoder.toFeedReadyCalls.length).toBe(before + 1);
    expect(fx.repos.assets.listDerivedFrom(seeded.asset.id).map((a) => a.derivedForPlatform).sort()).toEqual(
      ["instagram", "tiktok"],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12) publishNow
// ════════════════════════════════════════════════════════════════════════════

describe("publishNow (şimdi yayınla)", () => {
  it("terminal işi yeniden çalıştırmaz", async () => {
    const fx = fixture();
    const seeded = seedScenario(fx);
    await fx.service.tick();

    const detail = await fx.service.publishNow(seeded.job.id);
    expect(detail?.outcome).toBe("skipped");
    expect(detail?.reason).toMatch(/terminal/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(1);
  });

  it("bilinmeyen iş için null döner", async () => {
    const fx = fixture();
    expect(await fx.service.publishNow("olmayan-is")).toBeNull();
  });

  it("bekleyen yoklamayı da tetikler", async () => {
    const fx = fixture({ script: { processingPolls: 1 } });
    const seeded = seedScenario(fx, { scheduledAt: new Date(fx.clock.ms + 60_000).toISOString() });

    const detail = await fx.service.publishNow(seeded.job.id);
    expect(detail?.outcome).toBe("processing");
    expect(jobOf(fx, seeded.job.id).state).toBe("processing");

    const next = await fx.service.publishNow(seeded.job.id);
    expect(next?.outcome).toBe("published");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13) SAF YARDIMCILAR
// ════════════════════════════════════════════════════════════════════════════

describe("statePath — durum makinesi yolu", () => {
  it("preparing → published yolu uploading üzerinden kurulur", () => {
    expect(statePath("preparing", "published")).toEqual([
      "preparing",
      "uploading",
      "processing",
      "published",
    ]);
  });

  it("queued → published doğrudan reddedilir (hazırlık atlanamaz)", () => {
    // DOĞRUDAN kenar reddedilir: ALLOWED_TRANSITIONS.queued = [preparing, canceled].
    expect(canTransition("queued", "published")).toBe(false);
    // ...ve izin verilen yol hazırlığı ATLAMAZ: `statePath` en kısa YOLU
    // döndürür (tek atlamayı değil), `moveTo` her bacağı ayrı ayrı yazar.
    expect(statePath("queued", "published")).toEqual([
      "queued",
      "preparing",
      "uploading",
      "processing",
      "published",
    ]);
  });

  it("terminal durumdan hiçbir yere çıkılamaz", () => {
    for (const from of ["published", "published_no_link", "failed", "canceled"] as JobState[]) {
      expect(statePath(from, "queued")).toBeNull();
    }
  });

  it("preparing → queued geri alma mümkündür (erteleme yolu)", () => {
    expect(statePath("preparing", "queued")).toEqual(["preparing", "queued"]);
  });

  it("aynı durum boş yol döner", () => {
    expect(statePath("processing", "processing")).toEqual(["processing"]);
  });
});
