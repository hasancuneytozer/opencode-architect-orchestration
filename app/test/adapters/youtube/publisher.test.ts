/**
 * YouTube adaptörü testleri.
 *
 * HİÇBİR TEST AĞA ÇIKMAZ. `fetch` daima enjekte edilmiş sahte bir `fetch`
 * ile değiştirilir. Sahte taşıma, gerçek `Response` nesneleri üretir; böylece
 * istemcinin ayrıştırma/zaman aşımı/başlık toplama yolu da testte çalışır.
 *
 * Üç kanıt sütunu var:
 *   1) İSTEK DOĞRULUĞU — `uploadType`, `part`, `X-Upload-Content-*` başlıkları
 *      ve gövde alanları (status beyanları dahil) gönderilmiyor mu.
 *   2) HATA SINIFLANDIRMA — `mapYouTubeReason` tablosunun HER satırı doğru
 *      sınıfa düşüyor mu; `reason` yoksa `unknown` + kalıcı mı.
 *   3) YIKICI BİRLEŞTİRME — `videos.update` önce okuyor, birleştiriyor,
 *      sonra gönderiyor mu. Bu test gövde üzerinden kanıtlar.
 */
import { describe, expect, it } from "vitest";
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PublishInput,
  ResolvedCopy,
  UploadSession,
} from "../../../src/ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../../../src/ports/index.js";
import { isRetryableKind } from "../../../src/contract/index.js";
import type { Fetch } from "../../../src/adapters/youtube/http.js";
import {
  UNVERIFIED_PROJECT_MESSAGE,
  YouTubePublishAdapter,
  classifyHttpFailure,
  fitDescription,
  fitTitle,
  hasTitle,
  isPendingExternalId,
  mediaFingerprint,
  parseGoogleError,
  parseInstantMs,
  parseRangeHeader,
  pendingExternalId,
  readVideoView,
  youtubePermalink,
  YOUTUBE_CATEGORY_ID,
  YOUTUBE_DEFAULT_LANGUAGE,
  YOUTUBE_PENDING_PREFIX,
  YOUTUBE_PERMALINK_BASE,
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
  YOUTUBE_SCOPES,
  YOUTUBE_STATUS_WRITABLE_FIELDS,
  YOUTUBE_UPLOAD_PARTS,
  YOUTUBE_UPLOAD_QUERY,
} from "../../../src/adapters/youtube/publisher.js";
import { YouTubeAuth, requiredScopes } from "../../../src/adapters/youtube/auth.js";
import { isConfigured, missingConfigKeys } from "../../../src/adapters/youtube/index.js";
import {
  asPublishTransportError,
  createHttpClient,
  parseRetryAfterMs,
  normalizeHeaders,
  safeJsonParse,
} from "../../../src/adapters/youtube/http.js";
import { mapYouTubeReason } from "../../../src/domain/providerErrors.js";
import { getSpec } from "../../../src/media/index.js";

// ── Sabit zaman ve sahte taşıma ───────────────────────────────────────────

/** 2026-03-01T12:00:00Z — testler bu ana sabitlenir. */
const NOW_ISO = "2026-03-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Gövde ham metin olarak gönderilir (bozuk JSON testi için). */
  raw?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  rawBody: unknown;
}

/**
 * Sıraya göre yanıt döndüren sahte taşıma. Global ağ işlevine DOKUNMAZ —
 * hiçbir test gerçek ağa çıkmaz.
 */
function fakeTransport(responses: FakeResponse[]): { fn: Fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const headerRecord = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerRecord,
      body: typeof rawBody === "string" ? rawBody : null,
      rawBody,
    });
    const headers = new Headers(spec.headers ?? {});
    const body = spec.raw !== undefined ? spec.raw : spec.body === undefined ? "" : JSON.stringify(spec.body);
    return new Response(body, { status: spec.status ?? 200, headers });
  }) as unknown as Fetch;
  return { fn, calls };
}

/** Gövdeyi JSON olarak ayrıştırır (gönderilen isteği kanıtlamak için). */
function sentJson(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? "{}") as Record<string, unknown>;
}

// ── Girdi kurulumu ────────────────────────────────────────────────────────

const ACCOUNT: AccountRef = {
  id: "acc-yt-1",
  platform: "youtube",
  externalId: "UC1234567890",
  accessToken: "ya29.TOKEN",
  refreshToken: "1//refresh",
  tokenExpiresAt: null,
};

const MEDIA: MediaRef = {
  storageKey: "derived/youtube/asset-1.mp4",
  bytes: 1_048_576,
  mimeType: "video/mp4",
  info: {
    path: "derived/youtube/asset-1.mp4",
    bytes: 1_048_576,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 30,
    bitrate: 4_000_000,
    hasAudio: true,
  },
  coverKey: null,
  publicUrl: null,
};

const COPY: ResolvedCopy = {
  caption: "Ürün tanıtımı",
  hashtags: ["#kampanya"],
  title: "Yeni ürün",
  description: null,
  tags: ["tanitim"],
  privacy: "public",
  coverAtPercent: 35,
  aiGenerated: true,
  selfDeclaredMadeForKids: false,
  madeForShorts: true,
};

function makeInput(over: Partial<PublishInput> = {}): PublishInput {
  return {
    jobId: "job-yt-1",
    idempotencyKey: "yt:job-1",
    account: ACCOUNT,
    media: MEDIA,
    copy: COPY,
    scheduledAt: null,
    coverBytes: Buffer.from("kapak"),
    ...over,
  };
}

function pollContext(over: Partial<PollContext> = {}): PollContext {
  return {
    account: ACCOUNT,
    externalId: "VID12345678",
    uploadUrl: null,
    uploadUrlExpiresAt: null,
    uploadedParts: 0,
    totalParts: null,
    scheduledAt: null,
    ...over,
  };
}

/**
 * `uploadParts` çağrısı için oturum — motorun `publish_jobs`'tan okuyup
 * adaptöre geçirdiği sözleşmenin TAM kendisi.
 */
function uploadSession(over: Partial<UploadSession> = {}): UploadSession {
  return {
    uploadUrl: "https://upload.example/SESSION-1",
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    totalParts: null,
    uploadedParts: 0,
    // Motor parça boyutunu UYDURMAZ: 0 = "kendi varsayılanını kullan".
    partSizeBytes: 0,
    ...over,
  };
}

/** Oturum açma cevabı (200 + Location). */
const SESSION_OK: FakeResponse = {
  status: 200,
  headers: { Location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSION-1" },
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("beklenen hata oluşmadı: çağrı çözüldü");
}

function adapterWith(
  responses: FakeResponse[],
  nowFn: () => number = now,
  opts: Record<string, unknown> = {},
): { adapter: YouTubePublishAdapter; calls: RecordedCall[] } {
  const { fn, calls } = fakeTransport(responses);
  const adapter = new YouTubePublishAdapter({ now: nowFn, fetch: fn, ...opts });
  return { adapter, calls };
}

// ── 1. UPLOAD AKIŞI ────────────────────────────────────────────────────────

describe("startPublish — resumable oturum isteği", () => {
  it("POST, uploadType=resumable ve part=snippet,status gönderir", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("uploadType=resumable");
    expect(call.url).toContain(`part=${YOUTUBE_UPLOAD_PARTS}`);
    expect(call.url).toBe(`https://www.googleapis.com/youtube/v3/videos?${YOUTUBE_UPLOAD_QUERY}`);
  });

  it("X-Upload-Content-Length ve X-Upload-Content-Type başlıkları DOĞRU", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput());

    const headers = calls[0]!.headers;
    expect(headers["x-upload-content-length"]).toBe(String(MEDIA.bytes));
    expect(headers["x-upload-content-content-type"]).toBeUndefined();
    expect(headers["x-upload-content-type"]).toBe("video/mp4");
    expect(headers["authorization"]).toBe("Bearer ya29.TOKEN");
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("gövde privacyStatus=public ve AI/kids beyanlarını İÇERİR", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(
      makeInput({ copy: { ...COPY, aiGenerated: true, selfDeclaredMadeForKids: true } }),
    );

    const body = sentJson(calls[0]!);
    const status = body["status"] as Record<string, unknown>;
    expect(status["privacyStatus"]).toBe("public");
    expect(status["selfDeclaredMadeForKids"]).toBe(true);
    expect(status["containsSyntheticMedia"]).toBe(true);
  });

  it("gövde title/description/tags/categoryId/defaultLanguage taşır", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput());

    const snippet = sentJson(calls[0]!)["snippet"] as Record<string, unknown>;
    expect(snippet["title"]).toBe("Yeni ürün #Shorts");
    expect(typeof snippet["description"]).toBe("string");
    expect((snippet["description"] as string).length).toBeGreaterThan(0);
    expect(snippet["tags"]).toEqual(["tanitim"]);
    expect(snippet["categoryId"]).toBe(YOUTUBE_CATEGORY_ID);
    expect(snippet["defaultLanguage"]).toBe(YOUTUBE_DEFAULT_LANGUAGE);
  });

  it("Location başlığı StartResult.uploadUrl olarak döner, süre 1 saat", async () => {
    const { adapter } = adapterWith([SESSION_OK]);
    const result = await adapter.startPublish(makeInput());

    expect(result.kind).toBe("uploadUrl");
    if (result.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    expect(result.uploadUrl).toBe(SESSION_OK.headers!["Location"]);
    expect(result.state).toBe("processing");
    expect(Date.parse(result.expiresAt)).toBe(NOW_MS + 3_600_000);
  });

  it("externalId idempotencyKey'i taşır (pending: önekiyle)", async () => {
    const { adapter } = adapterWith([SESSION_OK]);
    const result = await adapter.startPublish(makeInput({ idempotencyKey: "yt:abc" }));

    if (result.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    expect(result.externalId).toBe(`${YOUTUBE_PENDING_PREFIX}yt:abc`);
    expect(isPendingExternalId(result.externalId)).toBe(true);
  });

  it("aynı idempotencyKey ile ikinci çağrı YENİ OTURUM AÇMAZ", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    const input = makeInput({ idempotencyKey: "yt:mukerrer" });

    const first = await adapter.startPublish(input);
    const second = await adapter.startPublish(input);

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("FARKLI medya aynı anahtarla gelirse yeni oturum açar (yeni iş)", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK, SESSION_OK]);
    const other: MediaRef = { ...MEDIA, storageKey: "derived/youtube/baska.mp4", bytes: 2048 };

    await adapter.startPublish(makeInput({ idempotencyKey: "yt:ortak" }));
    await adapter.startPublish(makeInput({ idempotencyKey: "yt:ortak", media: other }));

    expect(calls).toHaveLength(2);
  });
});

// ── 2. ZAMANLANMIŞ YAYIN ───────────────────────────────────────────────────

describe("startPublish — zamanlanmış yayın", () => {
  const FUTURE = "2026-03-02T09:30:00.000Z";

  it("gelecek scheduledAt → privacyStatus=private + publishAt (UTC ISO)", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput({ scheduledAt: FUTURE }));

    const status = sentJson(calls[0]!)["status"] as Record<string, unknown>;
    expect(status["privacyStatus"]).toBe("private");
    expect(status["publishAt"]).toBe(FUTURE);
  });

  it("ofselli girdi UTC ISO'ya çevrilir", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput({ scheduledAt: "2026-03-02T12:30:00+03:00" }));

    const status = sentJson(calls[0]!)["status"] as Record<string, unknown>;
    expect(status["publishAt"]).toBe("2026-03-02T09:30:00.000Z");
  });

  it("geçmiş scheduledAt zamanlanmış sayılmaz → public, publishAt YOK", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(makeInput({ scheduledAt: "2026-02-01T09:00:00.000Z" }));

    const status = sentJson(calls[0]!)["status"] as Record<string, unknown>;
    expect(status["privacyStatus"]).toBe("public");
    expect(status["publishAt"]).toBeUndefined();
  });

  it("zamanlanmış yayında 'unlisted' tercihi private'a ÇEVRİLİR", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    await adapter.startPublish(
      makeInput({ scheduledAt: FUTURE, copy: { ...COPY, privacy: "unlisted" } }),
    );

    expect((sentJson(calls[0]!)["status"] as Record<string, unknown>)["privacyStatus"]).toBe("private");
  });
});

// ── 3. videos.update YIKICILIK TESTİ (EN KRİTİK) ───────────────────────────

describe("updateStatus — oku, birleştir, gönder", () => {
  /** Sunucudaki mevcut durum: kullanıcının beyanları DOLU. */
  const REMOTE = {
    items: [
      {
        id: "VID12345678",
        snippet: { title: "Eski başlık", description: "eski", tags: ["a"], categoryId: "10" },
        status: {
          privacyStatus: "private",
          license: "creativeCommon",
          embeddable: false,
          publicStatsViewable: false,
          selfDeclaredMadeForKids: true,
          containsSyntheticMedia: true,
          publishAt: "2026-03-05T10:00:00.000Z",
          uploadStatus: "processed",
        },
      },
    ],
  };

  it("ÖNCE videos.get okur, SONRA videos.update gönderir (sıra)", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("part=id,status,snippet");
    expect(calls[0]!.url).toContain("id=VID12345678");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toContain("videos?part=");
  });

  it("KÖNEMLİ: gönderilen gövdede selfDeclaredMadeForKids SİLİNMEZ", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" });

    const sent = sentJson(calls[1]!)["status"] as Record<string, unknown>;
    expect(sent).toHaveProperty("selfDeclaredMadeForKids");
    expect(sent["selfDeclaredMadeForKids"]).toBe(true);
  });

  it("KÖNEMLİ: gönderilen gövdede containsSyntheticMedia SİLİNMEZ", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "unlisted" });

    const sent = sentJson(calls[1]!)["status"] as Record<string, unknown>;
    expect(sent).toHaveProperty("containsSyntheticMedia");
    expect(sent["containsSyntheticMedia"]).toBe(true);
  });

  it("license/embeddable/publicStatsViewable de korunur (tam birleştirme)", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" });

    const sent = sentJson(calls[1]!)["status"] as Record<string, unknown>;
    expect(sent["license"]).toBe("creativeCommon");
    expect(sent["embeddable"]).toBe(false);
    expect(sent["publicStatsViewable"]).toBe(false);
  });

  it("change üzerine yazar: privacyStatus değişir, publishAt korunur", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" });

    const sent = sentJson(calls[1]!)["status"] as Record<string, unknown>;
    expect(sent["privacyStatus"]).toBe("public");
  });

  it("yalnız status değişiyorsa part=status olur (snippet gönderilmez)", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 200, body: { id: "VID12345678" } },
    ]);
    const outcome = await adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" });

    expect(outcome.part).toBe("status");
    expect(calls[1]!.url).toContain("part=status");
    expect(sentJson(calls[1]!)["snippet"]).toBeUndefined();
  });

  it("snippet değişiyorsa categoryId ZORUNLU olduğu için doldurulur", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { items: [{ id: "V", status: {} }] } },
      { status: 200, body: { id: "V" } },
    ]);
    const outcome = await adapter.updateStatus(
      { account: ACCOUNT, videoId: "V" },
      { privacyStatus: "public" },
      { title: "Yeni başlık" },
    );

    expect(outcome.part).toBe("snippet,status");
    const snippet = sentJson(calls[1]!)["snippet"] as Record<string, unknown>;
    expect(snippet["title"]).toBe("Yeni başlık");
    expect(snippet["categoryId"]).toBe(YOUTUBE_CATEGORY_ID);
  });

  it("okuma başarısızsa update GÖNDERİLMEZ (kör güncelleme yapılmaz)", async () => {
    const { adapter, calls } = adapterWith([{ status: 500, body: { error: { message: "boom" } } }]);

    const err = await rejection(
      adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" }),
    );
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect(calls).toHaveLength(1);
  });

  it("videos.get video döndürmezse kalıcı hata verir", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { items: [] } }]);

    const err = await rejection(adapter.updateStatus({ account: ACCOUNT, videoId: "YOK" }, {}));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("validation");
  });

  it("sunucu alanı vermezse belirlenmiş varsayılanlar kullanılır (silme yok)", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { items: [{ id: "V", status: { privacyStatus: "public" } }] } },
      { status: 200, body: { id: "V" } },
    ]);
    await adapter.updateStatus({ account: ACCOUNT, videoId: "V" }, { embeddable: true });

    const sent = sentJson(calls[1]!)["status"] as Record<string, unknown>;
    expect(sent["selfDeclaredMadeForKids"]).toBe(false);
    expect(sent["containsSyntheticMedia"]).toBe(false);
    expect(sent["license"]).toBe("youtube");
    expect(sent["publicStatsViewable"]).toBe(true);
  });

  it("update başarısızsa hata sınıflandırılır", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: REMOTE },
      { status: 403, body: { error: { errors: [{ reason: "forbidden" }], message: "no" } } },
    ]);

    const err = await rejection(adapter.updateStatus({ account: ACCOUNT, videoId: "VID12345678" }, { privacyStatus: "public" }));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("policy");
  });
});

// ── 4. HATA EŞLEME ─────────────────────────────────────────────────────────

describe("mapYouTubeReason tablosu — her satır doğru sınıflandırılıyor", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["uploadLimitExceeded", "quota", false],
    ["dailyLimitExceeded", "quota", false],
    ["rateLimitExceeded", "ratelimit", true],
    ["invalidVideo", "media_rejected", false],
    ["invalidPublishAtTime", "validation", false],
    ["unauthorized", "auth", false],
    ["forbidden", "policy", false],
    ["internalServerError", "server", true],
    ["serviceUnavailable", "server", true],
    ["youtubeSignupRequired", "policy", false],
  ];

  for (const [reason, kind, retryable] of CASES) {
    it(`${reason} → ${kind} (${retryable ? "geçici" : "kalıcı"})`, () => {
      const mapped = mapYouTubeReason(reason);
      expect(mapped.kind).toBe(kind);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.providerCode).toBe(reason);
    });
  }

  it("reason YOK → unknown + kalıcı (sessizce geçici sayılmaz)", () => {
    const mapped = mapYouTubeReason(null);
    expect(mapped.kind).toBe("unknown");
    expect(mapped.retryable).toBe(false);
  });

  it("tanımsız reason → unknown + kalıcı", () => {
    const mapped = mapYouTubeReason("gelecekteVar");
    expect(mapped.kind).toBe("unknown");
    expect(mapped.retryable).toBe(false);
  });

  it("startPublish: dailyLimitExceeded → kalıcı quota hatası", async () => {
    const { adapter } = adapterWith([
      { status: 403, body: { error: { code: 403, errors: [{ reason: "dailyLimitExceeded" }], message: "kota" } } },
    ]);

    const err = await rejection(adapter.startPublish(makeInput()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("quota");
  });

  it("startPublish: serviceUnavailable → GEÇİCİ server hatası", async () => {
    const { adapter } = adapterWith([
      { status: 503, body: { error: { code: 503, errors: [{ reason: "serviceUnavailable" }], message: "yok" } } },
    ]);

    const err = await rejection(adapter.startPublish(makeInput()));
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("server");
  });

  it("reason İÇ İÇE geçmiş olsa da bulunur (özyinelemeli ayrıştırma)", () => {
    const response = {
      status: 403,
      ok: false,
      headers: {},
      body: "",
      json: {
        error: {
          code: 403,
          message: "derin",
          details: [{ reason: "invalidVideo", violations: [{ reason: "başka" }] }],
        },
      },
      retryAfterMs: null,
    };
    expect(parseGoogleError(response).reason).toBe("invalidVideo");
  });

  it("reason yoksa durum koduna düşer: 429 geçici, 5xx geçici, 401 auth, 403 policy", () => {
    const build = (status: number): Parameters<typeof classifyHttpFailure>[0] => ({
      status,
      ok: false,
      headers: {},
      body: "{}",
      json: { error: { message: "x" } },
      retryAfterMs: null,
    });
    expect(classifyHttpFailure(build(429), "x")).toBeInstanceOf(RetryablePublishError);
    expect(classifyHttpFailure(build(503), "x")).toBeInstanceOf(RetryablePublishError);
    expect((classifyHttpFailure(build(401), "x") as PermanentPublishError).kind).toBe("auth");
    expect((classifyHttpFailure(build(403), "x") as PermanentPublishError).kind).toBe("policy");
  });

  it("bilinmeyen durum (400) → unknown + kalıcı", () => {
    const response = {
      status: 400,
      ok: false,
      headers: {},
      body: "{}",
      json: { error: { message: "kotu istek" } },
      retryAfterMs: null,
    };
    const err = classifyHttpFailure(response, "x") as PermanentPublishError;
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(err.kind).toBe("unknown");
  });

  it("404 oturum → kalıcı container_expired", () => {
    const response = { status: 404, ok: false, headers: {}, body: "{}", json: null, retryAfterMs: null };
    const err = classifyHttpFailure(response, "x") as PermanentPublishError;
    expect(err.kind).toBe("container_expired");
  });

  it("409 → kalıcı, 'sessiz hata' uyarısı içerir", () => {
    const response = { status: 409, ok: false, headers: {}, body: "{}", json: null, retryAfterMs: null };
    const err = classifyHttpFailure(response, "x") as PermanentPublishError;
    expect(err.kind).toBe("validation");
    expect(err.message).toContain("sessiz");
  });
});

// ── 5. YÜKLEME HATALARI: 308 / 404 / 409 ──────────────────────────────────

describe("resumable yükleme — 308 / 404 / 409", () => {
  it("308 → PollResult.processing + retryAfterMs", async () => {
    const { adapter } = adapterWith([{ status: 308, headers: { Range: "bytes=0-524287" } }]);
    const poll = await adapter.probeUploadSession({
      account: ACCOUNT,
      sessionUri: "https://upload.example/S1",
      totalBytes: 1_048_576,
    });

    expect(poll.state).toBe("processing");
    expect(poll.retryAfterMs).toBeGreaterThan(0);
    expect(poll.providerStatus).toBe("resumable_308");
  });

  it("308 yanıtında alınan bayt sayısı hesaplanır", async () => {
    const { adapter } = adapterWith([{ status: 308, headers: { Range: "bytes=0-1023" } }]);
    const outcome = await adapter.uploadMedia({
      account: ACCOUNT,
      sessionUri: "https://upload.example/S1",
      bytes: new Uint8Array(4_000_000),
    });

    expect(outcome.uploaded).toBe(false);
    expect(outcome.receivedBytes).toBe(1_024);
    expect(outcome.videoId).toBeNull();
  });

  it("404 oturum → kalıcı 'baştan başlayın' hatası", async () => {
    const { adapter } = adapterWith([{ status: 404 }]);

    const err = await rejection(
      adapter.probeUploadSession({ account: ACCOUNT, sessionUri: "https://upload.example/ESKIMIS", totalBytes: 10 }),
    );
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("container_expired");
    expect((err as PermanentPublishError).message).toContain("BAŞTAN");
  });

  it("409 → kalıcı hata (bayt çakışması sessizdir)", async () => {
    const { adapter } = adapterWith([{ status: 409 }]);

    const err = await rejection(
      adapter.uploadMedia({ account: ACCOUNT, sessionUri: "https://upload.example/S1", bytes: new Uint8Array(100) }),
    );
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("validation");
  });

  it("201 yanıtı yüklemeyi tamamlar: videoId + permalink", async () => {
    const { adapter } = adapterWith([
      { status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } },
    ]);
    const outcome = await adapter.uploadMedia({
      account: ACCOUNT,
      sessionUri: "https://upload.example/S1",
      bytes: new Uint8Array(1_024),
    });

    expect(outcome.uploaded).toBe(true);
    expect(outcome.videoId).toBe("VID12345678");
    expect(outcome.permalink).toBe(`${YOUTUBE_PERMALINK_BASE}/VID12345678`);
  });

  it("0 bayt gövde reddedilir (yerinde kalıcı)", async () => {
    const { adapter } = adapterWith([{ status: 200 }]);

    const err = await rejection(
      adapter.uploadMedia({ account: ACCOUNT, sessionUri: "https://upload.example/S1", bytes: new Uint8Array(0) }),
    );
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("media_rejected");
  });

  it("geçmişte kalan oturum yoklaması kalıcı container_expired verir", async () => {
    const { adapter } = adapterWith([{ status: 200 }]);

    const err = await rejection(
      adapter.pollPublish(
        pollContext({
          externalId: pendingExternalId("yt:eski"),
          uploadUrlExpiresAt: "2026-02-01T00:00:00.000Z",
        }),
      ),
    );
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("container_expired");
  });
});

// ── 5b. uploadParts: MOTORUN ÇAĞIRDIĞI BAYT GÖNDERME ADIMI ─────────────────

/**
 * `startPublish` yalnızca oturumu AÇAR; `uploadParts` baytları GÖNDERİR.
 * Ayrım bilinçlidir: tek çağrıda her şeyi yapmak, süreç çökünce kaldığı yerden
 * devam etmeyi imkânsız kılardı.
 *
 * ASIL KURAL (bütün bu bölümün altındaki kural):
 *   `uploadedParts` YALNIZCA 2xx CEVABI ALINDIKTAN SONRA artar. Zaman aşımı
 *   "gönderdim sanıp" ilerleme bildirmez; sunucu baytı almamışsa sonraki
 *   denemede bayt ATLATILIR ve sessiz 416 gelir.
 */
describe("uploadParts — tek PUT ve doğrulanabilir istek", () => {
  const CREATED: FakeResponse = {
    status: 201,
    body: { id: "VID12345678", status: { privacyStatus: "public" } },
  };

  const bytesOf = (length: number): Uint8Array => new Uint8Array(length).fill(9);

  it("TEK PUT: Content-Length GERÇEK gövdeden, Content-Type oturum açılışıyla AYNI", async () => {
    // 1000 bayt — `MEDIA.bytes` (1 MiB) ile BİLEREK farklı: kayıt değil
    // GERÇEK gövde okunmalı (transcode sonrası kayıt eskimiş olabilir).
    const bytes = bytesOf(1000);
    const { adapter, calls } = adapterWith([SESSION_OK, CREATED], now, {
      readMedia: async () => bytes,
    });
    const input = makeInput();

    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    const progress = await adapter.uploadParts(
      input,
      uploadSession({ uploadUrl: start.uploadUrl, expiresAt: start.expiresAt }),
    );

    expect(calls).toHaveLength(2); // oturum açma + TEK bayt PUT'u
    const open = calls[0]!;
    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(start.uploadUrl);
    expect(put.headers["content-length"]).toBe("1000"); // ← 1048576 DEĞİL
    expect((put.rawBody as Uint8Array).length).toBe(1000);
    // YouTube, PUT'un Content-Type'ının başlangıçtaki X-Upload-Content-Type ile
    // AYNI olmasını şart koşar. İki taraf da `uploadContentType(media)`'tır.
    expect(put.headers["content-type"]).toBe(open.headers["x-upload-content-type"]);
    expect(put.headers["content-type"]).toBe("video/mp4");
    // `uploadedParts === 0` iken durum sorgusu YAPILMAZ (gereksiz tur).
    expect(put.headers["content-range"]).toBeUndefined();

    expect(progress).toEqual({ uploadedParts: 1, totalParts: 1, done: true, nextOffset: null });
    expect(adapter.callCounts().upload).toBe(1);
  });

  it("Content-Type iki tarafta da AYNI kuralı uygular: video/* değilse mp4", async () => {
    // `application/octet-stream` bildiren bir medya: her iki istekte de mp4.
    const media: MediaRef = { ...MEDIA, mimeType: "application/octet-stream" };
    const { adapter, calls } = adapterWith([SESSION_OK, CREATED], now, {
      readMedia: async () => bytesOf(64),
    });
    const input = makeInput({ media });

    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    await adapter.uploadParts(input, uploadSession({ uploadUrl: start.uploadUrl }));

    expect(calls[0]!.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(calls[1]!.headers["content-type"]).toBe("video/mp4");
  });

  it("readMedia TANIMLI DEĞİLSE kalıcı validation/no_media_reader (sessizce hiç gönderilmez)", async () => {
    const { adapter, calls } = adapterWith([SESSION_OK]);
    const input = makeInput();
    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");

    const err = await rejection(
      adapter.uploadParts(input, uploadSession({ uploadUrl: start.uploadUrl })),
    );

    expect(err).toBeInstanceOf(PermanentPublishError);
    const failure = err as PermanentPublishError;
    expect(failure.kind).toBe("validation");
    expect(failure.providerCode).toBe("no_media_reader");
    // KALICI: aynı montajla tekrar denemek aynı sonucu verir.
    expect(isRetryableKind(failure.kind)).toBe(false);
    // Hiçbir PUT atılmadı — ama bu SESSİZCE değil, KALICI hata olarak.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });

  it("okunmuş gövde 0 bayt ise yerinde kalıcı media_rejected", async () => {
    const { adapter } = adapterWith([SESSION_OK], now, { readMedia: async () => bytesOf(0) });

    const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("media_rejected");
    expect((err as PermanentPublishError).providerCode).toBe("empty_body");
  });
});

describe("uploadParts — devam (probeOffset)", () => {
  it("uploadedParts>0: önce probeOffset (boş gövde + bytes */TOTAL), sonra ÖĞRENİLEN ofsetten", async () => {
    const bytes = new Uint8Array(1000);
    const { adapter, calls } = adapterWith(
      [
        SESSION_OK,
        { status: 308, headers: { Range: "bytes=0-499" } }, // sunucu 500 bayt aldı
        { status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } },
      ],
      now,
      { readMedia: async () => bytes },
    );
    const input = makeInput();
    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");

    const progress = await adapter.uploadParts(
      input,
      uploadSession({
        uploadUrl: start.uploadUrl,
        uploadedParts: 2, // motorun PERSISTED sayacı
        partSizeBytes: YOUTUBE_RESUMABLE_CHUNK_BYTES,
      }),
    );

    expect(calls).toHaveLength(3);
    const probe = calls[1]!;
    expect(probe.method).toBe("PUT");
    expect(probe.url).toBe(start.uploadUrl);
    expect(probe.headers["content-length"]).toBe("0");
    expect(probe.headers["content-range"]).toBe("bytes */1000"); // TOPLAM biliniyor
    expect((probe.rawBody as Uint8Array).length).toBe(0); // BOŞ gövde

    // ÖĞRENİLEN ofsetten (500) devam: ilk 500 bayt TEKRAR gönderilmez.
    const resumed = calls[2]!;
    expect(resumed.headers["content-range"]).toBe("bytes 500-999/1000");
    expect(resumed.headers["content-length"]).toBe("500");
    expect((resumed.rawBody as Uint8Array).length).toBe(500);
    expect(progress.done).toBe(true);
  });

  it("probe sunucuya 'zaten hepsi geldi' derse (2xx) çift gönderim yapılmaz", async () => {
    const bytes = new Uint8Array(500);
    const { adapter, calls } = adapterWith(
      [
        SESSION_OK,
        { status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } },
        { status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } },
      ],
      now,
      { readMedia: async () => bytes },
    );
    const input = makeInput();
    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");

    await adapter.uploadParts(input, uploadSession({ uploadUrl: start.uploadUrl, uploadedParts: 1 }));

    // probe → 201 → "ofset 0" → TEK PUT (otomatik tekrar yok).
    expect(calls).toHaveLength(3);
    expect(calls[1]!.headers["content-range"]).toBe("bytes */500");
    expect(calls[2]!.headers["content-range"]).toBeUndefined();
    expect(calls[2]!.headers["content-length"]).toBe("500");
  });
});

describe("uploadParts — HTTP cevabı ne söylüyorsa o", () => {
  const bytes = new Uint8Array(1_000_000);
  const opts = { readMedia: async () => bytes };

  it("201 → done:true", async () => {
    const { adapter, calls } = adapterWith(
      [{ status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } }],
      now,
      opts,
    );

    const progress = await adapter.uploadParts(makeInput(), uploadSession());
    expect(progress).toEqual({ uploadedParts: 1, totalParts: 1, done: true, nextOffset: null });
    expect(calls).toHaveLength(1);
  });

  it("308 → uploadedParts ARTMAZ, kaldığın ofset BİLDİRİLİR (done:false)", async () => {
    // Sunucu baytları ALDI ama işlemi bitirmedi: bu HATA DEĞİL, "devam et".
    const { adapter } = adapterWith([{ status: 308, headers: { Range: "bytes=0-524287" } }], now, opts);

    const progress = await adapter.uploadParts(makeInput(), uploadSession({ uploadedParts: 0 }));
    expect(progress.done).toBe(false);
    expect(progress.uploadedParts).toBe(0); // ARTMAZ
    expect(progress.nextOffset).toBe(524_288);
    expect(progress.totalParts).toBeNull(); // sağlayıcı parça sayısı vermedi
  });

  it("308 → motorun YAZDIĞI uploadedParts KORUNUR, yine de artmaz", async () => {
    const { adapter, calls } = adapterWith(
      [
        { status: 308, headers: { Range: "bytes=0-99" } }, // probe: 100 bayt
        { status: 308, headers: { Range: "bytes=0-524287" } }, // PUT: 308
      ],
      now,
      opts,
    );

    const progress = await adapter.uploadParts(makeInput(), uploadSession({ uploadedParts: 1 }));
    expect(progress.done).toBe(false);
    expect(progress.uploadedParts).toBe(1); // 1 → 1, ARTMAZ
    expect(progress.nextOffset).toBe(524_288);
    // Oturum açılmadan doğrudan çağrıldığı için calls[0] = probe, calls[1] = PUT.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["content-range"]).toBe("bytes */1000000");
    expect(calls[1]!.headers["content-range"]).toBeUndefined(); // tek PUT yolu
  });

  it("404 ve 410 → kalıcı container_expired (oturum sona ermiş, BAŞTAN başla)", async () => {
    for (const status of [404, 410]) {
      const { adapter, calls } = adapterWith([{ status }], now, opts);
      const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

      expect(err).toBeInstanceOf(PermanentPublishError);
      const failure = err as PermanentPublishError;
      expect(failure.kind).toBe("container_expired");
      expect(failure.httpStatus).toBe(status);
      expect(isRetryableKind(failure.kind)).toBe(false);
      expect(failure.message).toContain("BAŞTAN");
      // Hata fırlatıldı → motor ilerleme YAZAMAZ.
      expect(calls).toHaveLength(1);
    }
  });

  it("5xx → GEÇİCİ server (aynı oturuma tekrar denenebilir)", async () => {
    for (const status of [500, 503]) {
      const { adapter } = adapterWith([{ status }], now, opts);
      const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

      expect(err).toBeInstanceOf(RetryablePublishError);
      const failure = err as RetryablePublishError;
      expect(failure.kind).toBe("server");
      expect(failure.httpStatus).toBe(status);
      expect(isRetryableKind(failure.kind)).toBe(true);
    }
  });

  it("429 → geçici ratelimit (retryAfterMs taşınır)", async () => {
    const { adapter } = adapterWith(
      [{ status: 429, headers: { "Retry-After": "120" } }],
      now,
      opts,
    );
    const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

    expect(err).toBeInstanceOf(RetryablePublishError);
    const failure = err as RetryablePublishError;
    expect(failure.kind).toBe("ratelimit");
    expect(failure.retryAfterMs).toBe(120_000);
  });

  it("409 → kalıcı validation (bayt çakışması SESSİZ hiçbir şey yüklemez)", async () => {
    const { adapter } = adapterWith([{ status: 409 }], now, opts);
    const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("validation");
    expect((err as PermanentPublishError).providerCode).toBe("range_conflict");
  });

  it("tanımsız durum → kalıcı unknown (tahmin yok)", async () => {
    const { adapter } = adapterWith([{ status: 418 }], now, opts);
    const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("unknown");
  });
});

describe("uploadParts — zaman aşımı 'gönderdim' DEMEZ", () => {
  /** Cevap VERMEYEN taşıma: yalnız iptal sinyalinde reddeder. */
  function hangingTransport(): { fn: Fetch; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: null,
        rawBody: init?.body,
      });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("zaman aşımı", "AbortError"));
        });
      });
    }) as unknown as Fetch;
    return { fn, calls };
  }

  it("PUT zaman aşımı → RetryablePublishError(network); ilerleme BİLDİRİLMEZ", async () => {
    const { fn, calls } = hangingTransport();
    const adapter = new YouTubePublishAdapter({
      now,
      fetch: fn,
      // Gerçek zaman aşımı: 1 ms sonra `AbortSignal` tetiklenir.
      uploadTimeoutMs: 1,
      readMedia: async () => new Uint8Array(2_048).fill(1),
    });

    const err = await rejection(adapter.uploadParts(makeInput(), uploadSession()));

    // "Gönderdim sanıp" `uploadedParts` ARTIRILMAZ: çağrı CEVAP vermeden
    // reddedilir, yani motor `uploadedParts`'ı değiştiremez. Bu davranışın
    // motor tarafındaki kanıtı `test/services/uploadCycle.test.ts`'tedir.
    expect(err).toBeInstanceOf(RetryablePublishError);
    const failure = err as RetryablePublishError;
    expect(failure.kind).toBe("network"); // yeniden denenecek
    expect(failure.message).toMatch(/zaman aşımı/);
    expect(calls).toHaveLength(1); // istek ATILDI ama cevap YOK
    expect(calls[0]!.method).toBe("PUT");
  });

  it("resume sırasında probe zaman aşımı da aynı sınıfı verir (bayt gönderilmez)", async () => {
    const { fn, calls } = hangingTransport();
    const adapter = new YouTubePublishAdapter({
      now,
      fetch: fn,
      uploadTimeoutMs: 1,
      readMedia: async () => new Uint8Array(2_048).fill(1),
    });

    const err = await rejection(
      adapter.uploadParts(makeInput(), uploadSession({ uploadedParts: 1 })),
    );

    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("network");
    // Yalnız durum sorgusu atıldı; HİÇBİR bayt gönderilmedi.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["content-range"]).toBe("bytes */2048");
  });
});

describe("uploadParts → pollPublish zinciri", () => {
  it("201 sonrası video kimliği oturuma yazılır; yoklama GERÇEK kimlikle published verir", async () => {
    const { adapter, calls } = adapterWith(
      [
        SESSION_OK,
        { status: 201, body: { id: "VID12345678", status: { privacyStatus: "public" } } },
        {
          status: 200,
          body: {
            items: [{ id: "VID12345678", status: { privacyStatus: "public", uploadStatus: "processed" } }],
          },
        },
      ],
      now,
      { readMedia: async () => new Uint8Array(512).fill(4) },
    );
    const input = makeInput({ idempotencyKey: "yt:zincir" });

    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    expect(start.externalId).toBe(pendingExternalId("yt:zincir"));

    const progress = await adapter.uploadParts(
      input,
      uploadSession({ uploadUrl: start.uploadUrl, expiresAt: start.expiresAt }),
    );
    expect(progress.done).toBe(true);
    // `startPublish` `externalId` olarak `pending:<key>` döner; GERÇEK kimlik
    // ancak 201 ile oluşur ve oturumda SAKLANIR.
    expect(adapter.session("yt:zincir")?.videoId).toBe("VID12345678");

    const poll = await adapter.pollPublish(
      pollContext({
        externalId: start.externalId,
        uploadUrl: start.uploadUrl,
        uploadUrlExpiresAt: start.expiresAt,
        uploadedParts: progress.uploadedParts,
      }),
    );

    expect(poll.state).toBe("published");
    expect(poll.remoteId).toBe("VID12345678");
    expect(poll.permalink).toBe(`${YOUTUBE_PERMALINK_BASE}/VID12345678`);

    // `videos.list` `pending:` ile DEĞİL, gerçek kimlikle çağrıldı.
    const list = calls.find((c) => c.url.includes("/videos?part=id,status,snippet"));
    expect(list?.url).toContain(`id=${"VID12345678"}`);
    expect(list?.url).not.toContain("pending");
  });

  it("201 gövdesi video kaynağı İÇERMEZSE kimlik yazılmaz, yoklama 'hâlâ oturum açık' der", async () => {
    const { adapter } = adapterWith([SESSION_OK, { status: 200 }], now, {
      readMedia: async () => new Uint8Array(128),
    });
    const input = makeInput({ idempotencyKey: "yt:kimsiz" });

    const start = await adapter.startPublish(input);
    if (start.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    const progress = await adapter.uploadParts(
      input,
      uploadSession({ uploadUrl: start.uploadUrl, expiresAt: start.expiresAt }),
    );

    // Gövde kabul edildi ama kimlik yok: motor yine de ilerlemeyi yazar.
    expect(progress.done).toBe(true);
    expect(adapter.session("yt:kimsiz")?.videoId).toBeNull();

    const poll = await adapter.pollPublish(
      pollContext({ externalId: start.externalId, uploadUrlExpiresAt: start.expiresAt }),
    );
    expect(poll.state).toBe("processing");
    expect(poll.providerStatus).toBe("resumable_session_open");
  });
});

// ── 6. POLLING ─────────────────────────────────────────────────────────────

describe("pollPublish — videos.list ile durum okuma", () => {
  function videoList(privacyStatus: string, publishAt?: string, uploadStatus = "processed"): FakeResponse {
    return {
      status: 200,
      body: {
        items: [{ id: "VID12345678", status: { privacyStatus, uploadStatus, ...(publishAt ? { publishAt } : {}) } }],
      },
    };
  }

  it("public → published + https://youtu.be/{id}", async () => {
    const { adapter, calls } = adapterWith([videoList("public")]);
    const poll = await adapter.pollPublish(pollContext());

    expect(poll.state).toBe("published");
    expect(poll.remoteId).toBe("VID12345678");
    expect(poll.permalink).toBe("https://youtu.be/VID12345678");
    expect(calls[0]!.url).toContain("videos?part=id,status,snippet");
    expect(calls[0]!.url).toContain("id=VID12345678");
  });

  it("unlisted → published (herhangi bir public görünürlük)", async () => {
    const { adapter } = adapterWith([videoList("unlisted")]);
    expect((await adapter.pollPublish(pollContext())).state).toBe("published");
  });

  it("private + GELECEK publishAt → processing + retryAfterMs", async () => {
    const { adapter } = adapterWith([videoList("private", "2026-03-10T10:00:00.000Z")]);
    const poll = await adapter.pollPublish(pollContext());

    expect(poll.state).toBe("processing");
    expect(poll.retryAfterMs).toBeGreaterThan(0);
    expect(poll.providerStatus).toBe("private_scheduled");
  });

  it("private + GEÇMİŞ publishAt → processing (yayınlanma sürüyor)", async () => {
    const { adapter } = adapterWith([videoList("private", "2026-02-01T10:00:00.000Z")]);
    const poll = await adapter.pollPublish(pollContext());

    expect(poll.state).toBe("processing");
    expect(poll.providerStatus).toBe("private_publishing");
  });

  it("private + publishAt YOK → doğrulama/compliance audit uyarısı", async () => {
    const { adapter } = adapterWith([videoList("private")]);
    const poll = await adapter.pollPublish(pollContext({ scheduledAt: null }));

    expect(poll.error?.kind).toBe("policy");
    expect(poll.error?.message).toContain(UNVERIFIED_PROJECT_MESSAGE.slice(0, 40));
  });

  it("zamanlanmış ama publishAt düşmüşse validation hatası", async () => {
    const { adapter } = adapterWith([videoList("private")]);
    const poll = await adapter.pollPublish(pollContext({ scheduledAt: "2026-03-10T10:00:00.000Z" }));

    expect(poll.error?.kind).toBe("validation");
    expect(poll.error?.message).toContain("publishAt");
  });

  it("uploadStatus=failed → media_rejected", async () => {
    const { adapter } = adapterWith([videoList("public", undefined, "failed")]);
    const poll = await adapter.pollPublish(pollContext());

    expect(poll.error?.kind).toBe("media_rejected");
  });

  it("ctx.externalId YOK → PermanentPublishError(validation)", async () => {
    const { adapter } = adapterWith([{ status: 200 }]);

    const err = await rejection(adapter.pollPublish(pollContext({ externalId: null })));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("validation");
  });

  it("pending: externalId ile videos.list ÇAĞRILMAZ", async () => {
    const { adapter, calls } = adapterWith([{ status: 200 }]);
    const poll = await adapter.pollPublish(pollContext({ externalId: pendingExternalId("yt:1") }));

    expect(calls).toHaveLength(0);
    expect(poll.state).toBe("processing");
    expect(poll.providerStatus).toBe("resumable_session_open");
  });
});

// ── 7. PRECHECK ────────────────────────────────────────────────────────────

describe("precheck", () => {
  it("başlık yoksa hata (validation) bulgusu üretir", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput({ copy: { ...COPY, title: null } }));

    const title = findings.find((f) => f.code === "title_required");
    expect(title?.severity).toBe("error");
  });

  it("100 karakteri aşan başlık hata üretir", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(
      makeInput({ copy: { ...COPY, title: "a".repeat(120), madeForShorts: false } }),
    );

    expect(findings.find((f) => f.code === "title_length")?.severity).toBe("error");
  });

  it("yatay video için Shorts uyarısı üretir", async () => {
    const { adapter } = adapterWith([]);
    const landscape: MediaRef = {
      ...MEDIA,
      info: { ...MEDIA.info, width: 1920, height: 1080 },
    };
    const findings = await adapter.precheck(makeInput({ media: landscape }));

    const finding = findings.find((f) => f.code === "shorts_aspect");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("Shorts");
  });

  it("3 dakikayı aşan süre Content ID blok riski uyarısı üretir", async () => {
    const { adapter } = adapterWith([]);
    const long: MediaRef = { ...MEDIA, info: { ...MEDIA.info, durationSec: 240 } };
    const findings = await adapter.precheck(makeInput({ media: long }));

    const finding = findings.find((f) => f.code === "shorts_duration");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("Content ID");
  });

  it("zamanlanmış yayında publishAt ön koşulu uyarısı üretir", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput({ scheduledAt: "2026-03-10T10:00:00.000Z" }));

    const finding = findings.find((f) => f.code === "schedule_publish_at");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("publishAt");
  });

  it("geçerli 9:16 dikey girdide hata bulgusu YOK", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput());
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });
});

// ── 8. readQuota ve finalize ───────────────────────────────────────────────

describe("readQuota / finalize", () => {
  it("hiç kayıt yokken null döner (0 kullanıldı iddiası UYDURULMAZ)", async () => {
    const { adapter } = adapterWith([]);
    expect(await adapter.readQuota(ACCOUNT)).toBeNull();
  });

  it("videos.insert çağrılarını sayar (günlük 100 kova)", async () => {
    const { adapter } = adapterWith([SESSION_OK, SESSION_OK]);
    await adapter.startPublish(makeInput({ idempotencyKey: "yt:1" }));
    await adapter.startPublish(makeInput({ idempotencyKey: "yt:2" }));

    const quota = await adapter.readQuota(ACCOUNT);
    expect(quota).not.toBeNull();
    expect(quota?.used).toBe(2);
    expect(quota?.total).toBe(100);
    expect(quota?.windowSec).toBeGreaterThan(0);
  });

  it("aynı idempotencyKey iki kez SAYILMAZ", async () => {
    const { adapter } = adapterWith([SESSION_OK]);
    const input = makeInput({ idempotencyKey: "yt:tek" });
    await adapter.startPublish(input);
    await adapter.startPublish(input);

    expect((await adapter.readQuota(ACCOUNT))?.used).toBe(1);
  });

  it("finalize thumbnails.set ÇAĞIRMAZ (ağ çağrısı yapmaz)", async () => {
    const { adapter, calls } = adapterWith([]);
    await adapter.finalize(makeInput(), { state: "published", remoteId: "VID1" });

    expect(calls).toHaveLength(0);
    expect(adapter.callCounts().thumbnail).toBe(0);
  });

  it("setThumbnail 0 bayt kapakla çağrılmaz", async () => {
    const { adapter, calls } = adapterWith([]);
    const err = await rejection(
      adapter.setThumbnail({ account: ACCOUNT, videoId: "V", bytes: new Uint8Array(0) }),
    );

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(calls).toHaveLength(0);
  });
});

// ── 9. OAuth ───────────────────────────────────────────────────────────────

describe("YouTubeAuth", () => {
  const CONFIG = {
    clientId: "client-123.apps.googleusercontent.com",
    clientSecret: "gizli",
    redirectUri: "http://localhost:5173/oauth/youtube/callback",
  };

  function authWith(responses: FakeResponse[], over: Record<string, unknown> = {}): { auth: YouTubeAuth; calls: RecordedCall[] } {
    const { fn, calls } = fakeTransport(responses);
    const auth = new YouTubeAuth(CONFIG, { now, fetch: fn, ...over });
    return { auth, calls };
  }

  it("authorizeUrl access_type=offline + prompt=consent içerir", () => {
    const { auth } = authWith([]);
    const url = new URL(auth.authorizeUrl("state-1", CONFIG.redirectUri, [...YOUTUBE_SCOPES]));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("authorizeUrl youtube.force-ssl scope'unu İÇERİR (zorunlu)", () => {
    const { auth } = authWith([]);
    const url = new URL(auth.authorizeUrl("s", CONFIG.redirectUri, ["https://www.googleapis.com/auth/youtube.upload"]));

    expect(url.searchParams.get("scope")).toContain("youtube.force-ssl");
  });

  it("çağıran yalnız upload scope gönderse bile force-ssl BİRLEŞTİRİLİR", () => {
    const { auth } = authWith([]);
    const scope = new URL(auth.authorizeUrl("s", CONFIG.redirectUri, ["https://www.googleapis.com/auth/youtube.upload"])).searchParams.get("scope") ?? "";

    expect(scope.split(" ")).toContain("https://www.googleapis.com/auth/youtube.force-ssl");
    expect(requiredScopes([])).toEqual(expect.arrayContaining([...YOUTUBE_SCOPES]));
  });

  it("exchangeCode channels?mine=true çağırır ve externalId'yi oradan alır", async () => {
    const { auth, calls } = authWith([
      {
        status: 200,
        body: { access_token: "ya29.A", refresh_token: "1//R", expires_in: 3599, scope: "a b" },
      },
      {
        status: 200,
        body: { items: [{ id: "UC999", snippet: { title: "Kanalım", customUrl: "kanalim" } }] },
      },
    ]);

    const result = await auth.exchangeCode({ code: "CODE", state: "s", redirectUri: CONFIG.redirectUri });

    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[1]!.url).toContain("channels?part=id,snippet&mine=true");
    expect(result.externalId).toBe("UC999");
    expect(result.displayName).toBe("Kanalım");
    expect(result.username).toBe("kanalim");
    expect(result.accessToken).toBe("ya29.A");
  });

  it("exchangeCode customUrl yoksa username null (uydurulmaz)", async () => {
    const { auth } = authWith([
      { status: 200, body: { access_token: "t", expires_in: 3600 } },
      { status: 200, body: { items: [{ id: "UC1", snippet: { title: "K" } }] } },
    ]);

    const result = await auth.exchangeCode({ code: "C", state: "s", redirectUri: CONFIG.redirectUri });
    expect(result.username).toBeNull();
  });

  it("kanal bulunamazsa kalıcı auth hatası", async () => {
    const { auth } = authWith([
      { status: 200, body: { access_token: "t" } },
      { status: 200, body: { items: [] } },
    ]);

    const err = await rejection(auth.exchangeCode({ code: "C", state: "s", redirectUri: CONFIG.redirectUri }));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("auth");
  });

  it("token hatasında invalid_grant kalıcı auth hatası verir", async () => {
    const { auth } = authWith([
      { status: 400, body: { error: "invalid_grant", error_description: "kod kullanılmış" } },
    ]);

    const err = await rejection(auth.exchangeCode({ code: "C", state: "s", redirectUri: CONFIG.redirectUri }));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).providerCode).toBe("invalid_grant");
  });

  it("state eşleşmezse HİÇBİR ağ çağrısı yapılmaz (CSRF koruması)", async () => {
    const { auth, calls } = authWith([{ status: 200, body: {} }], { expectedState: "dogru" });

    const err = await rejection(auth.exchangeCode({ code: "C", state: "yanlis", redirectUri: CONFIG.redirectUri }));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(calls).toHaveLength(0);
  });

  it("state eşleşirse akış sürer", async () => {
    const { auth, calls } = authWith(
      [
        { status: 200, body: { access_token: "t" } },
        { status: 200, body: { items: [{ id: "UC1", snippet: { title: "K" } }] } },
      ],
      { expectedState: "dogru" },
    );

    await auth.exchangeCode({ code: "C", state: "dogru", redirectUri: CONFIG.redirectUri });
    expect(calls).toHaveLength(2);
  });

  it("refresh yeni refresh_token döndürmezse null (eskisi KORUNUR)", async () => {
    const { auth } = authWith([{ status: 200, body: { access_token: "yeni", expires_in: 3600 } }]);
    const outcome = await auth.refresh("1//ESKI");

    expect(outcome.accessToken).toBe("yeni");
    expect(outcome.refreshToken).toBeNull();
    expect(outcome.expiresAt).toBe(new Date(NOW_MS + 3_600_000).toISOString());
  });

  it("refresh yeni refresh_token DÖNDÜRÜRSE döndürülen değer kullanılır", async () => {
    const { auth } = authWith([{ status: 200, body: { access_token: "yeni", refresh_token: "1//YENI" } }]);
    expect((await auth.refresh("1//ESKI")).refreshToken).toBe("1//YENI");
  });
});

// ── 10. Saf yardımcılar ve yapılandırma ────────────────────────────────────

describe("saf yardımcılar", () => {
  it("isConfigured eksik alanları doğru bildirir", () => {
    expect(isConfigured({ clientId: "a", clientSecret: "b", redirectUri: "c" })).toBe(true);
    expect(isConfigured({ clientId: "a", clientSecret: null, redirectUri: "c" })).toBe(false);
    expect(isConfigured(null)).toBe(false);
    expect(missingConfigKeys({ clientId: "a", clientSecret: null, redirectUri: "c" })).toEqual([
      "SP_GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("fitTitle 100 karakteri aşmaz ve #Shorts'u korur", () => {
    const fitted = fitTitle("b".repeat(200), true);
    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted).toContain("#Shorts");
  });

  it("fitTitle kısaltmaya gerek yoksa dokunmaz", () => {
    expect(fitTitle("Kısa", true)).toBe("Kısa #Shorts");
    expect(fitTitle("Kısa", false)).toBe("Kısa");
  });

  it("fitDescription 5000 karakteri aşmaz", () => {
    expect(fitDescription("c".repeat(9_000), [], [], true).length).toBeLessThanOrEqual(5_000);
  });

  it("parseRangeHeader kabul edilen bayt sayısını verir", () => {
    expect(parseRangeHeader("bytes=0-1023")).toBe(1_024);
    expect(parseRangeHeader("bozuk")).toBe(0);
    expect(parseRangeHeader(null)).toBe(0);
  });

  it("parseInstantMs geçersiz tarihi null verir", () => {
    expect(parseInstantMs("2026-03-01T12:00:00Z")).toBe(NOW_MS);
    expect(parseInstantMs("2026-02-31T00:00:00Z")).toBeNull();
    expect(parseInstantMs(null)).toBeNull();
  });

  it("readVideoView boş items'ta null döner", () => {
    expect(readVideoView({ items: [] })).toBeNull();
    expect(readVideoView(null)).toBeNull();
  });

  it("readVideoView düz 201 gövdesini de okur (items sarmalayıcısı yok)", () => {
    const view = readVideoView({ id: "VID1", status: { privacyStatus: "public", uploadStatus: "processed" } });
    expect(view?.id).toBe("VID1");
    expect(view?.privacyStatus).toBe("public");
  });

  it("readVideoView publishAt yoksa null verir", () => {
    const view = readVideoView({ items: [{ id: "V", status: { privacyStatus: "private" } }] });
    expect(view?.publishAt).toBeNull();
  });

  it("mediaFingerprint medya kimliğini ayırt eder", () => {
    expect(mediaFingerprint(MEDIA)).not.toBe(mediaFingerprint({ ...MEDIA, storageKey: "b.mp4" }));
  });

  it("hasTitle boş/boşluk başlığı reddeder", () => {
    expect(hasTitle("Başlık")).toBe(true);
    expect(hasTitle("   ")).toBe(false);
    expect(hasTitle(null)).toBe(false);
  });

  it("youtubePermalink youtu.be biçiminde", () => {
    expect(youtubePermalink("VID1")).toBe("https://youtu.be/VID1");
  });

  it("adapter platform/spec YouTube sözleşmesini kullanır", () => {
    const { adapter } = adapterWith([]);
    expect(adapter.platform).toBe("youtube");
    expect(adapter.spec).toBe(getSpec("youtube"));
  });

  it("durum alanları listesinde zorunlu beyanlar VAR", () => {
    expect(YOUTUBE_STATUS_WRITABLE_FIELDS).toContain("selfDeclaredMadeForKids");
    expect(YOUTUBE_STATUS_WRITABLE_FIELDS).toContain("containsSyntheticMedia");
  });
});

// ── 11. HTTP istemcisi ─────────────────────────────────────────────────────

describe("createHttpClient", () => {
  it("başlıkları küçük harfe indirger", () => {
    expect(normalizeHeaders({ Authorization: "Bearer x" })).toEqual({ authorization: "Bearer x" });
  });

  it("Retry-After saniye ve HTTP-tarihi biçimlerini okur", () => {
    expect(parseRetryAfterMs("120", NOW_MS)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(NOW_MS + 30_000).toUTCString(), NOW_MS)).toBe(30_000);
    expect(parseRetryAfterMs("bozuk", NOW_MS)).toBeNull();
  });

  it("gövde metin ve JSON döner", async () => {
    const { fn } = fakeTransport([{ status: 200, body: { ok: 1 } }]);
    const client = createHttpClient({ fetch: fn, now });
    const res = await client.send({ method: "GET", url: "https://x.test" });

    expect(res.ok).toBe(true);
    expect(res.json).toEqual({ ok: 1 });
    expect(res.body).toContain("\"ok\"");
  });

  it("bozuk JSON parse edilmez ama gövde korunur", () => {
    expect(safeJsonParse("{bozuk")).toBeNull();
    expect(safeJsonParse("")).toBeNull();
  });

  it("429 yanıtında Retry-After gecikmesi okunur", async () => {
    const { fn } = fakeTransport([
      { status: 429, headers: { "Retry-After": "42" }, body: { error: { message: "yavaş" } } },
    ]);
    const client = createHttpClient({ fetch: fn, now });
    const res = await client.send({ method: "GET", url: "https://x.test" });

    expect(res.retryAfterMs).toBe(42_000);
  });

  it("ağ hatası istisnadır (HTTP hatası DEĞİLDİR) — network'a çevrilir", async () => {
    const boom = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as Fetch;
    const client = createHttpClient({ fetch: boom, now });

    const err = await rejection(client.send({ method: "GET", url: "https://x.test" }));
    expect(asPublishTransportError(err, "test")).toBeInstanceOf(RetryablePublishError);
    expect((asPublishTransportError(err, "test") as RetryablePublishError).kind).toBe("network");
  });

  it("adapter.startPublish ağ hatasını geçici network hatasına çevirir", async () => {
    const boom = (() => Promise.reject(new Error("ENOTFOUND"))) as unknown as Fetch;
    const adapter = new YouTubePublishAdapter({ now, fetch: boom });

    const err = await rejection(adapter.startPublish(makeInput()));
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("network");
  });
});
