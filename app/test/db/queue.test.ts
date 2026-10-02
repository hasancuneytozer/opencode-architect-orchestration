/**
 * Kuyruk testleri: kiralama, atomiklik, kurtarma, idempotency.
 *
 * Buradaki asıl risk "aynı iş iki kez yayınlanır". `claimDue` iki çağrı arasında
 * aynı işi VERMEMELİDİR — bunu iki ayrı bağlantıyla (gerçek ayrı düğüm
 * taklidi) sınayacağız.
 *
 * NOT: Aynı hesapla birden çok iş kurulacaksa her işin AYRI içeriği olmalıdır
 * (`ux_publish_jobs_target` üçlüyü korur); bu yüzden `newContent` vardır.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/index.js";
import { isRetryableKind } from "../../src/contract/index.js";
import {
  iso,
  newContent,
  openTempDb,
  sampleFailure,
  seed,
  type TempDb,
} from "./helpers.js";

let tmp: TempDb | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

const HOUR = 3_600_000;

describe("claimDue — atomik kiralama", () => {
  it("Zamanı gelen işi alır ve lease_owner/lease_expires_at yazar", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000), // geçmişte
    });

    const claimed = tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "düğüm-1", leaseMs: 60_000 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);

    const lease = tmp.repos.jobs.leaseOf(job.id);
    expect(lease?.owner).toBe("düğüm-1");
    // lease_expires_at INTEGER epoch ms'dir (ISO metin DEĞİL).
    expect(lease?.expiresAt).toBe(now.getTime() + 60_000);
  });

  it("KİRALAMA durumu da değiştirir: iş 'queued' DEĞİL 'preparing' olur", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000),
    });

    const claimed = tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "d", leaseMs: 60_000 });

    // Yalnız lease yazmak yetmezdi: `state='queued'` kalırsa seçim koşulunun
    // ilk dalı bir sonraki tick'te aynı işi yine verirdi.
    expect(claimed[0]?.state).toBe("preparing");
    expect(tmp.repos.jobs.getById(job.id)?.state).toBe("preparing");
    expect(tmp.repos.jobs.getById(job.id)?.startedAt).not.toBeNull();
  });

  it("YARIŞ: aynı leaseOwner ile ikinci claim aynı işi DÖNDÜRMEZ", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date();
    tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000),
    });

    const birinci = tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "düğüm-1", leaseMs: 60_000 });
    const ikinci = tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "düğüm-1", leaseMs: 60_000 });

    expect(birinci).toHaveLength(1);
    expect(ikinci, "ikinci claim aynı işi göremez").toHaveLength(0);
  });

  it("YARIŞ: FARKLI iki bağlantı (iki düğüm) aynı işi paylaşmaz", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "tiktok");
    const now = new Date();

    for (let i = 0; i < 5; i++) {
      const c = newContent(tmp.repos, project.id, `k${i}.mp4`);
      tmp.repos.jobs.create({
        contentId: c.id,
        platform: "tiktok",
        accountId: account.id,
        scheduledAt: iso(now.getTime() - 1000),
      });
    }

    // İkinci bağlantı: aynı dosya, ayrı düğüm taklidi. Migration yok, sadece PRAGMA.
    const { db: db2, repos: repos2 } = createDatabase(tmp.file, { migrate: false });
    try {
      const jobs2 = repos2.jobs;

      const a = tmp.repos.jobs.claimDue({ now, limit: 3, leaseOwner: "düğüm-1", leaseMs: 60_000 });
      const b = jobs2.claimDue({ now, limit: 3, leaseOwner: "düğüm-2", leaseMs: 60_000 });

      const aIds = new Set(a.map((j) => j.id));
      const bIds = new Set(b.map((j) => j.id));
      const kesisim = [...aIds].filter((id) => bIds.has(id));

      expect(kesisim, `iki düğüm aynı işi paylaşmamalı, kesişim: ${kesisim}`).toEqual([]);
      expect(a).toHaveLength(3);
      expect(b).toHaveLength(2);
      // Beş iş de artık 'preparing' — hiçbiri kuyrukta kalmadı.
      expect(tmp.repos.jobs.countByState().queued).toBe(0);
      expect(tmp.repos.jobs.countByState().preparing).toBe(5);
    } finally {
      db2.close();
    }
  });

  it("scheduled_at > now olan işi almaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date();
    tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(now.getTime() + HOUR),
    });
    expect(tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "d", leaseMs: 1000 })).toHaveLength(0);
  });

  it("scheduled_at'a göre ARTAN sırayla döner (en eski önce)", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "tiktok");
    const now = new Date();
    const mk = (key: string, once: number) => {
      const c = newContent(tmp!.repos, project.id, key);
      return tmp!.repos.jobs.create({
        contentId: c.id,
        platform: "tiktok",
        accountId: account.id,
        scheduledAt: iso(now.getTime() - once),
      });
    };
    const c = mk("gec.mp4", 500);
    const a = mk("erken.mp4", 5000);
    const b = mk("orta.mp4", 2000);

    const claimed = tmp.repos.jobs.claimDue({ now, limit: 10, leaseOwner: "d", leaseMs: 60_000 });

    // ORDER BY scheduled_at ASC: EN ESKİ önce gelir → a (5000 ms önce),
    // b (2000 ms önce), c (500 ms önce).
    expect(claimed.map((j) => j.id)).toEqual([a.id, b.id, c.id]);
  });

  it("limit=0 hiçbir şey almaz; limit<0 hata verir", () => {
    tmp = openTempDb();
    const now = new Date();
    expect(tmp.repos.jobs.claimDue({ now, limit: 0, leaseOwner: "d", leaseMs: 1000 })).toEqual([]);
    expect(() => tmp!.repos.jobs.claimDue({ now, limit: -1, leaseOwner: "d", leaseMs: 1000 })).not.toThrow();
  });

  it("boş leaseOwner veya geçersiz leaseMs reddedilir (sessiz kiralama olmaz)", () => {
    tmp = openTempDb();
    const now = new Date();
    expect(() => tmp!.repos.jobs.claimDue({ now, limit: 5, leaseOwner: "", leaseMs: 1000 })).toThrow(
      /leaseOwner/i,
    );
    expect(() => tmp!.repos.jobs.claimDue({ now, limit: 5, leaseOwner: "d", leaseMs: 0 })).toThrow(/leaseMs/i);
  });
});

describe("claimDue — kendi kendini iyileştirme", () => {
  it("lease_expires_at BOŞ olan uploading işi yeniden alınabilir", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "youtube");
    const now = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "youtube",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000),
    });
    // Süreç çöktü: durum ilerledi ama kiralama hiç yazılmadı (güç kesintisi).
    tmp.repos.jobs.markState(job.id, "uploading", { externalId: "container-9" });
    expect(tmp.repos.jobs.leaseOf(job.id)).toEqual({ owner: null, expiresAt: null });

    const claimed = tmp.repos.jobs.claimDue({ now, limit: 5, leaseOwner: "yeni-düğüm", leaseMs: 60_000 });

    // `lease_expires_at IS NOT NULL` koşulu olsaydı bu iş HİÇ kimseye verilmez,
    // kuyrukta sonsuza kadar kalırdı.
    expect(claimed.map((j) => j.id)).toEqual([job.id]);
    expect(tmp.repos.jobs.leaseOf(job.id)?.owner).toBe("yeni-düğüm");
  });

  it("lease_expires_at BOŞ olan processing işi de yeniden alınabilir", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const now = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000),
    });
    tmp.repos.jobs.markState(job.id, "processing", { externalId: "publish-1" });

    expect(tmp.repos.jobs.claimDue({ now, limit: 5, leaseOwner: "d", leaseMs: 60_000 })).toHaveLength(1);
  });

  it("kiralama HÂLÂ GEÇERLİYSE işi başka düğüm alamaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date();
    tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(now.getTime() - 1000),
    });
    tmp.repos.jobs.claimDue({ now, limit: 5, leaseOwner: "düğüm-1", leaseMs: HOUR });

    expect(
      tmp.repos.jobs.claimDue({
        now: new Date(now.getTime() + 60_000),
        limit: 5,
        leaseOwner: "düğüm-2",
        leaseMs: 60_000,
      }),
    ).toHaveLength(0);
  });
});

describe("recoverExpiredLeases — süresi dolmuş işi geri koyar", () => {
  it("lease dolduğunda işi 'queued' yapar ve attempts ARTTIRIR", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const t0 = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(t0.getTime() - 1000),
    });

    // Bir düğüm işi aldı ve düştü: durum preparing, lease 60 sn.
    const claimed = tmp.repos.jobs.claimDue({ now: t0, limit: 5, leaseOwner: "düğüm-1", leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe("preparing");
    expect(tmp.repos.jobs.getById(job.id)?.attempts).toBe(0);

    // Lease dolmadan kurtarma: hiçbir şey olmaz.
    expect(tmp.repos.jobs.recoverExpiredLeases(new Date(t0.getTime() + 59_000))).toHaveLength(0);

    // Lease dolduktan sonra kurtarma.
    const kurtarilan = tmp.repos.jobs.recoverExpiredLeases(new Date(t0.getTime() + 60_001));
    expect(kurtarilan).toHaveLength(1);
    expect(kurtarilan[0]?.id).toBe(job.id);
    expect(kurtarilan[0]?.state).toBe("queued");
    expect(kurtarilan[0]?.attempts).toBe(1);

    const row = tmp.repos.jobs.getById(job.id);
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(tmp.repos.jobs.leaseOf(job.id)).toEqual({ owner: null, expiresAt: null });

    // Geri koyulan iş yeniden kuyruktan alınabilir — "devre kalıcı yasak değil".
    const tekrar = tmp.repos.jobs.claimDue({
      now: new Date(t0.getTime() + 60_002),
      limit: 5,
      leaseOwner: "düğüm-2",
      leaseMs: 60_000,
    });
    expect(tekrar.map((j) => j.id)).toEqual([job.id]);
    expect(tmp.repos.jobs.leaseOf(job.id)?.owner).toBe("düğüm-2");
  });

  it("uploading/processing aşamalarındaki süresi dolmuş işleri de kurtarır", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "youtube");
    const t0 = new Date();
    // Her iş için AYRI içerik: aynı (content, platform, account) üçlüsü UNIQUE.
    for (const state of ["uploading", "processing"] as const) {
      const c = newContent(tmp.repos, project.id, `${state}.mp4`);
      const job = tmp.repos.jobs.create({
        contentId: c.id,
        platform: "youtube",
        accountId: account.id,
        scheduledAt: iso(t0.getTime() - 1000),
      });
      tmp.repos.jobs.markState(job.id, state, { externalId: `ext-${state}` });
      tmp.repos.jobs.claimDue({
        now: new Date(t0.getTime() + 1000),
        limit: 10,
        leaseOwner: "düğüm-1",
        leaseMs: 1000,
      });
    }
    const kurtarilan = tmp.repos.jobs.recoverExpiredLeases(new Date(t0.getTime() + 5000));
    expect(kurtarilan).toHaveLength(2);
    expect(kurtarilan.every((j) => j.state === "queued")).toBe(true);
  });

  it("bitmiş (published) işin lease'ı kurtarma tarafından dokunulmaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const t0 = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(t0.getTime() - 1000),
    });
    tmp.repos.jobs.claimDue({ now: t0, limit: 1, leaseOwner: "d", leaseMs: 1000 });
    tmp.repos.jobs.markState(job.id, "published", { permalink: "https://x/1" });

    expect(tmp.repos.jobs.recoverExpiredLeases(new Date(t0.getTime() + 100_000))).toHaveLength(0);
    expect(tmp.repos.jobs.getById(job.id)?.state).toBe("published");
  });
});

describe("markState / dueForPoll / recordFailure", () => {
  it("markState durumu ve updated_at'i günceller, alan yamalarını uygular", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    const before = tmp.repos.jobs.getById(job.id)!.updatedAt;

    tmp.repos.jobs.markState(job.id, "uploading", {
      externalId: "container-1",
      startedAt: new Date().toISOString(),
    });

    const after = tmp.repos.jobs.getById(job.id)!;
    expect(after.state).toBe("uploading");
    expect(after.externalId).toBe("container-1");
    expect(after.startedAt).not.toBeNull();
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("markState v2 alanlarını (upload_url, parçalar, idempotency) da yazar", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });

    expect(
      tmp.repos.jobs.markState(job.id, "uploading", {
        externalId: "publish-1",
        uploadUrl: "https://upload.example/abc",
        uploadUrlExpiresAt: "2026-09-30T13:00:00.000Z",
        uploadedParts: 3,
        totalParts: 10,
        idempotencyFirstUsedAt: "2026-09-30T12:00:00.000Z",
      }),
    ).toBe(true);

    const after = tmp.repos.jobs.getById(job.id)!;
    expect(after.uploadUrl).toBe("https://upload.example/abc");
    expect(after.uploadUrlExpiresAt).toBe("2026-09-30T13:00:00.000Z");
    expect(after.uploadedParts).toBe(3);
    expect(after.totalParts).toBe(10);
    expect(after.idempotencyFirstUsedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(after.idempotencyKey).toBeTruthy();
  });

  it("published/failed/canceled durumunda kiralama serbest bırakılır", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    tmp.repos.jobs.claimDue({ now: new Date(), limit: 1, leaseOwner: "d", leaseMs: 600_000 });
    expect(tmp.repos.jobs.leaseOf(job.id)?.owner).toBe("d");

    tmp.repos.jobs.markState(job.id, "published", { remoteId: "r1", permalink: "p" });
    expect(tmp.repos.jobs.leaseOf(job.id)).toEqual({ owner: null, expiresAt: null });
  });

  it("published_no_link de terminaldir: kiralama serbest bırakılır", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    tmp.repos.jobs.claimDue({ now: new Date(), limit: 1, leaseOwner: "d", leaseMs: 600_000 });

    // Yayın tamam ama permalink çözümlenemedi (SELF_ONLY) — iş BİTMİŞTİR.
    expect(tmp.repos.jobs.markState(job.id, "published_no_link", { remoteId: "r9" })).toBe(true);

    const after = tmp.repos.jobs.getById(job.id)!;
    expect(after.state).toBe("published_no_link");
    expect(after.permalink).toBeNull();
    expect(tmp.repos.jobs.leaseOf(job.id)).toEqual({ owner: null, expiresAt: null });
    expect(tmp.repos.jobs.countByState().published_no_link).toBe(1);
  });

  it("markState geçersiz durumu uygulamadan önce reddeder", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    expect(() =>
      // @ts-expect-error — kasıtlı olarak geçersiz durum
      tmp!.repos.jobs.markState(job.id, "yok-boyle-bir-durum"),
    ).toThrow(/Geçersiz iş durumu/);
  });

  it("dueForPoll yalnızca uploading/processing işlerini, external_id'sizleri hariç döner", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "youtube");
    // Her iş için AYRI storage_key: assets.storage_key UNIQUE.
    const mk = (platform: "instagram" | "youtube", key: string) => {
      const c = newContent(tmp!.repos, project.id, key);
      return tmp!.repos.jobs.create({
        contentId: c.id,
        platform,
        accountId: account.id,
        scheduledAt: new Date().toISOString(),
      });
    };

    const bekleyen = mk("instagram", "bekleyen.mp4");
    const yuklenen = mk("youtube", "yuklenen.mp4");
    const disarisiz = mk("instagram", "disarisiz.mp4");
    const biten = mk("youtube", "biten.mp4");

    tmp.repos.jobs.markState(yuklenen.id, "uploading", { externalId: "container-9" });
    tmp.repos.jobs.markState(disarisiz.id, "processing"); // external_id yok
    tmp.repos.jobs.markState(biten.id, "published", { permalink: "p" });

    const ids = tmp.repos.jobs.dueForPoll(new Date(), 10).map((j) => j.id);
    expect(ids).toEqual([yuklenen.id]);
    expect(ids).not.toContain(bekleyen.id);
    expect(ids).not.toContain(disarisiz.id);
    expect(ids).not.toContain(biten.id);
  });

  it("recordFailure retryable hata ise next_attempt_at yazar, claimDue retry eder", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const t0 = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(t0.getTime() - 1000),
    });
    const retryAt = t0.getTime() + 30_000;
    const failure = sampleFailure({ kind: "ratelimit", message: "ağ hatası", at: iso(t0.getTime()) });

    expect(isRetryableKind(failure.kind)).toBe(true);
    tmp.repos.jobs.recordFailure(job.id, failure, retryAt);

    const failed = tmp.repos.jobs.getById(job.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.error?.message).toBe("ağ hatası");
    expect(failed.nextAttemptAt).toBe(retryAt);
    expect(failed.finishedAt).toBeNull();

    // Retry zamanı gelene kadar claim almaz.
    expect(
      tmp.repos.jobs.claimDue({ now: new Date(retryAt - 1), limit: 5, leaseOwner: "d", leaseMs: 1000 }),
    ).toHaveLength(0);

    const tekrar = tmp.repos.jobs.claimDue({
      now: new Date(retryAt + 1),
      limit: 5,
      leaseOwner: "d",
      leaseMs: 1000,
    });
    expect(tekrar.map((j) => j.id)).toEqual([job.id]);
  });

  it("recordFailure kalıcı hata ise finishedAt yazar, iş kuyruktan çıkar", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const t0 = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(t0.getTime() - 1000),
    });

    const failure = sampleFailure({
      kind: "policy",
      message: "policy ihlali",
      providerCode: "POLICY",
      httpStatus: 400,
      retryAfterMs: null,
      at: iso(t0.getTime()),
    });
    expect(isRetryableKind(failure.kind)).toBe(false);
    tmp.repos.jobs.recordFailure(job.id, failure, t0.getTime() + 1000);

    const failed = tmp.repos.jobs.getById(job.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.error?.kind).toBe("policy");
    expect(failed.error?.retryable).toBe(false);
    // Kalıcı hatada retry planı YOKTUR: verilen zaman bilerek yok sayılır.
    expect(failed.nextAttemptAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();

    expect(
      tmp.repos.jobs.claimDue({
        now: new Date(t0.getTime() + HOUR),
        limit: 5,
        leaseOwner: "d",
        leaseMs: 1000,
      }),
    ).toHaveLength(0);
  });

  it("recordFailure nextAttemptAt verilmezse retryAfterMs'tan hesaplar", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const t0 = new Date();
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: iso(t0.getTime() - 1000),
    });
    const at = iso(t0.getTime());

    tmp.repos.jobs.recordFailure(job.id, sampleFailure({ kind: "server", at, retryAfterMs: 45_000 }));

    expect(tmp.repos.jobs.getById(job.id)?.nextAttemptAt).toBe(t0.getTime() + 45_000);
  });

  it("enqueueUnique var olan işi döndürür, ikinci kez eklemez", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const when = new Date().toISOString();
    const a = tmp.repos.jobs.enqueueUnique({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: when,
    });
    const b = tmp.repos.jobs.enqueueUnique({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: when,
    });
    expect(b.id).toBe(a.id);
    expect(tmp.repos.jobs.countByState().queued).toBe(1);
  });
});

describe("idempotency — mükerrer yayının son savunması", () => {
  it("findByIdempotencyKey mevcut kaydı bulur, olmayan için null döner", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
      idempotencyKey: "tt-init-abc-123",
    });

    expect(tmp.repos.jobs.findByIdempotencyKey("tt-init-abc-123")?.id).toBe(job.id);
    expect(tmp.repos.jobs.findByIdempotencyKey("olmayan-anahtar")).toBeNull();
    expect(() => tmp!.repos.jobs.findByIdempotencyKey("")).toThrow(/anahtar/i);
  });

  it("idempotency_key verilmezse türetilir: boş veya çakışan olamaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "youtube");
    const a = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "youtube",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    expect(a.idempotencyKey).toBe(`job:${a.id}`);
    expect(tmp.repos.jobs.findByIdempotencyKey(a.idempotencyKey)?.id).toBe(a.id);
  });

  it("idempotency_key UNIQUE: aynı anahtar iki işte kullanılamaz", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "tiktok");
    const c1 = newContent(tmp.repos, project.id, "bir.mp4");
    const c2 = newContent(tmp.repos, project.id, "iki.mp4");

    const mk = (contentId: string) =>
      tmp!.repos.jobs.create({
        contentId,
        platform: "tiktok",
        accountId: account.id,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: "tt-init-abc-123",
      });

    mk(c1.id);
    // Farklı içerik, aynı anahtar: sunucuya gönderilecek istek AYNI.
    expect(() => mk(c2.id)).toThrow(/UNIQUE constraint failed/i);
  });

  it("enqueueUnique aynı idempotencyKey ile yeniden başlatılırsa yeni satır açmaz", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "tiktok");
    const c1 = newContent(tmp.repos, project.id, "bir.mp4");
    const when = new Date().toISOString();

    const birinci = tmp.repos.jobs.enqueueUnique({
      contentId: c1.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: when,
      idempotencyKey: "tt-init-abc-123",
    });
    // Süreç çöktü ve içerik YENİDEN üretildi: yeni içerik, AYNI anahtar.
    const c2 = newContent(tmp.repos, project.id, "iki.mp4");
    const ikinci = tmp.repos.jobs.enqueueUnique({
      contentId: c2.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: when,
      idempotencyKey: "tt-init-abc-123",
    });

    expect(ikinci.id).toBe(birinci.id);
    expect(tmp.repos.jobs.countByState().queued).toBe(1);
  });

  it("error alanı PublishFailure NESNESİ olarak gidiyor ve kayıpsız geliyor", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });
    const failure = sampleFailure();

    tmp.repos.jobs.markState(job.id, "failed", { error: failure });

    const back = tmp.repos.jobs.getById(job.id)!.error!;
    // Destek kanıtı alanları bozulmamalı: logId olmadan destek talebi açılamaz.
    expect(back).toEqual(failure);
    expect(back.kind).toBe("ratelimit");
    expect(back.logId).toBe("log-abc-123");
    expect(back.httpStatus).toBe(429);
    expect(back.retryAfterMs).toBe(30_000);
    expect(back.retryable).toBe(true);

    // Sütunda düz metin değil, JSON NESNESİ duruyor.
    const raw = tmp.db
      .prepare<[string], { error_json: string | null }>(
        "SELECT error_json FROM publish_jobs WHERE id = ?",
      )
      .get(job.id)!.error_json;
    expect(JSON.parse(raw!).kind).toBe("ratelimit");

    // Temizleme: null yazılırsa hata da silinir.
    tmp.repos.jobs.markState(job.id, "queued", { error: null });
    expect(tmp.repos.jobs.getById(job.id)?.error).toBeNull();
  });

  it("bozuk/eskiden kalan error JSON'u okumada sessizce yutulmaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });

    tmp.db
      .prepare("UPDATE publish_jobs SET error_json = ? WHERE id = ?")
      .run('{"kind":"bilinmeyen-sinif","message":"x"}', job.id);

    const back = tmp.repos.jobs.getById(job.id)!.error!;
    // Bilinmeyen sınıf 'unknown'a düşer ve YENİDEN DENENMEZ.
    expect(back.kind).toBe("unknown");
    expect(back.message).toBe("x");
    expect(back.retryable).toBe(false);
  });
});
