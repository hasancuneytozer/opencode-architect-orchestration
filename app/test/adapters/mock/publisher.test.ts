/**
 * Sahte yayıncı testleri.
 *
 * Burada kanıtlanan iki şey var:
 *   1) `idempotencyKey` → aynı `externalId`: AYNI ANAHTARLA İKİNCİ
 *      `startPublish` YENİ İŞ AÇMAZ. Bu, motordaki mükerrer yayın
 *      savunmasının sağlayıcı tarafındaki karşılığıdır.
 *   2) Hata sınıfı `isRetryableKind`'ten türetilir: adaptör "geçici" bir
 *      hatayı kalıcı sınıfa atmaz.
 */
import { describe, expect, it } from "vitest";
import type { Platform } from "../../../src/contract/index.js";
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PublishInput,
  ResolvedCopy,
} from "../../../src/ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../../../src/ports/index.js";
import { MockPublishAdapter, mockExternalId } from "../../../src/adapters/mock/publisher.js";
import { mockAdapter, mockAdapters } from "../../../src/adapters/mock/index.js";
import { getSpec } from "../../../src/media/index.js";

const ACCOUNT: AccountRef = {
  id: "acc-1",
  platform: "instagram",
  externalId: "ig-user-77",
  accessToken: "token",
  refreshToken: null,
  tokenExpiresAt: null,
};

const MEDIA: MediaRef = {
  storageKey: "klasor/klip.mp4",
  bytes: 1_000,
  mimeType: "video/mp4",
  info: {
    path: "klasor/klip.mp4",
    bytes: 1_000,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 12,
    bitrate: 4_000_000,
    hasAudio: true,
  },
  coverKey: "klasor/kapak.jpg",
  publicUrl: null,
};

const COPY: ResolvedCopy = {
  caption: "merhaba",
  hashtags: ["test"],
  title: null,
  description: null,
  tags: [],
  privacy: "public",
  coverAtPercent: 35,
  aiGenerated: true,
  selfDeclaredMadeForKids: false,
  madeForShorts: true,
};

function makeInput(over: Partial<PublishInput> = {}): PublishInput {
  return {
    jobId: "job-1",
    idempotencyKey: "job:1",
    account: ACCOUNT,
    media: MEDIA,
    copy: COPY,
    scheduledAt: null,
    coverBytes: Buffer.from("kapak-jpeg"),
    ...over,
  };
}

function pollContext(externalId: string | null, over: Partial<PollContext> = {}): PollContext {
  return {
    account: ACCOUNT,
    externalId,
    uploadUrl: null,
    uploadUrlExpiresAt: null,
    uploadedParts: 0,
    totalParts: null,
    scheduledAt: null,
    ...over,
  };
}

/** Reddedilen çağrının hatasını döner (union tiplemesi için tek nokta). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("beklenen hata oluşmadı: çağrı çözüldü");
}

describe("MockPublishAdapter — kimlik ve mükerrer yayın koruması", () => {
  it("externalId idempotencyKey'den deterministik türetilir", () => {
    const adapter = new MockPublishAdapter("tiktok");
    expect(mockExternalId("tiktok", "abc")).toBe(mockExternalId("tiktok", "abc"));
    expect(mockExternalId("tiktok", "abc")).not.toBe(mockExternalId("tiktok", "abd"));
    expect(mockExternalId("tiktok", "abc")).not.toBe(mockExternalId("youtube", "abc"));
    expect(adapter.platform).toBe("tiktok");
  });

  it("aynı idempotencyKey ile ikinci startPublish YENİ KİMLİK ÜRETMEZ", async () => {
    const adapter = new MockPublishAdapter("instagram");
    const input = makeInput({ idempotencyKey: "job:mukerrer" });

    const first = await adapter.startPublish(input);
    const second = await adapter.startPublish(input);

    expect(first.kind).toBe("pending");
    expect(second).toEqual(first);
    if (first.kind === "pending" && second.kind === "pending") {
      expect(second.externalId).toBe(first.externalId);
    }
    // Dünyada tek kayıt var: ikinci çağrı yeni bir iş AÇMADI.
    expect(adapter.world()).toHaveLength(1);
    expect(adapter.recordByKey("job:mukerrer")?.startCalls).toBe(2);
    expect(adapter.callCounts().start).toBe(2);
  });

  it("farklı idempotencyKey farklı yayın açar", async () => {
    const adapter = new MockPublishAdapter("instagram");
    const a = await adapter.startPublish(makeInput({ idempotencyKey: "job:a" }));
    const b = await adapter.startPublish(makeInput({ idempotencyKey: "job:b" }));

    expect(adapter.world()).toHaveLength(2);
    if (a.kind === "pending" && b.kind === "pending") {
      expect(a.externalId).not.toBe(b.externalId);
    }
  });

  it("reset() dünyayı ve sayaçları sıfırlar (test izolasyonu)", async () => {
    const adapter = new MockPublishAdapter("instagram");
    await adapter.startPublish(makeInput({ idempotencyKey: "job:x" }));
    expect(adapter.world()).toHaveLength(1);

    adapter.reset();
    expect(adapter.world()).toHaveLength(0);
    expect(adapter.recordByKey("job:x")).toBeNull();
    expect(adapter.callCounts().start).toBe(0);
  });
});

describe("MockPublishAdapter — hata sınıflandırma", () => {
  it("failFirstN kadar denemede RetryablePublishError fırlatır, sonra başarılı olur", async () => {
    const adapter = new MockPublishAdapter("tiktok", { failFirstN: 2, failKind: "ratelimit" });
    const input = makeInput({ idempotencyKey: "job:retry" });

    await expect(adapter.startPublish(input)).rejects.toBeInstanceOf(RetryablePublishError);
    await expect(adapter.startPublish(input)).rejects.toBeInstanceOf(RetryablePublishError);

    expect((await adapter.startPublish(input)).kind).toBe("pending");
    // Hatalı denemeler dünyaya KAYIT AÇMADI: hatalı deneme bir yayın değildir.
    expect(adapter.world()).toHaveLength(1);
  });

  it("kalıcı sınıflar PermanentPublishError fırlatır", async () => {
    for (const kind of ["validation", "auth", "policy", "quota", "media_rejected"] as const) {
      const adapter = new MockPublishAdapter("instagram", { failFirstN: 1, failKind: kind });
      const err = (await rejection(adapter.startPublish(makeInput()))) as PermanentPublishError;
      expect(err, `${kind} kalıcı olmalı`).toBeInstanceOf(PermanentPublishError);
      expect(err.kind).toBe(kind);
    }
  });

  it("geçici sınıflar RetryablePublishError fırlatır", async () => {
    for (const kind of ["network", "ratelimit", "server", "transient"] as const) {
      const adapter = new MockPublishAdapter("youtube", { failFirstN: 1, failKind: kind });
      const err = (await rejection(adapter.startPublish(makeInput()))) as RetryablePublishError;
      expect(err, `${kind} geçici olmalı`).toBeInstanceOf(RetryablePublishError);
      expect(err.kind).toBe(kind);
    }
  });

  it("sağlayıcı kodu ve log id hataya taşınır (destek kanıtı kaybolmaz)", async () => {
    const adapter = new MockPublishAdapter("tiktok", {
      failFirstN: 1,
      failKind: "server",
      failProviderCode: "internal",
    });
    const err = (await rejection(adapter.startPublish(makeInput()))) as RetryablePublishError;
    expect(err.providerCode).toBe("internal");
    expect(err.logId).toMatch(/^log-mock-/);
  });
});

describe("MockPublishAdapter — StartResult dalları", () => {
  it("uploadUrl dalı: adres ve geçerlilik süresi döner", async () => {
    const now = 1_760_000_000_000;
    const adapter = new MockPublishAdapter("tiktok", { uploadUrlTtlSec: 3600 }, { now: () => now });
    const result = await adapter.startPublish(makeInput());

    expect(result.kind).toBe("uploadUrl");
    if (result.kind === "uploadUrl") {
      expect(result.uploadUrl).toMatch(/example\.invalid/);
      expect(Date.parse(result.expiresAt)).toBe(now + 3_600_000);
    }
  });

  it("scheduled dalı: sağlayıcıya bırakıldı", async () => {
    const adapter = new MockPublishAdapter("youtube", { returnScheduled: true });
    const result = await adapter.startPublish(makeInput());
    expect(result.kind).toBe("scheduled");
    expect(adapter.recordByKey("job:1")?.status).toBe("scheduled");
  });

  it("immediate dalı: yayın bitti, permalink geldi", async () => {
    const adapter = new MockPublishAdapter("youtube", { startResult: "immediate" });
    const result = await adapter.startPublish(makeInput());
    expect(result.kind).toBe("immediate");
    if (result.kind === "immediate") {
      expect(result.remoteId).toMatch(/^mock_/);
      expect(result.permalink).toMatch(/^https:\/\/example\.invalid\/youtube\/mock_/);
    }
  });

  it("kapak baytları belleğe yazılır; sıfır bayt reddedilir, null kabul edilir", async () => {
    const adapter = new MockPublishAdapter("instagram");
    await adapter.startPublish(makeInput());
    expect(adapter.recordByKey("job:1")?.coverBytes).toBeGreaterThan(0);

    const empty = new MockPublishAdapter("instagram");
    await expect(empty.startPublish(makeInput({ coverBytes: Buffer.alloc(0) }))).rejects.toThrow(
      PermanentPublishError,
    );

    // null kapak: adaptör kapak ZORUNLU KILMAZ.
    const noCover = new MockPublishAdapter("instagram");
    expect((await noCover.startPublish(makeInput({ coverBytes: null }))).kind).toBe("pending");
    expect(noCover.recordByKey("job:1")?.coverBytes).toBe(0);
  });
});

describe("MockPublishAdapter — yoklama", () => {
  async function opened(platform: Platform, script = {}) {
    const adapter = new MockPublishAdapter(platform, script);
    const input = makeInput({ idempotencyKey: "job:poll" });
    const result = await adapter.startPublish(input);
    const externalId =
      result.kind === "pending" || result.kind === "uploadUrl" ? result.externalId : "mock_x";
    return { adapter, externalId };
  }

  it("bilinmeyen yayın kimliğinde kalıcı hata (validation) verir", async () => {
    const adapter = new MockPublishAdapter("instagram");
    const err = (await rejection(
      adapter.pollPublish(pollContext("olmayan-kimlik")),
    )) as PermanentPublishError;

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(err.kind).toBe("validation");
    expect(err.message).toMatch(/bilinmeyen yayın kimliği/i);
  });

  it("null externalId de kalıcı hata verir", async () => {
    const adapter = new MockPublishAdapter("instagram");
    await expect(adapter.pollPublish(pollContext(null))).rejects.toThrow(PermanentPublishError);
  });

  it("processingPolls dolana kadar processing, sonra published + sahte permalink", async () => {
    const { adapter, externalId } = await opened("instagram", { processingPolls: 2 });
    const ctx = pollContext(externalId);

    const first = await adapter.pollPublish(ctx);
    expect(first.state).toBe("processing");
    expect(first.retryAfterMs).toBe(50);

    expect((await adapter.pollPublish(ctx)).state).toBe("processing");

    const last = await adapter.pollPublish(ctx);
    expect(last.state).toBe("published");
    expect(last.permalink).toBe(`https://example.invalid/instagram/${externalId}`);
    expect(adapter.record(externalId)?.pollCount).toBe(3);
  });

  it("permalink istenmezse null döner (TikTok SELF_ONLY)", async () => {
    const { adapter, externalId } = await opened("tiktok", { omitPermalink: true });
    const result = await adapter.pollPublish(pollContext(externalId));
    expect(result.state).toBe("published");
    expect(result.permalink).toBeNull();
  });

  it("süresi dolmuş yükleme adresi container_expired verir", async () => {
    const now = 2_000_000_000_000;
    const adapter = new MockPublishAdapter("tiktok", { uploadUrlTtlSec: 60 }, { now: () => now });
    const result = await adapter.startPublish(makeInput({ idempotencyKey: "job:exp" }));

    expect(result.kind).toBe("uploadUrl");
    const externalId = result.kind === "uploadUrl" ? result.externalId : null;
    const err = (await rejection(
      adapter.pollPublish(pollContext(externalId, { uploadUrlExpiresAt: new Date(now - 1000).toISOString() })),
    )) as PermanentPublishError;

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(err.kind).toBe("container_expired");
    expect(adapter.record(externalId ?? "")?.status).toBe("failed");
  });

  it("yerel zamanlama ikinci yoklamada tamamlanır", async () => {
    const adapter = new MockPublishAdapter("youtube", { returnScheduled: true });
    expect((await adapter.startPublish(makeInput({ idempotencyKey: "job:sched" }))).kind).toBe(
      "scheduled",
    );
    const ctx = pollContext(adapter.recordByKey("job:sched")?.externalId ?? null, {
      scheduledAt: "2026-10-01T10:00:00.000Z",
    });
    expect((await adapter.pollPublish(ctx)).state).toBe("processing");
    expect((await adapter.pollPublish(ctx)).state).toBe("published");
  });
});

describe("MockPublishAdapter — precheck ve kota", () => {
  it("bozuk media.info icin media_rejected HATA bulgusu uretir", async () => {
    const adapter = new MockPublishAdapter("instagram");
    const findings = await adapter.precheck(
      makeInput({ media: { ...MEDIA, info: { ...MEDIA.info, width: null, videoCodec: null } } }),
    );
    const error = findings.find((f) => f.code === "media_rejected");
    expect(error?.severity).toBe("error");
  });

  it("sağlam medya için bulgu üretmez", async () => {
    const adapter = new MockPublishAdapter("instagram");
    expect(await adapter.precheck(makeInput())).toEqual([]);
  });

  it("yarım yükleme için UYARI üretir (yayını durdurmaz)", async () => {
    const adapter = new MockPublishAdapter("instagram");
    const input = makeInput({ idempotencyKey: "job:parts" });
    const start = await adapter.startPublish(input);
    const externalId = start.kind === "pending" ? start.externalId : "";
    expect(adapter.setUploadProgress(externalId, 1, 3)).toBe(true);

    const warning = (await adapter.precheck(input)).find((f) => f.code === "upload_incomplete");
    expect(warning?.severity).toBe("warning");
    expect(warning?.limit).toBe("3");
  });

  it("kapak zorunluysa eksik kapak hatadır", async () => {
    const adapter = new MockPublishAdapter("instagram", { requireCover: true });
    const findings = await adapter.precheck(makeInput({ coverBytes: null }));
    expect(findings.some((f) => f.code === "cover_missing" && f.severity === "error")).toBe(true);
  });

  it("readQuota script'te varsa döner, yoksa null", async () => {
    const withQuota = new MockPublishAdapter("instagram", {
      quota: { used: 3, total: 10, windowSec: 3600 },
    });
    expect(await withQuota.readQuota(ACCOUNT)).toEqual({ used: 3, total: 10, windowSec: 3600 });

    const without = new MockPublishAdapter("instagram");
    expect(await without.readQuota(ACCOUNT)).toBeNull();
  });

  it("spec alanı gerçek platform spesifikasyonudur", () => {
    const adapter = new MockPublishAdapter("tiktok");
    expect(adapter.spec).toEqual(getSpec("tiktok"));
    expect(adapter.spec.platform).toBe("tiktok");
  });
});

describe("mockAdapter kısayolu", () => {
  it("tek adaptör üretir", () => {
    const adapter = mockAdapter("youtube", { processingPolls: 1 });
    expect(adapter).toBeInstanceOf(MockPublishAdapter);
    expect(adapter.platform).toBe("youtube");
  });

  it("mockAdapters verilmeyen platform için varsayılan senaryo kullanır", () => {
    const map = mockAdapters({ tiktok: { failFirstN: 1 } });
    expect([...map.keys()].sort()).toEqual(["instagram", "tiktok", "youtube"]);
    expect(map.get("tiktok")).toBeInstanceOf(MockPublishAdapter);
  });

  it("defaultScript null ise platform adaptörsüz kalır (motor 'adaptör yok' der)", () => {
    const map = mockAdapters({ youtube: null }, {}, {});
    expect(map.has("youtube")).toBe(true);
    const yoklu = mockAdapters({}, {}, null);
    expect(yoklu.size).toBe(0);
  });
});
