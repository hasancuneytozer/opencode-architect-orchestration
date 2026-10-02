/**
 * YÜKLEME DÖNGÜSÜ TESTLERİ — motorun `uploadParts` sözleşmesi.
 *
 * `StartResult.uploadUrl` bir ADRESTİR, yayın değildir. Baytları gönderen tek
 * adım `uploadParts`'tır ve motorun sorumluluğu şudur:
 *
 *   oturum açıldı → `uploadParts` çağrıldı → BAŞARILI cevaptan sonra ilerleme
 *   `publish_jobs`'a yazıldı → `done` ise `processing`, değilse kuyruğa dönüş
 *   → yoklama → `published`.
 *
 * Kural: motor `uploadParts` UYGULAMAYAN adaptörü sessizce `processing`'e
 * geçirmez. Gerekçeli `skipped` + `publish.upload_unsupported` yazar. Bu
 * davranışın kendi testi `publisher.test.ts` içindedir; buradaki ilgili test
 * yalnızca GERİ ÇEKİLME (sıcak döngü yok) tarafını ölçer.
 *
 * TÜM İLERLEME KAYITLARI VERİTABANINDAN OKUNUR (`row()`): motor belleğinde
 * gördüğü sayıyı test etmek, yazma sözleşmesini değil yazma YOKSUNLUĞUNU
 * test eder.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublishInput, UploadSession } from "../../src/ports/index.js";
import {
  adapterOf,
  auditActions,
  createFixture,
  jobOf,
  seedScenario,
  uploadsOf,
  type Fixture,
  type UploadScript,
} from "./helpers.js";
import type { UploadingRecordingAdapter } from "./helpers.js";

let openFixtures: Fixture[] = [];

function fixture(...args: Parameters<typeof createFixture>): Fixture {
  const fx = createFixture(...args);
  openFixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of openFixtures.splice(0)) fx.cleanup();
});

/**
 * `publish_jobs` satırını HAM SQL ile okur.
 *
 * Repository `getById` de veritabanından okur ama bir katman daha aradığı için
 * "motor gerçekten SÜTUNA mı yazdı" sorusunun cevabı buradan gelmelidir: sütun
 * adı (`uploaded_parts`) motorun yazmadığı bir şeyse test kırmızıya döner.
 */
interface JobRow {
  state: string;
  upload_url: string | null;
  upload_url_expires_at: string | null;
  uploaded_parts: number;
  total_parts: number | null;
  next_attempt_at: string | null;
  finished_at: string | null;
}

function row(fx: Fixture, jobId: string): JobRow {
  const found = fx.db
    .prepare<[string], JobRow>(
      `SELECT state, upload_url, upload_url_expires_at, uploaded_parts,
              total_parts, next_attempt_at, finished_at
         FROM publish_jobs WHERE id = ?`,
    )
    .get(jobId);
  if (found === undefined) throw new Error(`iş yok: ${jobId}`);
  return found;
}

/** Belirli bir denetim kaydının ayrıntısı (ilerleme sayısını kanıtlamak için). */
function auditDetail(fx: Fixture, jobId: string, action: string): Record<string, unknown> | null {
  const found = fx.repos.audit.listForTarget("publish_job", jobId).find((r) => r.action === action);
  return found?.detail ?? null;
}

/**
 * Oturum açan + parça bekleyen işin kurulumu.
 *
 * `processingPolls: 2` bilinçli: sahte sunucu "önce iki tur işliyor" der, yani
 * 1. tur oturumu açar + yoklar, 2. tur bayt gönderir + yoklar, 3. tur yoklama
 * zincirini kapatır. Böylece "yayınlama yalnız `done` → yoklama yolundan gelir"
 * ve her testin tur sayımı okunabilir kalır.
 */
const OPENED: { uploadUrlTtlSec: number; processingPolls: number } = {
  uploadUrlTtlSec: 3600,
  processingPolls: 2,
};

function openedSession(fx: Fixture, platform: "instagram" | "tiktok" = "instagram") {
  return seedScenario(fx, { platform });
}

// ════════════════════════════════════════════════════════════════════════════

describe("yükleme döngüsü — uçtan uca", () => {
  it("oturum → uploadParts → uploadedParts publish_jobs'a YAZILIR → done → processing", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 3, partsPerCall: 3 } });
    const seeded = openedSession(fx);

    // 1. TUR: `startPublish` oturumu açar. Bayt gönderilmez.
    await fx.service.tick();
    const opened = row(fx, seeded.job.id);
    expect(opened.upload_url).toMatch(/example\.invalid\/upload/);
    expect(opened.upload_url_expires_at).not.toBeNull();
    expect(opened.uploaded_parts).toBe(0);
    expect(opened.total_parts).toBeNull(); // motor parça sayısı UYDURMAZ
    expect(opened.state).toBe("processing");
    expect(uploadsOf(fx, "instagram")).toHaveLength(0);

    // 2. TUR: `uploadParts` çağrılır, ilerleme kalıcı yazılır, `done` → processing.
    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    const uploads = uploadsOf(fx, "instagram");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.session.uploadUrl).toBe(opened.upload_url);
    expect(uploads[0]?.session.uploadedParts).toBe(0);
    // Parça boyutu UYDURULMAZ: `0` = "kendi varsayılanını kullan"
    // (YouTube 256 KB katı, TikTok 5-64 MB; motor ikisini de bilmez).
    expect(uploads[0]?.session.partSizeBytes).toBe(0);

    const written = row(fx, seeded.job.id);
    expect(written.uploaded_parts).toBe(3); // ← sütun, bellek değil
    expect(written.total_parts).toBe(3);
    expect(written.state).toBe("processing"); // done → processing
    expect(written.next_attempt_at).toBeNull();
    expect(second.published).toBe(0); // yoklama hâlâ "işliyor" diyor

    const progress = auditDetail(fx, seeded.job.id, "publish.upload_progress");
    expect(progress?.["uploadedParts"]).toBe(3);
    expect(progress?.["done"]).toBe(true);

    // 3. TUR: yoklama zinciri tamamlanır.
    fx.clock.advance(5_000);
    const third = await fx.service.tick();
    expect(third.published).toBe(1);
    expect(row(fx, seeded.job.id).state).toBe("published");
    expect(uploadsOf(fx, "instagram")).toHaveLength(1); // yükleme TEKRAR edilmez
  });

  it("bayt gönderilirken iş 'uploading' durumunda görünür (panel 'yükleniyor' der)", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 2, partsPerCall: 2 } });
    const seeded = openedSession(fx);
    await fx.service.tick();

    const adapter = fx.adapters.get("instagram") as UploadingRecordingAdapter;
    const real = adapter.uploadParts.bind(adapter);
    const stateAtCall: string[] = [];
    vi.spyOn(adapter, "uploadParts").mockImplementation(
      async (input: PublishInput, session: UploadSession) => {
        // Çağrı ANINDA gerçek sütun okunur (sıralı yazma kanıtı).
        stateAtCall.push(row(fx, seeded.job.id).state);
        return real(input, session);
      },
    );

    fx.clock.advance(5_000);
    await fx.service.tick();

    expect(stateAtCall).toEqual(["uploading"]);
    expect(row(fx, seeded.job.id).state).toBe("processing");
  });
});

describe("yükleme döngüsü — devam (baştan değil, kaldığı yerden)", () => {
  it("kalıcı uploadedParts=2 iken uploadParts 2'den devam eder", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 4, partsPerCall: 1 } });
    const seeded = openedSession(fx);
    await fx.service.tick();

    // Önceki işçi iki parça gönderdi ve KALICI olarak yazdı.
    fx.repos.jobs.markState(seeded.job.id, "processing", { uploadedParts: 2, totalParts: 4 });
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(2);

    fx.clock.advance(5_000);
    const result = await fx.service.tick();

    const uploads = uploadsOf(fx, "instagram");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.session.uploadedParts).toBe(2); // ← baştan DEĞİL
    expect(uploads[0]?.session.totalParts).toBe(4);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(3);
    // Hâlâ bitmedi: kuyruğa geri bırakılır, `processing`'e GEÇİLMEZ.
    expect(result.details[0]?.outcome).toBe("skipped");
    expect(result.details[0]?.reason).toMatch(/Yükleme sürüyor/);
    expect(row(fx, seeded.job.id).state).toBe("queued");
  });

  it("ÇÖKME SONRASI: kalıcı uploadedParts=3'ü yeni işçi 3'ten devam ettirir", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 5, partsPerCall: 2 } });
    const seeded = openedSession(fx);
    await fx.service.tick();

    // İşçi çöktü: 3 parça kalıcı yazılmış, oturum hâlâ geçerli.
    fx.repos.jobs.markState(seeded.job.id, "processing", { uploadedParts: 3, totalParts: 5 });
    fx.clock.advance(5_000);
    const result = await fx.service.tick();

    const uploads = uploadsOf(fx, "instagram");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.session.uploadedParts).toBe(3);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(5); // 3 + 2 = bitti
    expect(result.details[0]?.outcome).toBe("processing");
    // Yayın KİMLİĞİ değişmedi: aynı oturum, aynı iş, `startPublish` tek çağrı.
    expect(jobOf(fx, seeded.job.id).externalId).toMatch(/^mock_/);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(1);
  });

  it("tick başına TAM BİR çağrı: done:false iken aynı tick'te ikinci çağrı yapılmaz", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 6, partsPerCall: 2 } });
    const seeded = openedSession(fx);

    await fx.service.tick();
    expect(uploadsOf(fx, "instagram")).toHaveLength(0);

    // 2. TUR → 2/6
    fx.clock.advance(5_000);
    const second = await fx.service.tick();
    expect(uploadsOf(fx, "instagram")).toHaveLength(1); // ← 1, 2 DEĞİL
    expect(second.details[0]?.outcome).toBe("skipped");
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(2);
    expect(row(fx, seeded.job.id).state).toBe("queued");
    // Yazılmayan erteleme = "her tick'te yeniden dene" sıcak döngüsü. Burada
    // `scheduled_at` İLERİ yazıldı, yani iş bir sonraki turda gelmez.
    expect(Date.parse(jobOf(fx, seeded.job.id).scheduledAt)).toBeGreaterThan(fx.clock.ms);

    // 3. TUR → 4/6
    fx.clock.advance(5_000);
    await fx.service.tick();
    expect(uploadsOf(fx, "instagram")).toHaveLength(2); // yine tam bir çağrı
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(4);

    // 4. TUR → 6/6 → done → processing
    fx.clock.advance(5_000);
    const fourth = await fx.service.tick();
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(6);
    expect(row(fx, seeded.job.id).total_parts).toBe(6);
    expect(fourth.published).toBe(0); // yoklama zinciri henüz kapanmadı
    expect(uploadsOf(fx, "instagram")).toHaveLength(3);

    // 5. TUR: yoklama kapatır. Bayt bir kez daha gönderilmez.
    fx.clock.advance(5_000);
    const fifth = await fx.service.tick();
    expect(fifth.published).toBe(1);
    expect(uploadsOf(fx, "instagram")).toHaveLength(3);

    // Oturumların `uploadedParts` girdileri 0 → 2 → 4: her tur KALDIĞI YERDEN.
    expect(uploadsOf(fx, "instagram").map((u) => u.session.uploadedParts)).toEqual([0, 2, 4]);
  });

  it("MÜKERRER YÜKLEME YOK: done olduktan sonra uploadParts TEKRAR çağrılmaz", async () => {
    const fx = fixture({
      script: { uploadUrlTtlSec: 3600, processingPolls: 10 },
      upload: { totalParts: 1, partsPerCall: 1 },
    });
    const seeded = openedSession(fx);

    await fx.service.tick();
    fx.clock.advance(5_000);
    await fx.service.tick(); // uploadParts → done → processing (yoklama "işliyor")
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(1);
    expect(uploadsOf(fx, "instagram")).toHaveLength(1);

    // İş hâlâ `processing`: sonraki turlar onu yeniden alır. Bayt GÖNDERİLMEZ.
    for (let i = 0; i < 3; i += 1) {
      fx.clock.advance(5_000);
      const r = await fx.service.tick();
      expect(r.details[0]?.outcome).toBe("processing");
      expect(row(fx, seeded.job.id).uploaded_parts).toBe(1);
    }
    expect(uploadsOf(fx, "instagram")).toHaveLength(1);
    // `uploadPending` kapalı olduğu için `startPublish` da yeniden çağrılmaz.
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(1);
  });
});

describe("yükleme döngüsü — kiralama", () => {
  it("canlı kiralama varken aynı leaseOwner işi ikinci kez YÜKLEMEZ", async () => {
    const fx = fixture({
      script: { uploadUrlTtlSec: 3600, processingPolls: 10 },
      upload: { totalParts: 4, partsPerCall: 4 },
    });
    // Uzun yoklama aralığı: iş `processing`'e kalır ve kirası ileri gider.
    const service = fx.withService({ pollIntervalMs: 120_000 });
    const seeded = openedSession(fx);

    const first = await service.tick();
    expect(first.claimed).toBe(1);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(0); // henüz bayt yok

    const second = await service.tick();
    expect(second.claimed).toBe(0);
    expect(uploadsOf(fx, "instagram")).toHaveLength(0);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(0);

    // Kiralama dolunca yükleme YAPILIR (kendi kendini iyileştirme).
    fx.clock.advance(130_000);
    const third = await service.tick();
    expect(third.claimed).toBe(1);
    expect(uploadsOf(fx, "instagram")).toHaveLength(1);
    expect(uploadsOf(fx, "instagram")[0]?.session.uploadedParts).toBe(0);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(4);
  });
});

describe("yükleme döngüsü — oturum ömrü", () => {
  it("SÜRE DOLMUŞ oturum: kalıcı container_expired, uploadParts HİÇ çağrılmaz, yeniden deneme YOK", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 4, partsPerCall: 4 } });
    const seeded = openedSession(fx);
    await fx.service.tick();

    // Oturum süresi doldu (saat ilerledi, süre geçmişte kaldı).
    fx.repos.jobs.markState(seeded.job.id, "processing", {
      uploadUrlExpiresAt: new Date(fx.clock.ms - 1_000).toISOString(),
    });
    fx.clock.advance(5_000);

    const second = await fx.service.tick();
    expect(second.failed).toBe(1);

    const failed = jobOf(fx, seeded.job.id);
    expect(failed.state).toBe("failed");
    expect(failed.error?.kind).toBe("container_expired");
    expect(failed.error?.retryable).toBe(false);
    expect(failed.nextAttemptAt).toBeNull(); // ← yeniden deneme YOK
    expect(row(fx, seeded.job.id).next_attempt_at).toBeNull();
    expect(row(fx, seeded.job.id).finished_at).not.toBeNull();

    // SESSİCE bayt gönderilmedi: ölü bir oturuma gönderilmez.
    expect(uploadsOf(fx, "instagram")).toHaveLength(0);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(0);
    expect(auditActions(fx, seeded.job.id)).toContain("publish.upload_url_expired");

    // Üçüncü tur da denemez (iş kuyruktan çıktı).
    const third = await fx.service.tick();
    expect(third.claimed).toBe(0);
    expect(third.failed).toBe(0);
  });

  it("uploadUrlExpiresAt === null: süre UYDURULMAZ, yükleme normal ilerler", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 2, partsPerCall: 2 } });
    const seeded = openedSession(fx);
    await fx.service.tick();

    // Sağlayıcı süre vermedi: `null`. Motor kendi kafasından bir tarih UYDURMAZ.
    fx.repos.jobs.markState(seeded.job.id, "processing", { uploadUrlExpiresAt: null });
    expect(row(fx, seeded.job.id).upload_url_expires_at).toBeNull();

    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    expect(second.details[0]?.outcome).toBe("processing"); // container_expired DEĞİL
    expect(uploadsOf(fx, "instagram")).toHaveLength(1);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(2);
    // Motor alanı DOLDURMADI: hâlâ `null`.
    expect(row(fx, seeded.job.id).upload_url_expires_at).toBeNull();
    expect(auditActions(fx, seeded.job.id)).not.toContain("publish.upload_url_expired");
  });

  it("on yıl geçse de null süre 'dolmuş' sayılmaz (bayt gönderme adımına GİRİLİR)", async () => {
    const fx = fixture({ script: OPENED, upload: { totalParts: 2, partsPerCall: 2 } });
    const seeded = openedSession(fx);
    await fx.service.tick();
    fx.repos.jobs.markState(seeded.job.id, "processing", { uploadUrlExpiresAt: null });

    fx.clock.advance(10 * 365 * 24 * 3_600_000);
    await fx.service.tick();

    // Motor işi "süresi doldu" diye ÖLDÜRMEDİ: bayt gönderme adımına girdi.
    expect(uploadsOf(fx, "instagram")).toHaveLength(1);
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(2);
    // Uydurma süre YAZILMADI.
    expect(row(fx, seeded.job.id).upload_url_expires_at).toBeNull();
    expect(auditActions(fx, seeded.job.id)).not.toContain("publish.upload_url_expired");
  });
});

describe("yükleme döngüsü — sözleşme boşluğu ve hata", () => {
  it("uploadParts UYGULANMAYAN adaptör: skipped + processing DEĞİL + sıcak döngü YOK", async () => {
    // Ayrıntılı davranış testi `publisher.test.ts` içindedir; buradaki fark:
    // 15 dakikalık GERİ ÇEKİLME gerçekten yazılıyor ve iş ikinci turda
    // yeniden alınmıyor (kuyruk saniyede bir "sıcak skipped" döngüsüne girmez).
    const fx = fixture({ unsupportedUpload: true, script: OPENED });
    const seeded = openedSession(fx);

    await fx.service.tick();
    expect(row(fx, seeded.job.id).state).toBe("processing");

    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    expect(second.skipped).toBe(1);
    expect(second.published).toBe(0);
    const parked = row(fx, seeded.job.id);
    expect(parked.state).toBe("queued"); // ← "processing" DEĞİL
    expect(parked.uploaded_parts).toBe(0);
    // Geri çekilme İLERİ yazıldı: `scheduled_at` = now + 15 dk.
    expect(Date.parse(jobOf(fx, seeded.job.id).scheduledAt) - fx.clock.ms).toBe(15 * 60_000);

    // Sıcak döngü yok: aynı saatte ikinci tur hiçbir şey yapmaz.
    const again = await fx.service.tick();
    expect(again.claimed).toBe(0);
    expect(again.skipped).toBe(0);
    expect(adapterOf(fx, "instagram").callCounts().start).toBe(1);
    expect(auditActions(fx, seeded.job.id)).toContain("publish.upload_unsupported");
  });

  it("uploadParts hata fırlatırsa ilerleme YAZILMAZ ('gönderdim' denmez) ve kaldığı yerden sürer", async () => {
    const fx = fixture({
      script: OPENED,
      // İlk iki çağrı 2'şer parça kabul eder; SONRAKİ her çağrı zaman aşımı.
      upload: { totalParts: 6, partsPerCall: 2, failAfterCalls: 2 },
    });
    const seeded = openedSession(fx);

    await fx.service.tick(); // oturum + 1. yoklama
    fx.clock.advance(5_000);
    await fx.service.tick(); // 2/6
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(2);
    fx.clock.advance(5_000);
    await fx.service.tick(); // 4/6
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(4);

    // 3. çağrı ZAMAN AŞIMINA düşer: hiçbir cevap yok, hiçbir ilerleme YOK.
    fx.clock.advance(5_000);
    const failed = await fx.service.tick();
    expect(failed.retried).toBe(1);
    expect(failed.failed).toBe(0);

    // "Gönderdim sanıp" işaretlenmedi: sütun 4'te KALDI.
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(4);
    expect(row(fx, seeded.job.id).total_parts).toBe(6);
    const retried = jobOf(fx, seeded.job.id);
    expect(retried.error?.kind).toBe("network");
    expect(retried.error?.retryable).toBe(true);
    expect(row(fx, seeded.job.id).next_attempt_at).not.toBeNull(); // planlandı
    expect(row(fx, seeded.job.id).finished_at).toBeNull(); // geçici → iş kuyrukta
    expect(auditActions(fx, seeded.job.id)).toContain("publish.retried");

    // Yeniden denemede motor 0'dan değil, KALDIĞI 4'ten devam eder.
    const uploads = uploadsOf(fx, "instagram");
    expect(uploads).toHaveLength(3);
    expect(uploads.map((u) => u.session.uploadedParts)).toEqual([0, 2, 4]);
  });

  it("totalParts bilinmiyorken motor parça sayısı UYDURMAZ", async () => {
    // `totalParts` verilmez → sahte adaptör "1 parça kabul, bitti" der.
    const script: UploadScript = { partsPerCall: 1 };
    const fx = fixture({ script: OPENED, upload: script });
    const seeded = openedSession(fx);

    await fx.service.tick();
    fx.clock.advance(5_000);
    const second = await fx.service.tick();

    expect(second.details[0]?.outcome).toBe("processing");
    expect(row(fx, seeded.job.id).uploaded_parts).toBe(1);
    // `total_parts` NULL kalır: motor "1" bile uydurmaz (bilmiyorsa bilmiyor).
    expect(row(fx, seeded.job.id).total_parts).toBeNull();
  });
});