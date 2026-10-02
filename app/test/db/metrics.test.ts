/**
 * `MetricsRepo` (`src/db/repos/metrics.ts`) — GERÇEK geçici SQLite dosyası üzerinde.
 *
 * Saf mantık (`normalize`, `metricDate`, `dayCount`) `test/analytics/metrics.test.ts`
 * içinde zaten kilitli. Buradaki sorular farklı ve hepsi depolama katmanına ait:
 *
 *   * `UNIQUE(job_id, metric_date)` gerçekten engelliyor mu, `upsert` reddetmiyor
 *     mu GÜNCELLİYOR mu, güncelleme yolunda `id`/`created_at` korunuyor mu?
 *   * FK cascade gerçekten yayılıyor mu (iş silinince, içerik silinince)?
 *   * `unavailable` zarfı `logId` DAHİL round-trip'te kaybolmadan dönüyor mu?
 *   * `listByPlatform` aralığı hangi kenardan DAHİL? (kaynak: `>= from AND <= to`
 *     → İKİSİ DE dahil; `listByContent` ise `metric_date DESC` → en yeni gün önce)
 *   * `limit: 0` "tümünü getir" mi "belirtilmedi" mi? (kaynak: `pageSize(0)` →
 *     `DEFAULT_PAGE_SIZE`, yani TÜMÜNÜ DEĞİL)
 *
 * ══ ÖNCE BU: `content_metrics` YALNIZ "ÖLÇÜLEMEDİ" SATIRI TUTABİLİYOR ══════
 * `migrations/004_analytics.sql:70`:
 *     unavailable_message TEXT
 *       CHECK (unavailable_message IS NOT NULL AND TRIM(unavailable_message) <> '')
 * SQLite'ta `NULL IS NOT NULL` **0**'dır (NULL değildir) → ifade `NULL` olmadan
 * doğrudan FALSE olur → `unavailable_message = NULL` olan HER satır reddedilir.
 * 004'ün kendi yorumu (satır 88) "ikisi de var / ikisi de yok → serbest" diyor;
 * kolon CHECK'i "ikisi de yok"u tam olarak yasaklıyor. Sonuç: yazılabilen tek
 * durum `reason`+`mesaj` dolu = "ölçülemedi". `MetricsRepo.upsert()` `unavailable`
 * verilmediğinde `unavailable_message = null` yazar ve **her zaman** CHECK
 * hatasıyla düşer.
 *
 * `migrations/**` ve `src/db/**` KORUMALI olduğu için DÜZELTİLMEDİ. Bunun yerine:
 *   * `putMetric()` geçici bir `unavailable` kullanarak (aşağıda belgeli) depolama
 *     yüzeyinin GERİ KALANI gerçekten test eder,
 *   * `describe("BULGU — ...")` bloğu hatayı KİLİTLER: bugün geçer, ve
 *     `migrations/004_analytics.sql:70` düzeltildiği anda KIRMIZI olur. O gün
 *     beklentiler `not.toThrow()` / `unavailable === null` yönüne çevrilmelidir.
 *
 * NOT: bulgu "testi zorlamayla geçirme" değil, "yanlış beklentiği kilitleme"
 * değil — hatayı görünür kılan ve düzeltildiğinde düzeltilmesini ZORLAYAN bir
 * testtir.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { JobState, Platform } from "../../src/contract/index.js";
import type { UpsertMetricInput } from "../../src/db/index.js";
import type { MetricUnavailable } from "../../src/analytics/types.js";
import { nextDay } from "../../src/analytics/metrics.js";
import { newAccount, newContent, openTempDb, seed, type TempDb } from "./helpers.js";

let tmp: TempDb | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

// Sabit zaman damgaları: `nowIso()` yalnız `created_at`/`updated_at` üretir ve
// testte ÜRETİMDE OKUNMAMALIDIR — aksi halde test saate bağlı olur.
const FETCHED_1 = "2026-03-01T20:00:00.000Z";
const FETCHED_2 = "2026-03-01T23:30:00.000Z";
const FAR_PAST = "2000-01-01T00:00:00.000Z";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * `migrations/004_analytics.sql:70` yüzünden `unavailable_message` NULL
 * YAZILAMADIĞI için depolama yüzeyini test edebilmek adına her satıra geçici
 * bir `unavailable` konur. Bu bir KALICI çözüm değil; hatayı izole eden bir
 * çalışma payıdır. Kullanıcı yüzünden GELEN `unavailable`'ı her test kendi
 * verir (bkz. `putMetric` çağrılarındaki `unavailable`).
 */
const GECICI_UNAVAILABLE: MetricUnavailable = {
  reason: "provider_error",
  message: "gecici calisma payi: 004:70 nedeniyle zorunlu",
  logId: null,
};

/** Ham SQL çalıştırır (şema testleri için repository katmanının dışından). */
const ins = (t: TempDb, sql: string, ...p: unknown[]) => t.db.prepare(sql).run(...(p as never[]));

/** `content_metrics` satır sayısı — doğrudan SAYAR, depo metoduna güvenmez. */
function countMetrics(t: TempDb): number {
  const r = t.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM content_metrics").get();
  return r?.n ?? 0;
}

// ── Fabrika yardımcıları ────────────────────────────────────────────────────

interface JobSpec {
  /** Depolama anahtarı; her iş için AYRI (UNIQUE(platform, external_id) vb.). */
  key: string;
  platform?: Platform;
  state?: JobState;
  /** `undefined` → normal uzak kimlik, `null` → hiç yazılmaz, `""` → boş yazılır. */
  remoteId?: string | null;
  permalink?: string | null;
  finishedAt?: string | null;
}

/**
 * Yayın işi kurar. `ux_publish_jobs_target` (content, platform, account) üçlüyü
 * koruduğu için her iş kendi içeriğini (`newContent`) alır.
 */
function mkJob(
  t: TempDb,
  projectId: string,
  accountId: string,
  spec: JobSpec,
): { contentId: string; jobId: string } {
  const platform = spec.platform ?? "instagram";
  const content = newContent(t.repos, projectId, spec.key);
  const state = spec.state ?? "published";
  const job = t.repos.jobs.create({
    contentId: content.id,
    platform,
    accountId,
    scheduledAt: "2026-10-01T09:00:00.000Z",
    state,
  });
  if (spec.remoteId !== null) {
    t.repos.jobs.markState(job.id, state, {
      remoteId: spec.remoteId ?? `remote-${spec.key}`,
      permalink: spec.permalink ?? null,
      finishedAt: spec.finishedAt === undefined ? "2026-10-02T10:00:00.000Z" : spec.finishedAt,
    });
  }
  return { contentId: content.id, jobId: job.id };
}

/**
 * `MetricsRepo.upsert` sarmalayıcısı. `unavailable` VERİLMEZSE geçici çalışma
 * payı konur (dosya başındaki açıklama). Yazılacak zarfı `unavailable`'ı da
 * içeren bir nesne olarak yorumlayan tek yer burasıdır.
 */
function putMetric(
  t: TempDb,
  over: Partial<UpsertMetricInput> & { jobId: string; contentId: string; metricDate: string },
) {
  return t.repos.metrics.upsert({
    platform: "instagram",
    remoteId: "remote-1",
    fetchedAt: FETCHED_1,
    metrics: { views: 10 },
    unavailable: null,
    ...over,
  });
}

/** Ham `content_metrics` INSERT — şema kısıtlarını repository dışından sınamak için. */
function rawMetricInsert(
  t: TempDb,
  over: Partial<{
    id: string;
    job_id: string;
    content_id: string;
    platform: string;
    remote_id: string;
    metric_date: string;
    metrics_json: string;
    unavailable_reason: string | null;
    unavailable_message: string | null;
    log_id: string | null;
    fetched_at: string;
    created_at: string;
    updated_at: string;
  }> = {},
): void {
  const row = {
    id: "raw-1",
    job_id: "raw-job",
    content_id: "raw-content",
    platform: "instagram",
    remote_id: "raw-remote",
    metric_date: "2026-05-05",
    metrics_json: '{"metrics":{},"unknown":[],"deprecated":[]}',
    unavailable_reason: null,
    unavailable_message: null,
    log_id: null,
    fetched_at: FETCHED_1,
    created_at: FAR_PAST,
    updated_at: FAR_PAST,
    ...over,
  };
  ins(
    t,
    `INSERT INTO content_metrics (
       id, job_id, content_id, platform, remote_id, metric_date, metrics_json,
       unavailable_reason, unavailable_message, log_id, fetched_at, created_at, updated_at
     ) VALUES (@id, @job_id, @content_id, @platform, @remote_id, @metric_date, @metrics_json,
               @unavailable_reason, @unavailable_message, @log_id, @fetched_at, @created_at, @updated_at)`,
    row,
  );
}

// ── 1) upsert + UNIQUE(job_id, metric_date) ────────────────────────────────

describe("MetricsRepo.upsert — UNIQUE(job_id, metric_date) GÜNCELLEME yapar", () => {
  it("aynı iş + aynı gün ikinci yazım REDDETMEZ, satırı GÜNCELLER (tek satır kalır)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-a.mp4" });

    putMetric(t, { jobId, contentId, metricDate: "2026-03-01", metrics: { views: 0 } });
    expect(countMetrics(t)).toBe(1);

    // KAYNAK OKUNDU: `metrics.ts:316` → `ON CONFLICT (job_id, metric_date) DO
    // UPDATE SET ...`. Beklenti kaynağın davranışıdır: INSERT reddi DEĞİL,
    // UPSERT'tir. Gerekçe (dosyanın kendi yorumunda): metrikler gecikmelidir;
    // aynı gün ikinci çekim ilk değeri DÜZELTİR (TikTok 0 döndü, ertesi
    // çekimde 1.200). Reddetme seçilseydi o gün kalıcı olarak yanlış kalırdı.
    const ikinci = putMetric(t, {
      jobId,
      contentId,
      metricDate: "2026-03-01",
      metrics: { views: 1200 },
      fetchedAt: FETCHED_2,
    });

    expect(countMetrics(t)).toBe(1); // çoğaltmadı
    expect(ikinci.metrics).toEqual({ views: 1200 });
    expect(ikinci.fetchedAt).toBe(FETCHED_2);

    // Okuma tarafı da güncellenmiş satırı görmeli.
    const geri = t.repos.metrics.getByJobAndDate(jobId, "2026-03-01");
    expect(geri?.metrics).toEqual({ views: 1200 });
    expect(t.repos.metrics.listByJob(jobId)).toHaveLength(1);
  });

  it("güncelleme yolunda id ve created_at KORUNUR (sil-ekle değil, güncelleme)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-b.mp4" });

    putMetric(t, { jobId, contentId, metricDate: "2026-03-01", metrics: { views: 5 } });

    // `created_at`/`id` üretimde `nowIso()` ve uuid'den gelir; iki çağrı aynı
    // milisaniyeye düşebilir ve "korundu" iddiası BOŞ TA KALIRDI. Bu yüzden
    // iki alanı elle SABİT bir değere çekip sonra güncelleme yapıyoruz:
    // DO UPDATE listesi `id`/`created_at` içermediği için değerler olduğu gibi
    // kalmalıdır.
    ins(
      t,
      "UPDATE content_metrics SET id = ?, created_at = ?, updated_at = ? WHERE job_id = ?",
      "sabit-id",
      FAR_PAST,
      FAR_PAST,
      jobId,
    );

    const sonra = putMetric(t, {
      jobId,
      contentId,
      metricDate: "2026-03-01",
      metrics: { views: 99 },
    });

    expect(sonra.id).toBe("sabit-id");
    expect(sonra.createdAt).toBe(FAR_PAST);
    // `updated_at` ise `nowIso()` ile YENİDEN yazılır.
    expect(sonra.updatedAt).toMatch(ISO_RE);
    expect(sonra.updatedAt).not.toBe(FAR_PAST);
    expect(sonra.metrics).toEqual({ views: 99 });
    expect(countMetrics(t)).toBe(1);
  });

  it("UNIQUE kısıtı HAM SQL'de de engeller: aynı (job, gün) ikinci satır yazılamaz", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-c.mp4" });
    putMetric(t, { jobId, contentId, metricDate: "2026-03-01" });

    // Depo UPSERT olduğu için buraya yalnız DO UPDATE'siz ham INSERT ile
    // ulaşabiliyoruz. Kısıt GERÇEKTE var mı sorusunun cevabı: var.
    expect(() =>
      rawMetricInsert(t, {
        id: "ikinci",
        job_id: jobId,
        content_id: contentId,
        metric_date: "2026-03-01",
        unavailable_reason: "not_public",
        unavailable_message: "SELF_ONLY",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
    expect(countMetrics(t)).toBe(1);
  });

  it("farklı GÜNLER ayrı satırdır; UNIQUE gün bazlıdır", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-d.mp4" });

    putMetric(t, { jobId, contentId, metricDate: "2026-03-01", metrics: { views: 1 } });
    putMetric(t, { jobId, contentId, metricDate: "2026-03-02", metrics: { views: 2 } });
    putMetric(t, { jobId, contentId, metricDate: "2026-03-03", metrics: { views: 3 } });

    expect(countMetrics(t)).toBe(3);
    expect(t.repos.metrics.listByJob(jobId).map((r) => r.metricDate)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
  });

  it("UNIQUE'te platform YOK: aynı iş + aynı gün başka platform satırı YAZMAZ, değiştirir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-e.mp4" });

    putMetric(t, {
      jobId,
      contentId,
      platform: "instagram",
      metricDate: "2026-03-01",
      metrics: { views: 1 },
    });
    putMetric(t, {
      jobId,
      contentId,
      platform: "tiktok",
      metricDate: "2026-03-01",
      metrics: { views: 2 },
    });

    // Şema gerçeği: UNIQUE (job_id, metric_date). Bir iş tek platforma yayınlandığı
    // için bu doğru bir kısıttır — ama test bunu KAYNAĞIN davranışı olarak
    // kilitler, "olması gereken" diye değiştirmez.
    expect(countMetrics(t)).toBe(1);
    expect(t.repos.metrics.getByJobAndDate(jobId, "2026-03-01")?.platform).toBe("tiktok");
  });

  it("upsert girdi doğrulaması veritabanına UĞRAMADAN reddeder (erken hata)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "upsert-f.mp4" });
    const ok = { jobId, contentId, metricDate: "2026-03-01", platform: "instagram" } as const;

    expect(() => putMetric(t, { ...ok, platform: "facebook" as Platform })).toThrow(
      /Geçersiz platform/,
    );
    // GLOB `2026-1-1`'i reddeder; `isMetricDate` de reddeder.
    expect(() => putMetric(t, { ...ok, metricDate: "2026-1-1" })).toThrow(/Geçersiz metricDate/);
    // Biçim DOĞRU ama olmayan gün: GLOB kabul ederdi, `isMetricDate` reddeder.
    // Tek gerçek yazma yolunda kural ihlal edilemiyor (bkz. dosya sonundaki NOT).
    expect(() => putMetric(t, { ...ok, metricDate: "2026-13-01" })).toThrow(/Geçersiz metricDate/);
    expect(() => putMetric(t, { ...ok, remoteId: "" })).toThrow(/remoteId zorunludur/);
    expect(() => putMetric(t, { ...ok, jobId: "  " })).toThrow(/jobId zorunludur/);

    expect(countMetrics(t)).toBe(0);
  });

  it("getByJobAndDate yazılmamış (iş, gün) çifti için null döner", () => {
    tmp = openTempDb();
    const t = tmp;
    expect(t.repos.metrics.getByJobAndDate("yok-boyle-bir-is", "2026-03-01")).toBeNull();
  });
});

// ── 2) Round-trip: ölçüm zarfı ─────────────────────────────────────────────

describe("MetricsRepo — zarf round-trip'i: alan kaybı yok", () => {
  it("`0` ile `null` AYRI kalır, metrics + unknown + deprecated kayıpsız döner", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "rt-a.mp4" });

    const metrics = { views: 0, likes: null, shares: 42, watch_time_sec: 12.5 };
    const unknown = ["zeta", "alpha"]; // KAYNAK: `unknown` yazılırken `.sort()` edilir
    const deprecated = [
      { providerName: "plays", value: null, note: "IG kaldırdı" },
      { providerName: "impressions", value: 7, note: "" },
    ];

    const y = putMetric(t, {
      jobId,
      contentId,
      metricDate: "2026-03-01",
      metrics,
      unknown,
      deprecated,
    });

    // SIFIR SIFIRDIR: okuma tarafı `Number(x) || 0` YAZMAZ (metrics.ts:145).
    expect(y.metrics).toEqual(metrics);
    expect(y.metrics["views"]).toBe(0);
    expect(y.metrics["likes"]).toBeNull();
    expect(y.metrics["shares"]).toBe(42);
    // `unknown` sırası KORUNMAZ, sıralanır — test kaynağın gerçek davranışını kilitler.
    expect(y.unknown).toEqual(["alpha", "zeta"]);
    expect(y.deprecated).toEqual(deprecated);

    const geri = t.repos.metrics.getByJobAndDate(jobId, "2026-03-01");
    expect(geri?.metrics).toEqual(metrics);
    expect(geri?.deprecated).toEqual(deprecated);
    expect(geri?.platform).toBe("instagram");
    expect(geri?.remoteId).toBe("remote-1");
    expect(geri?.fetchedAt).toBe(FETCHED_1);
    expect(geri?.createdAt).toMatch(ISO_RE);
    expect(geri?.updatedAt).toMatch(ISO_RE);
  });

  it("`unavailable` zarfı: reason + message + logId + platform + fetchedAt kaybolmaz", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, {
      key: "rt-b.mp4",
      platform: "tiktok",
    });

    const y = putMetric(t, {
      jobId,
      contentId,
      platform: "tiktok",
      remoteId: "tt-remote-1",
      metricDate: "2026-03-01",
      metrics: {},
      unavailable: {
        reason: "not_public",
        message: "Video SELF_ONLY; insights dönmedi.",
        logId: "log_id-abc-123",
      },
      fetchedAt: FETCHED_1,
    });

    // `logId` hem kolonda (`log_id`) hem zarfın içinde tutulur; ikisi de aynı.
    expect(y.logId).toBe("log_id-abc-123");
    expect(y.unavailable).toEqual({
      reason: "not_public",
      message: "Video SELF_ONLY; insights dönmedi.",
      logId: "log_id-abc-123",
    });
    expect(y.platform).toBe("tiktok");
    expect(y.remoteId).toBe("tt-remote-1");
    expect(y.fetchedAt).toBe(FETCHED_1);
    expect(y.metricDate).toBe("2026-03-01");

    // Aynı satır ikinci kez okunduğunda da zarf BİREBİRİNCE.
    const geri = t.repos.metrics.getByJobAndDate(jobId, "2026-03-01");
    expect(geri?.unavailable?.logId).toBe("log_id-abc-123");
    expect(geri?.unavailable?.reason).toBe("not_public");
    expect(geri?.unavailable?.message).toBe("Video SELF_ONLY; insights dönmedi.");
    expect(geri?.logId).toBe("log_id-abc-123");
    // Kolon gerçekten de yazıldı (zaraf değil, sorgulanabilir kolon).
    const kolon = t.db
      .prepare<[string], { log_id: string | null; unavailable_reason: string | null }>(
        "SELECT log_id, unavailable_reason FROM content_metrics WHERE job_id = ?",
      )
      .get(jobId);
    expect(kolon?.log_id).toBe("log_id-abc-123");
    expect(kolon?.unavailable_reason).toBe("not_public");
  });

  it("logId üst düzey `logId` alanından da gelir; zarf onu ALIR", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "rt-b2.mp4" });

    const y = putMetric(t, {
      jobId,
      contentId,
      metricDate: "2026-03-01",
      unavailable: { reason: "deleted", message: "içerik silinmiş", logId: null },
      logId: "ust-duzey-log-id",
    });

    expect(y.logId).toBe("ust-duzey-log-id");
    // `logId = input.logId ?? unavailable.logId` (metrics.ts:304) → ikisi de aynı
    // değere bağlanır; hangisi verilirse verilsin kolon tek kaynaktır.
    expect(y.unavailable?.logId).toBe("ust-duzey-log-id");
  });

  it("boş unavailable mesajı CHECK'i ihlal etmeden sebebin varsayılanına tamamlanır", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "rt-d.mp4" });

    const y = putMetric(t, {
      jobId,
      contentId,
      metricDate: "2026-03-01",
      metrics: {},
      unavailable: { reason: "not_found", message: "   ", logId: null },
    });

    // `unavailable_message TEXT CHECK (... TRIM(...) <> '')` → boş yazılırsa
    // transaction DÜŞERDİ ve ölçüm kaydı KAYBOLURDU. `writeUnavailable`
    // (metrics.ts:240) varsayılan mesajı yazar.
    expect(y.unavailable?.reason).toBe("not_found");
    expect(y.unavailable?.message).toBe("İçerik platform tarafında bulunamadı.");
    expect(countMetrics(t)).toBe(1);
  });

  it("okuma savunmacıdır: JSON'da sayı OLMAYAN değer null olur, satır yine okunur", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "rt-e.mp4" });
    putMetric(t, { jobId, contentId, metricDate: "2026-03-01", metrics: { views: 7 } });

    // Elle bozulan JSON: satır KAYBOLMAZ, değerler null'a düşer.
    // (Sessizce `{}` dönmek "ölçüldü ve hepsi sıfır" gibi görünebilirdi.)
    ins(
      t,
      "UPDATE content_metrics SET metrics_json = ? WHERE job_id = ?",
      '{"metrics":{"views":"çok","likes":null},"unknown":"dizi-degil","deprecated":[7]}',
      jobId,
    );

    const geri = t.repos.metrics.getByJobAndDate(jobId, "2026-03-01");
    expect(geri).not.toBeNull();
    expect(geri?.metrics).toEqual({ views: null, likes: null });
    expect(geri?.unknown).toEqual([]);
    expect(geri?.deprecated).toEqual([]);
  });
});

// ── 3) listByPlatform — tarih aralığı ──────────────────────────────────────

describe("MetricsRepo.listByPlatform — aralık İKİ KENARDAN DAHİL", () => {
  it("from/to dahil; iki platform karışınca yalnız istenen döner (tarihte ASC)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const ig = mkJob(t, project.id, account.id, { key: "plat-ig.mp4", platform: "instagram" });
    const yt = mkJob(t, project.id, account.id, { key: "plat-yt.mp4", platform: "youtube" });

    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]) {
      putMetric(t, { jobId: ig.jobId, contentId: ig.contentId, metricDate: d });
      putMetric(t, {
        jobId: yt.jobId,
        contentId: yt.contentId,
        platform: "youtube",
        metricDate: d,
      });
    }

    // KAYNAK OKUNDU: `metrics.ts:392` → `metric_date >= ? AND metric_date <= ?`.
    // İKİ TARAF DA `>=`/`<=` olduğu için `from` ve `to` DAHİL'dir.
    const aralik = t.repos.metrics.listByPlatform("instagram", "2026-03-02", "2026-03-03");
    expect(aralik.map((r) => r.metricDate)).toEqual(["2026-03-02", "2026-03-03"]);
    // Yalnız istenen platform.
    expect(aralik.every((r) => r.platform === "instagram")).toBe(true);

    // Tek günlük aralık `from === to` iken O GÜNÜ verir (dahil/dahil olmanın
    // doğrudan kanıtı: "hariç" olsaydı boş dönerdi).
    const tekGun = t.repos.metrics.listByPlatform("instagram", "2026-03-01", "2026-03-01");
    expect(tekGun.map((r) => r.metricDate)).toEqual(["2026-03-01"]);

    // Tüm aralık.
    expect(t.repos.metrics.listByPlatform("instagram", "2026-03-01", "2026-03-04")).toHaveLength(4);
    // Hiç yazılmamış platform için boş — diğer platforma sızmaz.
    expect(t.repos.metrics.listByPlatform("tiktok", "2026-03-01", "2026-03-04")).toHaveLength(0);
  });

  it("ters aralık ve geçersiz tarih/platform reddedilir (sessiz boş liste DÖNMEZ)", () => {
    tmp = openTempDb();
    const t = tmp;
    expect(() => t.repos.metrics.listByPlatform("instagram", "2026-03-05", "2026-03-01")).toThrow(
      /Tarih aralığı ters/,
    );
    expect(() => t.repos.metrics.listByPlatform("instagram", "2026-3-1", "2026-03-02")).toThrow(
      /Geçersiz from/,
    );
    expect(() => t.repos.metrics.listByPlatform("instagram", "2026-03-01", "2026-03-32")).toThrow(
      /Geçersiz to/,
    );
    expect(() =>
      // @ts-expect-error — kasıtlı geçersiz platform
      t.repos.metrics.listByPlatform("facebook", "2026-03-01", "2026-03-02"),
    ).toThrow(/Geçersiz platform/);
  });
});

// ── 4) listByContent / listByJob ───────────────────────────────────────────

describe("MetricsRepo.listByContent / listByJob", () => {
  it("listByContent yalnız o içeriğin satırlarını verir, EN YENİ GÜN ÖNCE", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lc-a.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "lc-b.mp4" });

    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: d });
    }
    putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: "2026-03-02" });

    // KAYNAK OKUNDU: `metrics.ts:374` → `ORDER BY metric_date DESC, platform ASC,
    // job_id ASC`. Yani tarih sırası AZALAN (panelde "en yeni gün üstte").
    const liste = t.repos.metrics.listByContent(a.contentId);
    expect(liste.map((r) => r.metricDate)).toEqual(["2026-03-03", "2026-03-02", "2026-03-01"]);
    expect(liste.every((r) => r.contentId === a.contentId)).toBe(true);
    expect(liste.every((r) => r.jobId === a.jobId)).toBe(true);
    // Diğer içeriğin satırı SIZINTI YAPMADI.
    expect(t.repos.metrics.listByContent(b.contentId)).toHaveLength(1);
    expect(t.repos.metrics.listByContent("yok-boyle-bir-icerik")).toEqual([]);
  });

  it("listByContent tarih aralığı ve platform filtresini birlikte uygular", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lc-c.mp4" });
    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: d });
    }

    expect(
      t.repos.metrics
        .listByContent(a.contentId, { from: "2026-03-02", to: "2026-03-03" })
        .map((r) => r.metricDate),
    ).toEqual(["2026-03-03", "2026-03-02"]);
    // Kaynakta `from`/`to` DAHİL (`>=` / `<=`), `listByPlatform` ile aynı kural.
    expect(
      t.repos.metrics
        .listByContent(a.contentId, { from: "2026-03-02" })
        .map((r) => r.metricDate),
    ).toEqual(["2026-03-04", "2026-03-03", "2026-03-02"]);
    expect(t.repos.metrics.listByContent(a.contentId, { platform: "tiktok" })).toHaveLength(0);
    expect(() => t.repos.metrics.listByContent(a.contentId, { from: "2026-3-2" })).toThrow(
      /Geçersiz from/,
    );
    expect(() => t.repos.metrics.listByContent(a.contentId, { platform: "x" as Platform })).toThrow(
      /Geçersiz platform/,
    );
  });

  it("listByJob yalnız o işin günlerini eskiden yeniye (ASC) verir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lj-a.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "lj-b.mp4" });
    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-02" });
    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-01" });
    putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: "2026-03-01" });

    expect(t.repos.metrics.listByJob(a.jobId).map((r) => r.metricDate)).toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(t.repos.metrics.listByJob("yok-boyle-bir-is")).toEqual([]);
  });
});

// ── 5) latestPerJob ────────────────────────────────────────────────────────

describe("MetricsRepo.latestPerJob", () => {
  it("her iş için EN SON metric_date satırını verir (job_id ASC)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lp-a.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "lp-b.mp4" });

    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: d });
    }
    for (const d of ["2026-04-01", "2026-04-02"]) {
      putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: d });
    }

    const son = t.repos.metrics.latestPerJob([b.jobId, a.jobId]);
    expect(son).toHaveLength(2);
    // `ORDER BY m.job_id ASC` — rastgele uuid üretim sırası değil.
    expect(son.map((r) => r.jobId)).toEqual([a.jobId, b.jobId].sort());
    expect(son.find((r) => r.jobId === a.jobId)?.metricDate).toBe("2026-03-03");
    expect(son.find((r) => r.jobId === b.jobId)?.metricDate).toBe("2026-04-02");
  });

  it("döndürülen zarf EN SON GÜNÜN zarfıdır, eski günün `unavailable`ı değil", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const j = mkJob(t, project.id, account.id, { key: "lp-c.mp4" });

    putMetric(t, {
      jobId: j.jobId,
      contentId: j.contentId,
      metricDate: "2026-03-01",
      unavailable: { reason: "not_public", message: "ilk gün gizli", logId: "log-eski" },
    });
    putMetric(t, {
      jobId: j.jobId,
      contentId: j.contentId,
      metricDate: "2026-03-02",
      metrics: { views: 250 },
      unavailable: { reason: "provider_error", message: "5xx döndü.", logId: "log-yeni" },
    });

    const son = t.repos.metrics.latestPerJob([j.jobId]);
    expect(son).toHaveLength(1);
    expect(son[0]?.metricDate).toBe("2026-03-02");
    expect(son[0]?.metrics).toEqual({ views: 250 });
    expect(son[0]?.unavailable).toEqual({
      reason: "provider_error",
      message: "5xx döndü.",
      logId: "log-yeni",
    });
    // Ölçülemeyen gün de listede — "yalnız ölçülenler" gibi bir filtre YOK.
    expect(t.repos.metrics.listByJob(j.jobId)).toHaveLength(2);
  });

  it("ölçümü olmayan iş LİSTEDE YOKTUR (uydurma satır üretilmez)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lp-d.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "lp-e.mp4" });
    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-01" });

    expect(t.repos.metrics.latestPerJob([a.jobId, b.jobId])).toHaveLength(1);
    expect(t.repos.metrics.latestPerJob([b.jobId])).toEqual([]);
  });

  it("boş/geçersiz kimlik listesi: boş dizi ve yalnız var olan işler", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "lp-f.mp4" });
    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-01" });

    expect(t.repos.metrics.latestPerJob([])).toEqual([]);
    expect(t.repos.metrics.latestPerJob(["", "yok-boyle-bir-is"])).toEqual([]);
    expect(t.repos.metrics.latestPerJob(["yok-boyle-bir-is", a.jobId])).toHaveLength(1);
  });
});

// ── 6) listMeasurableJobs ──────────────────────────────────────────────────

describe("MetricsRepo.listMeasurableJobs", () => {
  it("yalnız remote_id DOLU ve yayınlanmış işleri verir (queued/failed YOK)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos, "instagram");
    const tiktok = newAccount(t.repos, "tiktok", "tk");

    const published = mkJob(t, project.id, account.id, {
      key: "mj-pub.mp4",
      state: "published",
      finishedAt: "2026-10-03T00:00:00.000Z",
    });
    const noLink = mkJob(t, project.id, account.id, {
      key: "mj-nolink.mp4",
      state: "published_no_link",
      finishedAt: "2026-10-01T00:00:00.000Z",
    });
    mkJob(t, project.id, account.id, { key: "mj-queued.mp4", state: "queued" });
    mkJob(t, project.id, account.id, { key: "mj-failed.mp4", state: "failed" });
    mkJob(t, project.id, account.id, { key: "mj-preparing.mp4", state: "preparing" });
    // Uzaktaki kimlik olmadan insights çağrısı YAPILAMAZ: `remote_id IS NULL`.
    mkJob(t, project.id, account.id, { key: "mj-remote-yok.mp4", state: "published", remoteId: null });
    // Boş string de "kimliksiz" sayılır (`TRIM(remote_id) <> ''`).
    mkJob(t, project.id, account.id, { key: "mj-remote-bos.mp4", state: "published", remoteId: "" });
    // `finished_at` bilinçli olarak EN SON: sıralama iddiası üç işin hepsini
    // kapsasın (noLink 10-01 < published 10-03 < tt 10-04).
    const tt = mkJob(t, project.id, tiktok.id, {
      key: "mj-tt.mp4",
      platform: "tiktok",
      state: "published",
      finishedAt: "2026-10-04T00:00:00.000Z",
    });

    const hepsi = t.repos.metrics.listMeasurableJobs();
    expect(hepsi.map((j) => j.jobId).sort()).toEqual(
      [published.jobId, noLink.jobId, tt.jobId].sort(),
    );
    // `ORDER BY COALESCE(finished_at, updated_at) ASC` → en eski biten önce.
    expect(hepsi.slice(0, 2).map((j) => j.jobId)).toEqual([noLink.jobId, published.jobId]);

    // Alanlar taşınır.
    const noLinkKayit = hepsi.find((j) => j.jobId === noLink.jobId)!;
    expect(noLinkKayit.contentId).toBe(noLink.contentId);
    expect(noLinkKayit.platform).toBe("instagram");
    expect(noLinkKayit.accountId).toBe(account.id);
    expect(noLinkKayit.finishedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(noLinkKayit.remoteId).toBe("remote-mj-nolink.mp4");
    expect(noLinkKayit.permalink).toBeNull();

    // Platform filtresi.
    expect(
      t.repos.metrics.listMeasurableJobs(200, "instagram").map((j) => j.jobId).sort(),
    ).toEqual([published.jobId, noLink.jobId].sort());
    expect(t.repos.metrics.listMeasurableJobs(200, "tiktok").map((j) => j.jobId)).toEqual([tt.jobId]);
    // limit.
    expect(t.repos.metrics.listMeasurableJobs(1)).toHaveLength(1);
    expect(() =>
      // @ts-expect-error — kasıtlı geçersiz platform
      t.repos.metrics.listMeasurableJobs(200, "facebook"),
    ).toThrow(/Geçersiz platform/);
  });

  it("ölçüm yazılmamış yayınlanmış iş yine listelenir (geçmiş olmaması hata değil)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "mj-bos-gecmis.mp4" });
    expect(t.repos.metrics.listMeasurableJobs().map((j) => j.jobId)).toEqual([a.jobId]);
  });
});

// ── 7) FK cascade ──────────────────────────────────────────────────────────

describe("content_metrics — FK ON DELETE CASCADE gerçekten yayılıyor", () => {
  it("İŞ silinince o işin metrik satırları SİLİNİR (sayıyı sorgula)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const silinecek = mkJob(t, project.id, account.id, { key: "fk-a.mp4" });
    const duracak = mkJob(t, project.id, account.id, { key: "fk-b.mp4" });

    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
      putMetric(t, { jobId: silinecek.jobId, contentId: silinecek.contentId, metricDate: d });
    }
    putMetric(t, { jobId: duracak.jobId, contentId: duracak.contentId, metricDate: "2026-03-01" });
    expect(countMetrics(t)).toBe(4);

    expect(t.repos.jobs.remove(silinecek.jobId)).toBe(true);

    expect(countMetrics(t)).toBe(1);
    expect(t.repos.metrics.getByJobAndDate(silinecek.jobId, "2026-03-01")).toBeNull();
    expect(t.repos.metrics.listByJob(silinecek.jobId)).toEqual([]);
    // Diğer işin ölçümü DURUYOR.
    expect(t.repos.metrics.listByJob(duracak.jobId)).toHaveLength(1);
  });

  it("İÇERİK silinince metrik satırı silinir — content_id FK'si iş zincirinden BAĞIMSIZ", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "fk-c1.mp4" });
    const diger = newContent(t.repos, project.id, "fk-c2.mp4");

    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-01" });
    // Aynı işin İKİNCİ satırı, `content_id`'si DİĞER içeriğe yönlendirilmiş.
    // (Kaynak buna izin verir: DO UPDATE `content_id = excluded.content_id`.)
    // Bu sayede `contents` silindiğinde satırın kaybolması, işin silinmesinden
    // değil `content_metrics.content_id` kaskadından KAYNAKLANMAK ZORUNDA.
    putMetric(t, {
      jobId: a.jobId,
      contentId: diger.id,
      metricDate: "2026-03-02",
      remoteId: "remote-2",
    });
    expect(countMetrics(t)).toBe(2);

    expect(t.repos.contents.remove(diger.id)).toBe(true);

    // Yönlendirilmiş satır SİLİNDİ...
    expect(t.repos.metrics.getByJobAndDate(a.jobId, "2026-03-02")).toBeNull();
    // ...ama aynı işin diğer satırı ve İŞİN KENDİSİ duruyor.
    expect(countMetrics(t)).toBe(1);
    expect(t.repos.jobs.getById(a.jobId)).not.toBeNull();
    expect(t.repos.metrics.getByJobAndDate(a.jobId, "2026-03-01")).not.toBeNull();
  });

  it("içerik silinince zincirleme olarak da metrikler temizlenir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "fk-d.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "fk-e.mp4" });
    putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: "2026-03-01" });
    putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: "2026-03-01" });

    expect(t.repos.contents.remove(a.contentId)).toBe(true);

    expect(countMetrics(t)).toBe(1);
    expect(t.repos.jobs.getById(a.jobId)).toBeNull();
    expect(t.repos.metrics.listByContent(a.contentId)).toEqual([]);
    expect(t.repos.metrics.listByJob(b.jobId)).toHaveLength(1);
  });

  it("var olmayan job_id reddedilir — FK ters yönde de çalışır", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "fk-f.mp4" });

    // `unavailable_message` dolu yazılır (004:70 yüzünden NULL imkânsız) ki
    // testin ölçtüğü kısıt BAŞKA bir CHECK olmasın.
    expect(() =>
      rawMetricInsert(t, {
        id: "hayali",
        job_id: "olmayan-is",
        content_id: a.contentId,
        metric_date: "2026-05-05",
        unavailable_reason: "not_public",
        unavailable_message: "SELF_ONLY",
      }),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(countMetrics(t)).toBe(0);
  });
});

// ── 8) deleteByContent ─────────────────────────────────────────────────────

describe("MetricsRepo.deleteByContent", () => {
  it("yalnız o içeriğin metriklerini siler, diğer içeriklerin geçmişi DURUR", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "db-a.mp4" });
    const b = mkJob(t, project.id, account.id, { key: "db-b.mp4" });

    for (const d of ["2026-03-01", "2026-03-02"]) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: d });
    }
    putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: "2026-03-01" });
    putMetric(t, { jobId: b.jobId, contentId: b.contentId, metricDate: "2026-03-02" });
    expect(countMetrics(t)).toBe(4);

    // Dönen sayı SİLEN satır adedidir (metrics.ts:485 → `.changes`).
    expect(t.repos.metrics.deleteByContent(a.contentId)).toBe(2);

    expect(countMetrics(t)).toBe(2);
    expect(t.repos.metrics.listByContent(a.contentId)).toEqual([]);
    expect(t.repos.metrics.listByJob(a.jobId)).toEqual([]);
    expect(t.repos.metrics.listByJob(b.jobId)).toHaveLength(2);
    // İş KENDİSİ silinmez: yalnız ölçüm geçmişi temizlenir.
    expect(t.repos.jobs.getById(a.jobId)).not.toBeNull();
    // Tekrar silmek 0 döner (uygulanabilir iş yok → hata değil, sayı 0).
    expect(t.repos.metrics.deleteByContent(a.contentId)).toBe(0);
    expect(t.repos.metrics.deleteByContent("yok-boyle-bir-icerik")).toBe(0);
  });
});

// ── 9) Sayfalama ───────────────────────────────────────────────────────────

describe("MetricsRepo — limit/offset sayfalama", () => {
  it("`limit: 0` TÜMÜNÜ GETİRMEZ: 'belirtilmedi'ye düşer (100)", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "pg-a.mp4" });

    // 120 günlük geçmiş: 100 sınırı GÖRÜNÜR olsun diye. Tek iş yeterlidir
    // (UNIQUE(job_id, metric_date) gün bazlıdır, FK'lar gerçektir).
    let day = "2026-01-01";
    for (let i = 0; i < 120; i += 1) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: day });
      day = nextDay(day);
    }
    expect(countMetrics(t)).toBe(120);

    // KAYNAK OKUNDU: `paging.ts:22` → `pageSize(0)` `base <= 0` olduğu için
    // `fallback` (DEFAULT_PAGE_SIZE = 100) döner. Yani `limit: 0` "sınırsız"
    // DEĞİLDİR; yüksek bir sayfa boyutudur.
    expect(t.repos.metrics.listByContent(a.contentId, { limit: 0 })).toHaveLength(100);
    expect(t.repos.metrics.listByContent(a.contentId)).toHaveLength(100);
    expect(t.repos.metrics.listByContent(a.contentId, { limit: -5 })).toHaveLength(100);
    expect(t.repos.metrics.listByContent(a.contentId, { limit: 120 })).toHaveLength(120);
    // `MAX_PAGE_SIZE` tavanı: 500'den büyük istek kırpılır (120 < 500 olduğu
    // için sayı DEĞİL, yalnız istisna atmadığı görülür).
    expect(t.repos.metrics.listByContent(a.contentId, { limit: 1_000_000 })).toHaveLength(120);
  });

  it("limit/offset sayfaları; negatif offset 0'a düşer, taşan offset boş döner", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "pg-b.mp4" });
    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]) {
      putMetric(t, { jobId: a.jobId, contentId: a.contentId, metricDate: d });
    }

    const ilk = t.repos.metrics.listByContent(a.contentId, { limit: 2 });
    const ikinci = t.repos.metrics.listByContent(a.contentId, { limit: 2, offset: 2 });
    const ucuncu = t.repos.metrics.listByContent(a.contentId, { limit: 2, offset: 4 });
    // DESC sıralama sayfalar arasında BOZULMAZ: ilk sayfa en yeni günler.
    expect(ilk.map((r) => r.metricDate)).toEqual(["2026-03-05", "2026-03-04"]);
    expect(ikinci.map((r) => r.metricDate)).toEqual(["2026-03-03", "2026-03-02"]);
    expect(ucuncu.map((r) => r.metricDate)).toEqual(["2026-03-01"]);
    expect(t.repos.metrics.listByContent(a.contentId, { limit: 2, offset: 99 })).toEqual([]);
    // Negatif/bozuk offset başa döner.
    expect(
      t.repos.metrics.listByContent(a.contentId, { limit: 2, offset: -10 }).map((r) => r.metricDate),
    ).toEqual(["2026-03-05", "2026-03-04"]);
    expect(
      t.repos.metrics.listByContent(a.contentId, { limit: Number.NaN, offset: Number.NaN }),
    ).toHaveLength(5);
  });
});

// ── 10) Şema kısıtları (repository dışından) ───────────────────────────────

describe("content_metrics — CHECK kısıtları ham SQL'de de geçerli", () => {
  it("geçersiz platform reddedilir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "ck-a.mp4" });

    // Her platform için AYRI gün: UNIQUE (job_id, metric_date) aynı günü
    // ikinci kez yazmayı zaten reddettiği için (başka testin konusu) döngüde
    // günü değiştirmek zorundayız; yoksa test yanlış kısıtı ölçerdi.
    const guler = ["2026-05-05", "2026-05-06", "2026-05-07"];
    ["instagram", "tiktok", "youtube"].forEach((p, i) => {
      expect(() =>
        rawMetricInsert(t, {
          id: `ck-${p}`,
          job_id: a.jobId,
          content_id: a.contentId,
          platform: p,
          metric_date: guler[i]!,
          unavailable_reason: "not_public",
          unavailable_message: "SELF_ONLY",
        }),
      ).not.toThrow();
    });
    expect(() =>
      rawMetricInsert(t, {
        id: "ck-kotu",
        job_id: a.jobId,
        content_id: a.contentId,
        platform: "facebook",
        metric_date: "2026-05-08",
        unavailable_reason: "not_public",
        unavailable_message: "SELF_ONLY",
      }),
    ).toThrow(/CHECK constraint failed/i);
    expect(countMetrics(t)).toBe(3);
  });

  it("boş remote_id ve bozuk metric_date biçimi reddedilir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "ck-b.mp4" });
    const temel = {
      job_id: a.jobId,
      content_id: a.contentId,
      unavailable_reason: "not_public",
      unavailable_message: "SELF_ONLY",
    };

    expect(() =>
      rawMetricInsert(t, { ...temel, id: "ck-remote-bos", remote_id: "" }),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      rawMetricInsert(t, { ...temel, id: "ck-tarih", metric_date: "2026-3-1" }),
    ).toThrow(/CHECK constraint failed/i);
    expect(countMetrics(t)).toBe(0);
  });

  it("json_valid: bozuk JSON veritabanına GİREMEZ", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "ck-c.mp4" });
    const temel = {
      job_id: a.jobId,
      content_id: a.contentId,
      unavailable_reason: "not_public",
      unavailable_message: "SELF_ONLY",
    };

    for (const kotu of ['{"metrics":{', "bozuk metin", "[1,2,3,", "'tek'"]) {
      expect(
        () =>
          rawMetricInsert(t, {
            ...temel,
            id: `ck-json-${kotu.length}-${kotu.charCodeAt(0)}`,
            metrics_json: kotu,
          }),
        `metrics_json=${kotu} kabul edilmemeliydi`,
      ).toThrow(/CHECK constraint failed/i);
    }
    // Geçerli JSON geçer.
    expect(() =>
      rawMetricInsert(t, {
        ...temel,
        id: "ck-json-iyi",
        metrics_json: '{"metrics":{"views":3},"unknown":[],"deprecated":[]}',
      }),
    ).not.toThrow();
    expect(countMetrics(t)).toBe(1);
    expect(t.repos.metrics.getByJobAndDate(a.jobId, "2026-05-05")?.metrics).toEqual({ views: 3 });
  });

  it("sebep kümesi CHECK'i: tanımsız reason reddedilir", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "ck-d.mp4" });
    const temel = { job_id: a.jobId, content_id: a.contentId, metric_date: "2026-05-05" };

    // Yine AYRI günler: UNIQUE (job_id, metric_date) nedeniyle.
    const guler = ["2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09"];
    ["not_public", "not_found", "no_scope", "provider_error", "deleted"].forEach((r, i) => {
      expect(() =>
        rawMetricInsert(t, {
          ...temel,
          id: `ck-reason-${r}`,
          metric_date: guler[i]!,
          unavailable_reason: r,
          unavailable_message: "test",
        }),
      ).not.toThrow();
    });
    expect(() =>
      rawMetricInsert(t, {
        ...temel,
        id: "ck-reason-yok",
        metric_date: "2026-06-06",
        unavailable_reason: "neden_bilmiyorum",
        unavailable_message: "test",
      }),
    ).toThrow(/CHECK constraint failed/i);
    expect(countMetrics(t)).toBe(5);
  });

  it("boş/undefined log_id ölçülebilir satırı bozmaz; destek kanıtı ayrı alanda", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "ck-e.mp4" });

    const y = putMetric(t, {
      jobId: a.jobId,
      contentId: a.contentId,
      metricDate: "2026-05-05",
      unavailable: { reason: "no_scope", message: "izin eksik", logId: null },
    });
    expect(y.logId).toBeNull();
    expect(y.unavailable?.logId).toBeNull();

    rawMetricInsert(t, {
      id: "ck-log-id",
      job_id: a.jobId,
      content_id: a.contentId,
      metric_date: "2026-05-06",
      unavailable_reason: "provider_error",
      unavailable_message: "5xx",
      log_id: "log-abc-999",
    });
    expect(t.repos.metrics.getByJobAndDate(a.jobId, "2026-05-06")?.unavailable).toEqual({
      reason: "provider_error",
      message: "5xx",
      logId: "log-abc-999",
    });
  });
});

// ── 11) BULGU: `content_metrics` yalnız "ölçülemedi" satırı tutabiliyor ────

describe("BULGU — `unavailable: null` (yani 'ölçüldü') PERSİST EDİLEMİYOR", () => {
  it("upsert `unavailable` vermediğinde ARTIK DÜŞMÜYOR, satır yazılıyor", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const { contentId, jobId } = mkJob(t, project.id, account.id, { key: "fix-a.mp4" });

    // Bu, `MetricsRepo`'nun EN NORMAL kullanımıdır: sağlayıcı veri döndü, ölçüm
    // anlamlı, `unavailable` yok. 004'teki CHECK bunu reddediyordu ve analitik
    // hiçbir ölçümü saklayamıyordu. `005_analytics_unavailable_fix` düzeltti.
    expect(() =>
      t.repos.metrics.upsert({
        jobId,
        contentId,
        platform: "instagram",
        remoteId: "remote-1",
        metricDate: "2026-03-01",
        metrics: { views: 1200 },
        fetchedAt: FETCHED_1,
      }),
    ).not.toThrow();

    // Açık `unavailable: null` ile de aynı sonuç.
    expect(() =>
      t.repos.metrics.upsert({
        jobId,
        contentId,
        platform: "instagram",
        remoteId: "remote-2",
        metricDate: "2026-03-02",
        metrics: { views: 1300 },
        fetchedAt: FETCHED_2,
        unavailable: null,
      }),
    ).not.toThrow();

    expect(countMetrics(t)).toBe(2);

    // Okuma tarafı zarfı `null` veriyor, metrikler korunuyor.
    const kayit = t.repos.metrics.getByJobAndDate(jobId, "2026-03-01");
    expect(kayit?.unavailable).toBeNull();
    expect(kayit?.metrics["views"]).toBe(1200);
  });

  it("şema artık dört durumun tamamına izin veriyor", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "fix-b.mp4" });
    const d = (n: number) => ({ job_id: a.jobId, content_id: a.contentId, metric_date: `2026-05-0${n}` });

    // "reason var + message yok" → çift yönlü kural gereği YASAK.
    expect(() =>
      rawMetricInsert(t, { ...d(1), id: "fix-reason-only", unavailable_reason: "not_public" }),
    ).toThrow(/CHECK constraint failed/i);
    // "message var + reason yok" → YASAK.
    expect(() =>
      rawMetricInsert(t, { ...d(2), id: "fix-message-only", unavailable_message: "sebepsiz" }),
    ).toThrow(/CHECK constraint failed/i);
    // "reason yok + message yok" = ÖLÇÜLDÜ → SERBEST (005'in getirdiği düzeltme).
    expect(() => rawMetricInsert(t, { ...d(3), id: "fix-bos-bos" })).not.toThrow();
    // "ikisi de var" → SERBEST.
    expect(() =>
      rawMetricInsert(t, {
        ...d(4),
        id: "fix-dolu-dolu",
        unavailable_reason: "not_public",
        unavailable_message: "TikTok SELF_ONLY",
      }),
    ).not.toThrow();
    // Boşluktan ibaret mesaj → YASAK. Bu kısıt 004'te de doğruydu, 005 korudu.
    expect(() =>
      rawMetricInsert(t, {
        ...d(4),
        id: "fix-bos-mesaj",
        unavailable_reason: "deleted",
        unavailable_message: "  ",
      }),
    ).toThrow(/CHECK constraint failed/i);

    expect(countMetrics(t)).toBe(2);
  });

  it("okuma tarafı `unavailable: null` DOĞRU döndürüyor", () => {
    tmp = openTempDb();
    const t = tmp;
    const { project, account } = seed(t.repos);
    const a = mkJob(t, project.id, account.id, { key: "fix-c.mp4" });
    putMetric(t, {
      jobId: a.jobId,
      contentId: a.contentId,
      metricDate: "2026-03-01",
      metrics: { views: 5 },
    });
    putMetric(t, {
      jobId: a.jobId,
      contentId: a.contentId,
      metricDate: "2026-03-02",
      metrics: { views: 7 },
      unavailable: { reason: "not_public", message: "gizli", logId: "log-1" },
    });

    const olculen = t.repos.metrics.getByJobAndDate(a.jobId, "2026-03-01");
    expect(olculen?.unavailable).toBeNull();
    expect(olculen?.metrics["views"]).toBe(5);

    const olculemeyen = t.repos.metrics.getByJobAndDate(a.jobId, "2026-03-02");
    expect(olculemeyen?.unavailable?.reason).toBe("not_public");
    expect(olculemeyen?.unavailable?.logId).toBe("log-1");

    // İki durum ayırt edilebilir: "ölçüldü" satırı artık veritabanında var.
    const say = t.db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM content_metrics WHERE unavailable_reason IS NULL",
      )
      .get();
    expect(say?.n).toBe(1);
  });
});

// ── NOT 2 (düzeltme yapılmadı: `src/db/**` ve `migrations/**` korumalı) ────
//
// `metric_date TEXT CHECK (metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`
// yalnız BİÇİM denetler; `2026-13-45` gibi GERÇEKTE OLMAYAN günler GLOB'tan
// geçer ve leksikografik sıralamada "tarih" gibi görünür. Uygulama katmanı
// `isMetricDate` ile reddettiği için TEK YAZMA YOLUNDA (`MetricsRepo.upsert`)
// kural ihlal edilemiyor; açık şema ihlali yalnız ham SQL ile mümkün. Test,
// uygulama katmanının reddini kilitler ("upsert girdi doğrulaması").
//
// DÜZELTME ÖNERİSİ (migrasyon 004'te `INSERT OR REPLACE` değil, yeni bir
// migration gerekir; 004 zaten uygulanmış veritabanlarında checksum tutarlılığı
// bozulur):
//     unavailable_message TEXT
//       CHECK (unavailable_message IS NULL
//              OR TRIM(unavailable_message) <> '')
// Bu tek satır, 004'ün yorumundaki "ikisi de var / ikisi de yok → serbst" ve
// "reason var + message yok → yasak" kurallarının ikisini de birden düzeltir:
//  * NULL mesaj artık serbest (ölçülen satır yazılabilir),
//  * 004:96/:97 çift yönlü CHECK'ler gerçekten anlam kazanır.
// `migrations/**` korumalı olduğu için DOKUNULMADI; yukarıdaki "BULGU" bloğu
// düzeltme yapılana kadar hatayı kilitli tutar.
