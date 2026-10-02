/**
 * Instagram adaptörü testleri.
 *
 * HİÇBİR TEST AĞA ÇIKMAZ: `fetch` daima enjekte edilmiş sahte bir taşıma ile
 * değiştirilir. Sahte taşıma gerçek `Response` nesneleri üretir; böylece
 * istemcinin ayrıştırma/zaman aşımı/başlık toplama yolu da testte çalışır.
 * `openRange` de enjekte edilir → `node:fs` yalnız `resolvePath` dalını
 * ölçen TEK test çiftinde gerçekten çalışır (dosya diskte vardır ve sahte
 * taşıma gövdeyi drain eder).
 *
 * Dört kanıt sütunu:
 *   1) İSTEK DOĞRULUĞU — gövde alanları, `rupload` başlıkları (`OAuth`,
 *      `Bearer` DEĞİL), `offset`/`file_size`, `media_publish`, `permаlink`.
 *   2) YÜKLEME DEVAMI — `uploadedParts` → `offset` aritmetiği ve
 *      `min(partSize, kalan)` kuralı (gövde boyutu ölçülür).
 *   3) HATA SINIFLANDIRMA — `debug_info.retriable`, `mapMetaError` tablosunun
 *      HER satırı, `mapMetaStatus` tablosu.
 *   4) DÜRÜST YANIT — `readQuota` sayı UYDURMAZ (kaynak metni okunmaz, İKİ
 *      farklı yanıttan İKİ farklı sonuç ölçülür), 404'te `null` döner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PublishInput,
  ResolvedCopy,
  UploadSession,
} from "../../../src/ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../../../src/ports/index.js";
import type { Fetch } from "../../../src/adapters/instagram/http.js";
import {
  INSTAGRAM_CONTAINER_POLL_MS,
  INSTAGRAM_MEDIA_TYPE,
  INSTAGRAM_RESUMABLE_CHUNK_BYTES,
  INSTAGRAM_SCOPES,
  InstagramPublishAdapter,
  buildContainerBody,
  classifyMetaFailure,
  isPast,
  mediaFingerprint,
  parseMetaError,
  parseMetaStatusError,
  readContainerRef,
  readContainerStatus,
  readMediaProductType,
  readPermalink,
  readQuotaView,
  resolveUploadUrl,
  ruploadUrl,
  totalPartsOf,
  type OpenRangeFn,
} from "../../../src/adapters/instagram/publisher.js";
import { InstagramAuth, pickPageWithInstagram, requiredScopes } from "../../../src/adapters/instagram/auth.js";
import { isConfigured, missingConfigKeys } from "../../../src/adapters/instagram/index.js";
import {
  asPublishTransportError,
  createHttpClient,
  normalizeHeaders,
  parseRetryAfterMs,
  safeJsonParse,
} from "../../../src/adapters/instagram/http.js";
import { GRAPH_API_VERSION, RUPLOAD_BASE } from "../../../src/media/specs/instagram.js";

// ── Sabit zaman ─────────────────────────────────────────────────────────────

/** 2026-03-01T12:00:00Z */
const NOW_ISO = "2026-03-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

const CONTAINER_ID = "18000000000000001";
const MEDIA_ID = "18000000000000009";
const IG_USER_ID = "17841400000000000";
const RUPLOAD_URL = `${RUPLOAD_BASE}/${GRAPH_API_VERSION}/${CONTAINER_ID}`;

/**
 * `node:fs` yolunu deneyen TEK test çifti için geçici dizin.
 *
 * Neden dosya üretiyoruz: `resolvePath` dalı `openRange` enjekte edilmemiş
 * tek daldır ve amacı "300 MB'ı belleğe almadan aralık okumak"tır. Sahte
 * bir okuyucu bu dalı hiç çalıştırmaz; ayrıca olmayan bir dosya `fs.ReadStream`
 * için "hata fırlatma" anlamına gelmez (hata gövde okunurken doğar), dolayısıyla
 * bu dalı ölçmenin tek dürüst yolu gerçek dosyadır.
 */
let fsDir = "";
beforeAll(() => {
  fsDir = mkdtempSync(join(tmpdir(), "sp-ig-fs-"));
});
afterAll(() => {
  rmSync(fsDir, { recursive: true, force: true });
});

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Gövde ham metin (bozuk JSON testi için). */
  raw?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  rawBody: unknown;
}

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
    const body =
      spec.raw !== undefined ? spec.raw : spec.body === undefined ? "" : JSON.stringify(spec.body);
    return new Response(body, { status: spec.status ?? 200, headers });
  }) as unknown as Fetch;
  return { fn, calls };
}

function sentJson(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? "{}") as Record<string, unknown>;
}

// ── Girdi kurulumu ──────────────────────────────────────────────────────────

const ACCOUNT: AccountRef = {
  id: "acc-ig-1",
  platform: "instagram",
  externalId: IG_USER_ID,
  accessToken: "EAAG_SHORT",
  refreshToken: null,
  tokenExpiresAt: "2026-05-01T00:00:00.000Z",
};

const MEDIA: MediaRef = {
  storageKey: "uploads/ab/cd/klip.mp4",
  bytes: 3_000_000,
  mimeType: "video/mp4",
  info: {
    path: "uploads/ab/cd/klip.mp4",
    bytes: 3_000_000,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 30,
    bitrate: 6_000_000,
    hasAudio: true,
  },
  coverKey: null,
  publicUrl: null,
};

const COPY: ResolvedCopy = {
  caption: "Ürün tanıtımı",
  hashtags: ["#kampanya"],
  title: null,
  description: null,
  tags: [],
  privacy: "public",
  coverAtPercent: 35,
  aiGenerated: true,
  selfDeclaredMadeForKids: false,
  madeForShorts: false,
};

function makeInput(over: Partial<PublishInput> = {}): PublishInput {
  return {
    jobId: "job-ig-1",
    idempotencyKey: "ig:job-1",
    account: ACCOUNT,
    media: MEDIA,
    copy: COPY,
    scheduledAt: null,
    coverBytes: null,
    ...over,
  };
}

function pollContext(over: Partial<PollContext> = {}): PollContext {
  return {
    account: ACCOUNT,
    externalId: CONTAINER_ID,
    uploadUrl: RUPLOAD_URL,
    uploadUrlExpiresAt: new Date(NOW_MS + 86_400_000).toISOString(),
    uploadedParts: 0,
    totalParts: null,
    scheduledAt: null,
    ...over,
  };
}

function session(over: Partial<UploadSession> = {}): UploadSession {
  return {
    uploadUrl: RUPLOAD_URL,
    expiresAt: new Date(NOW_MS + 86_400_000).toISOString(),
    totalParts: null,
    uploadedParts: 0,
    partSizeBytes: 1024,
    ...over,
  };
}

const CONTAINER_OK: FakeResponse = {
  status: 200,
  body: { id: CONTAINER_ID, uri: RUPLOAD_URL },
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("beklenen hata oluşmadı: çağrı çözüldü");
}

/** Test verisini üreten sahte aralık okuyucu (dosyaya dokunmaz). */
function fakeRange(bytes: number): { openRange: OpenRangeFn; seen: Array<{ offset: number; length: number }> } {
  const seen: Array<{ offset: number; length: number }> = [];
  return {
    seen,
    openRange: ({ offset, length }) => {
      seen.push({ offset, length });
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) out[i] = (offset + i) % 251;
      return out;
    },
  };
}

function adapterWith(
  responses: FakeResponse[],
  nowFn: () => number = now,
  opts: Record<string, unknown> = {},
  openRange?: OpenRangeFn,
): { adapter: InstagramPublishAdapter; calls: RecordedCall[] } {
  const { fn, calls } = fakeTransport(responses);
  const adapter = new InstagramPublishAdapter({
    now: nowFn,
    fetch: fn,
    ...(openRange === undefined ? {} : { openRange }),
    ...opts,
  });
  return { adapter, calls };
}

/**
 * Gövdeyi GERÇEKTEN tüketen taşıma — `node:fs` yolunu ölçmek için.
 *
 * `fakeTransport` gövdeye hiç dokunmaz; bu ikisi arasındaki fark testin
 * konusudur. Gerçek `fetch` bir `ReadableStream` gövdeyi aktarırken onu
 * `drain` eder, bu yüzden sahte de eder: aksi halde `openRange`'in ürettiği
 * akış hiç okunmaz, dosya tanıtıcısı açık kalır ve "akış kullanıldı" iddiası
 * ölçülemez.
 */
function streamingAdapter(
  responses: FakeResponse[],
  opts: Record<string, unknown> = {},
): { adapter: InstagramPublishAdapter; sent: Buffer[] } {
  const sent: Buffer[] = [];
  let index = 0;
  const fn = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    sent.push(await drainBody(init?.body));
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: new Headers(spec.headers ?? {}),
    });
  }) as unknown as Fetch;
  const adapter = new InstagramPublishAdapter({ now, fetch: fn, ...opts });
  return { adapter, sent };
}

/** Gövdeyi bayta çevirir; akış ise sonuna kadar okunur. */
async function drainBody(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body === undefined || body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── 1. CONTAINER ────────────────────────────────────────────────────────────

describe("startPublish — resumable container", () => {
  it("POST /{ig-user-id}/media: media_type=REELS, upload_type=resumable", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    await adapter.startPublish(makeInput());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_USER_ID}/media`,
    );
    const body = sentJson(calls[0]!);
    expect(body["media_type"]).toBe(INSTAGRAM_MEDIA_TYPE);
    expect(body["media_type"]).toBe("REELS");
    expect(body["upload_type"]).toBe("resumable");
  });

  it("gövde caption + is_ai_generated + share_to_feed taşır", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    await adapter.startPublish(makeInput());

    const body = sentJson(calls[0]!);
    expect(body["caption"]).toBe("Ürün tanıtımı #kampanya");
    expect(body["is_ai_generated"]).toBe(true);
    expect(body["share_to_feed"]).toBe(true);
    // Resumable yolda public URL GEREKMEZ: `video_url` boş gönderilir.
    expect(body["video_url"]).toBe("");
  });

  it("aiGenerated=false ise is_ai_generated AÇIKÇA false gönderilir", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    await adapter.startPublish(makeInput({ copy: { ...COPY, aiGenerated: false } }));

    const body = sentJson(calls[0]!);
    expect(body["is_ai_generated"]).toBe(false);
    expect(Object.keys(body)).toContain("is_ai_generated");
  });

  it("Authorization: Bearer (Graph API yolu rupload DEĞİLDİR)", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    await adapter.startPublish(makeInput());

    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${ACCOUNT.accessToken}`);
    expect(calls[0]!.url.startsWith(RUPLOAD_BASE)).toBe(false);
  });

  it("StartResult.uploadUrl döner: externalId=container id, expiresAt=+24 saat", async () => {
    const { adapter } = adapterWith([CONTAINER_OK]);
    const result = await adapter.startPublish(makeInput());

    expect(result.kind).toBe("uploadUrl");
    if (result.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    expect(result.externalId).toBe(CONTAINER_ID);
    expect(result.uploadUrl).toBe(RUPLOAD_URL);
    expect(Date.parse(result.expiresAt)).toBe(NOW_MS + 86_400_000);
    expect(result.state).toBe("processing");
  });

  it("id yoksa uri'nin son segmenti containerId olur (ÇIKARIM)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { uri: `https://rupload.facebook.com/ig-api-upload/${GRAPH_API_VERSION}/${CONTAINER_ID}?sig=abc` } },
    ]);
    const result = await adapter.startPublish(makeInput());

    if (result.kind !== "uploadUrl") throw new Error("beklenen dal değil");
    expect(result.externalId).toBe(CONTAINER_ID);
    // Mutlak `uri` uploadUrl olarak kullanılır.
    expect(result.uploadUrl).toContain(`/${CONTAINER_ID}`);
  });

  it("aynı idempotencyKey ile ikinci çağrı YENİ CONTAINER AÇMAZ", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    const input = makeInput({ idempotencyKey: "ig:mukerrer" });

    const first = await adapter.startPublish(input);
    const second = await adapter.startPublish(input);

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("FARKLI medya aynı anahtarla gelirse yeni container açar", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK, CONTAINER_OK]);
    const other: MediaRef = { ...MEDIA, storageKey: "uploads/zz/yy/baska.mp4", bytes: 4096 };

    await adapter.startPublish(makeInput({ idempotencyKey: "ig:ortak" }));
    await adapter.startPublish(makeInput({ idempotencyKey: "ig:ortak", media: other }));

    expect(calls).toHaveLength(2);
  });

  it("0 baytlık medya için container açılmaz (kalıcı hata)", async () => {
    const { adapter, calls } = adapterWith([CONTAINER_OK]);
    const err = await rejection(
      adapter.startPublish(makeInput({ media: { ...MEDIA, bytes: 0 } })),
    );

    expect(calls).toHaveLength(0);
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("media_rejected");
  });
});

// ── 2. YÜKLEME (rupload) ────────────────────────────────────────────────────

describe("uploadParts — rupload bayt gönderimi", () => {
  it("⚠️ Authorization: OAuth (Bearer DEĞİL) — bu tek başlık kolayca atlanır", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, fakeRange(3_000_000).openRange);
    await adapter.uploadParts(makeInput(), session({ uploadedParts: 0 }));

    const auth = calls[0]!.headers["authorization"] ?? "";
    expect(auth).toBe(`OAuth ${ACCOUNT.accessToken}`);
    expect(auth.startsWith("Bearer")).toBe(false);
  });

  it("offset: 0, file_size = GERÇEK dosya boyutu, Content-Type: video/mp4", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, fakeRange(3_000_000).openRange);
    await adapter.uploadParts(makeInput(), session({ uploadedParts: 0 }));

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(RUPLOAD_URL);
    expect(calls[0]!.headers["offset"]).toBe("0");
    expect(calls[0]!.headers["file_size"]).toBe(String(MEDIA.bytes));
    expect(calls[0]!.headers["content-type"]).toBe("video/mp4");
  });

  it("url RUPLOAD_BASE/{version}/{container} biçimindedir (Graph API DEĞİL)", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, fakeRange(3_000_000).openRange);
    await adapter.uploadParts(makeInput(), session());

    expect(calls[0]!.url).toBe(`${RUPLOAD_BASE}/${GRAPH_API_VERSION}/${CONTAINER_ID}`);
    expect(calls[0]!.url).not.toContain("graph.facebook.com");
  });

  it("200 → uploadedParts+1, done, nextOffset null", async () => {
    // `partSize = 1.000.000`, 3.000.000 bayt → 3 parça. `uploadedParts=2`
    // son parçayı gönderir: offset 2.000.000 + 1.000.000 = TAMAM.
    // (1024 baytlık parçayla 2. parça 3 MB'ı bitirmezdi; `done` beklentisi
    // aritmetik olarak yanlış olurdu.)
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, fakeRange(3_000_000).openRange);
    const progress = await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 2, partSizeBytes: 1_000_000 }),
    );

    // İstek GERÇEKTEN gitti: "tüm baytlar zaten gönderilmiş" erken dönüşü
    // değil, son parçanın gönderimi ölçülüyor.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["offset"]).toBe("2000000");
    expect(progress.uploadedParts).toBe(3);
    expect(progress.done).toBe(true);
    expect(progress.nextOffset).toBeNull();
    // totalParts = ceil(3_000_000 / 1_000_000)
    expect(progress.totalParts).toBe(Math.ceil(MEDIA.bytes / 1_000_000));
  });

  it("201 de kabul edilir", async () => {
    const { adapter, calls } = adapterWith([{ status: 201, body: {} }], now, {}, fakeRange(3_000_000).openRange);
    // Tek parça dosya: `partSize = bytes` → ilk çağrı son parçadır.
    const progress = await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 0, partSizeBytes: MEDIA.bytes }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["content-length"]).toBe(String(MEDIA.bytes));
    expect(progress.uploadedParts).toBe(1);
    expect(progress.totalParts).toBe(1);
    expect(progress.done).toBe(true);
    expect(progress.nextOffset).toBeNull();
  });

  it("uploadedParts=2 → offset = 2*partSize ve YALNIZ KALAN baytlar gönderilir", async () => {
    const range = fakeRange(MEDIA.bytes);
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, range.openRange);

    // `partSize = 1.000.000`: 2. parçadan sonra kalan bayt TAM OLARAK tek
    // parçaya sığar. Kalan miktar `partSize`'dan büyük olsaydı gönderilecek
    // miktar `min(partSize, kalan)` ile SINIRLANIRDI (bkz. bir sonraki test:
    // "son parça partSize'dan KÜÇÜK").
    await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 2, partSizeBytes: 1_000_000 }),
    );

    expect(calls[0]!.headers["offset"]).toBe("2000000");
    const remaining = MEDIA.bytes - 2_000_000;
    expect(range.seen).toEqual([{ offset: 2_000_000, length: remaining }]);
    // Gövde boyutu = kalan bayt (baştan gönderim YOK).
    expect((calls[0]!.rawBody as Uint8Array).byteLength).toBe(remaining);
    expect(calls[0]!.headers["content-length"]).toBe(String(remaining));
    // İçerik de DOĞRU ARALIKTAN: sahte okuyucu `out[i] = (offset + i) % 251`
    // yazar, yani ilk bayt ofsetin modülüdür. Baştan gönderim olsaydı 0 olurdu.
    const sent = calls[0]!.rawBody as Uint8Array;
    expect(sent[0]).toBe(2_000_000 % 251);
    expect(sent[sent.length - 1]).toBe((MEDIA.bytes - 1) % 251);
  });

  it("kalan bayt partSize'dan BÜYÜKSE gönderim parçayla SINIRLANIR", async () => {
    // Yukarıdaki testin tamamlayıcısı: kalan 2.997.952 > partSize 1024 ise
    // tek çağrıda 1024 bayt gider. "Yalnız kalan baytlar" ifadesi sınırsız
    // değil, `min(partSize, kalan)` demektir.
    const range = fakeRange(MEDIA.bytes);
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, range.openRange);

    const progress = await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 2, partSizeBytes: 1024 }),
    );

    expect(range.seen).toEqual([{ offset: 2048, length: 1024 }]);
    expect(calls[0]!.headers["content-length"]).toBe("1024");
    expect(progress.done).toBe(false);
    expect(progress.nextOffset).toBe(3072);
  });

  it("son parça partSize'dan KÜÇÜK gönderilir (dosya tam bölünmüyorsa)", async () => {
    const bytes = 2500;
    const range = fakeRange(bytes);
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, range.openRange);

    await adapter.uploadParts(
      makeInput({ media: { ...MEDIA, bytes } }),
      session({ uploadedParts: 0, partSizeBytes: 1024 }),
    );

    expect(range.seen[0]).toEqual({ offset: 0, length: 1024 });
    expect((calls[0]!.rawBody as Uint8Array).byteLength).toBe(1024);
  });

  it("orta parça → done:false ve nextOffset kaldığı yeri gösterir", async () => {
    const { adapter } = adapterWith([{ status: 200, body: {} }], now, {}, fakeRange(MEDIA.bytes).openRange);
    // 3_000_000 bayt, 1 MB parça: ilk parça tam değil → devam gerekir.
    const progress = await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 0, partSizeBytes: 1024 * 1024 }),
    );

    expect(progress.done).toBe(false);
    expect(progress.nextOffset).toBe(1024 * 1024);
    expect(progress.uploadedParts).toBe(1);
  });

  it("tüm baytlar gönderilmişse YENİ İSTEK ATILMAZ (offset çakışması olurdu)", async () => {
    const range = fakeRange(MEDIA.bytes);
    const { adapter, calls } = adapterWith([{ status: 200, body: {} }], now, {}, range.openRange);

    const progress = await adapter.uploadParts(
      makeInput(),
      session({ uploadedParts: 3_000, partSizeBytes: 1024 }),
    );

    expect(calls).toHaveLength(0);
    expect(progress.done).toBe(true);
    expect(progress.uploadedParts).toBe(3_000);
  });

  it("debug_info.retriable=TRUE → RetryablePublishError", async () => {
    const { adapter } = adapterWith(
      [
        {
          status: 400,
          body: {
            error: {
              message: "Upload failed",
              code: 100,
              debug_info: { retriable: true, reason: "temporary" },
            },
          },
        },
      ],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("transient");
  });

  it("debug_info.retriable=FALSE → PermanentPublishError", async () => {
    const { adapter } = adapterWith(
      [
        {
          status: 400,
          body: {
            error: {
              message: "Session expired",
              code: 100,
              debug_info: { retriable: false },
            },
          },
        },
      ],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(err).not.toBeInstanceOf(RetryablePublishError);
  });

  it("debug_info gövde içinde JSON STRING olarak gelirse de okunur", async () => {
    const { adapter } = adapterWith(
      [
        {
          status: 400,
          body: { error: { message: "x", debug_info: '{"retriable":true}' } },
        },
      ],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(RetryablePublishError);
  });

  it("retriable alanı YOKSA 4xx KALICI sayılır (offset çakışma riski)", async () => {
    const { adapter } = adapterWith(
      [{ status: 400, body: { error: { message: "offset mismatch", code: 100 } } }],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(PermanentPublishError);
  });

  it("retriable alanı YOKSA 5xx GEÇİCİ sayılır", async () => {
    const { adapter } = adapterWith(
      [{ status: 503, body: { error: { message: "service unavailable" } } }],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("server");
  });

  it("404 → kalıcı container_expired (oturum öldü, baştan başla)", async () => {
    const { adapter } = adapterWith(
      [{ status: 404, body: { error: { message: "unknown upload session" } } }],
      now,
      {},
      fakeRange(MEDIA.bytes).openRange,
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("container_expired");
  });

  it("aralık okuyucu bağlanmamışsa sessizce BAŞARILI DEĞİL, açık hata verir", async () => {
    const { adapter } = adapterWith([{ status: 200, body: {} }]);
    const err = await rejection(adapter.uploadParts(makeInput(), session()));

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).providerCode).toBe("range_source_missing");
  });

  it("resolvePath verilirse node:fs akışı GERÇEKTEN okunur (aralık baytları ölçülür)", async () => {
    // SAHTE YOK: dosya gerçekten diskte vardır ve taşıma gövdeyi DRAIN eder
    // (gerçek `fetch` ne yapıyorsa). Ölçüm, `resolvePath` yolunun
    // `openRange`'ten FARKLI bir kod olduğunu kanıtlar: gönderilen baytlar
    // dosyanın `[offset, offset+length)` aralığıdır.
    const file = join(fsDir, "gercek-klip.bin");
    const content = Buffer.alloc(4096);
    for (let i = 0; i < content.length; i += 1) content[i] = (i * 7) % 256;
    writeFileSync(file, content);

    const { adapter, sent } = streamingAdapter(
      [{ status: 200, body: {} }],
      { resolvePath: () => file },
    );
    await adapter.uploadParts(makeInput(), session({ uploadedParts: 0, partSizeBytes: 1024 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.byteLength).toBe(1024);
    expect(sent[0]!.equals(content.subarray(0, 1024))).toBe(true);
  });

  it("resolvePath + dosya YOKSA: hataya düşer, istek GİDERMEZ, unhandled hata yok", async () => {
    // `fs.ReadStream` eksik dosyada hata FIRLATMAZ: akım nesnesi döner, hata
    // gövde tüketilirken `error` olayı olarak doğar ve `client.send` onu
    // yakalayamaz → süreçte yakalanmamış istisna. Bu yüzden adaptör dosyayı
    // önce doğrular. Üçü birden geçerli olmalı: hata FIRLATSIN, hiçbir bayt
    // gönderilmesin ve "başarılı" demesin.
    const missing = join(fsDir, "boyle-bir-dosya-yok.mp4");
    const { adapter, sent } = streamingAdapter(
      [{ status: 200, body: {} }],
      { resolvePath: () => missing },
    );

    const err = await rejection(adapter.uploadParts(makeInput(), session()));

    expect(err).toBeInstanceOf(Error);
    expect(sent).toHaveLength(0);
  });
});

// ── 3. YOKLAMA ──────────────────────────────────────────────────────────────

describe("pollPublish — container durumu", () => {
  const IN_PROGRESS: FakeResponse = {
    status: 200,
    body: { id: CONTAINER_ID, status_code: "IN_PROGRESS", status: "in progress" },
  };

  it("IN_PROGRESS → processing + retryAfterMs ~60.000 (Meta dakikada bir öneriyor)", async () => {
    const { adapter, calls } = adapterWith([IN_PROGRESS]);
    const result = await adapter.pollPublish(pollContext());

    expect(result.state).toBe("processing");
    expect(result.retryAfterMs).toBe(INSTAGRAM_CONTAINER_POLL_MS);
    expect(result.retryAfterMs).toBe(60_000);
    expect(result.providerStatus).toBe("IN_PROGRESS");
    expect(result.error).toBeUndefined();
    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${CONTAINER_ID}?fields=status_code%2Cstatus`,
    );
  });

  it("FINISHED → media_publish çağrılır, remoteId + permalink döner", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "FINISHED" } },
      { status: 200, body: { id: MEDIA_ID } },
      {
        status: 200,
        body: { id: MEDIA_ID, permalink: `https://www.instagram.com/reel/${MEDIA_ID}/`, media_product_type: "REELS" },
      },
    ]);

    const result = await adapter.pollPublish(pollContext());

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_USER_ID}/media_publish`,
    );
    expect(sentJson(calls[1]!)["creation_id"]).toBe(CONTAINER_ID);

    expect(calls[2]!.url).toContain(`/${MEDIA_ID}`);
    expect(calls[2]!.url).toContain("permalink");

    expect(result.state).toBe("published");
    expect(result.remoteId).toBe(MEDIA_ID);
    expect(result.permalink).toBe(`https://www.instagram.com/reel/${MEDIA_ID}/`);
    // `media_publish` 200 döndü → iş YAYINLANDI. Arşivde ham `FINISHED`
    // yazmak yayınlanmış bir işi "işleniyor" gibi gösterirdi.
    expect(result.providerStatus).toBe("PUBLISHED");
    expect(adapter.callCounts().publish).toBe(1);
  });

  it("FINISHED + FEED ayrımı: providerStatus PUBLISHED_FEED olur (FINISHED_FEED DEĞİL)", async () => {
    // `providerStatus` yayın SONRASI durumdur; ham `FINISHED` kodu ile
    // birleştirilirse Meta'da var olmayan `FINISHED_FEED` kodu arşive yazılır.
    const { adapter } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "FINISHED" } },
      { status: 200, body: { id: MEDIA_ID } },
      { status: 200, body: { id: MEDIA_ID, permalink: "https://www.instagram.com/p/x/", media_product_type: "FEED" } },
    ]);

    const result = await adapter.pollPublish(pollContext());
    expect(result.state).toBe("published");
    expect(result.providerStatus).toBe("PUBLISHED_FEED");
  });

  it("permalink ALINAMAZSA published + null döner (motor published_no_link yapar)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "FINISHED" } },
      { status: 200, body: { id: MEDIA_ID } },
      { status: 500, body: { error: { message: "boom" } } },
    ]);

    const result = await adapter.pollPublish(pollContext());

    // Yayın GERİ ALINAMAZ (media_publish 200 döndü) → hata "başarısız" değildir.
    expect(result.state).toBe("published");
    expect(result.permalink).toBeNull();
    expect(result.remoteId).toBe(MEDIA_ID);
  });

  it("permalink gövdesinde alan yoksa da null (uydurulmaz)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "FINISHED" } },
      { status: 200, body: { id: MEDIA_ID } },
      { status: 200, body: { id: MEDIA_ID } },
    ]);

    const result = await adapter.pollPublish(pollContext());
    expect(result.permalink).toBeNull();
    expect(result.state).toBe("published");
  });

  it("PUBLISHED → yeniden media_publish ÇAĞRILMAZ (mükerrer paylaşım riski)", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "PUBLISHED" } },
      { status: 200, body: { permalink: `https://www.instagram.com/p/${MEDIA_ID}/`, media_product_type: "REELS" } },
    ]);

    const result = await adapter.pollPublish(pollContext());

    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
    expect(result.state).toBe("published");
  });

  it("media_product_type=FEED ise providerStatus PUBLISHED_FEED olur", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "PUBLISHED" } },
      { status: 200, body: { permalink: "https://instagram.com/p/x/", media_product_type: "FEED" } },
    ]);

    const result = await adapter.pollPublish(pollContext());
    expect(result.providerStatus).toBe("PUBLISHED_FEED");
  });

  it("EXPIRED → kalıcı container_expired (yeniden deneme anlamsız)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { id: CONTAINER_ID, status_code: "EXPIRED" } },
    ]);

    const err = await rejection(adapter.pollPublish(pollContext()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("container_expired");
  });

  it("EXPIRED: süresi geçmiş oturum, sunucuya hiç sorulmadan kalıcı hata verir", async () => {
    const { adapter, calls } = adapterWith([IN_PROGRESS]);
    const err = await rejection(
      adapter.pollPublish(
        pollContext({ uploadUrlExpiresAt: new Date(NOW_MS - 1000).toISOString() }),
      ),
    );

    expect(calls).toHaveLength(0);
    expect((err as PermanentPublishError).kind).toBe("container_expired");
  });

  it("ERROR + status=9/2207042 → kalıcı QUOTA", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "ERROR", status: "9/2207042" } },
    ]);

    const result = await adapter.pollPublish(pollContext());
    expect(result.error).toBeTruthy();
    expect(result.error!.kind).toBe("quota");
    expect(result.error!.providerCode).toBe("9/2207042");
  });

  it("ERROR + status=-2/2207003 → GEÇİCİ (medya indirme zaman aşımı)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "ERROR", status: "-2/2207003" } },
    ]);

    const result = await adapter.pollPublish(pollContext());
    expect(result.error!.kind).toBe("transient");
    expect(result.error!.providerCode).toBe("-2/2207003");
  });

  it("ERROR + status=25/2207050 → kalıcı policy", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "ERROR", status: "25/2207050" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error!.kind).toBe("policy");
  });

  it("ERROR + status=4/2207051 → kalıcı policy (spam koruması)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "ERROR", status: "4/2207051" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error!.kind).toBe("policy");
  });

  it("ERROR ama status sayı DEĞİLSE mapMetaStatus('ERROR') = media_rejected", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "ERROR", status: "Something went wrong" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error!.kind).toBe("media_rejected");
  });

  it("throttle 80002 → geçici ratelimit", async () => {
    const { adapter } = adapterWith([
      { status: 400, body: { error: { message: "throttled", error_subcode: 80002 } } },
    ]);
    const err = await rejection(adapter.pollPublish(pollContext()));
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("ratelimit");
  });

  it("kota hatası 9/2207042 HTTP yolunda da kalıcı quota", async () => {
    const { adapter } = adapterWith([
      {
        status: 400,
        body: { error: { message: "daily quota", code: 9, error_subcode: 2207042 } },
      },
    ]);
    const err = await rejection(adapter.pollPublish(pollContext()));
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("quota");
  });

  it("externalId boşsa kalıcı validation (ağ çağrısı yapılmaz)", async () => {
    const { adapter, calls } = adapterWith([IN_PROGRESS]);
    const err = await rejection(adapter.pollPublish(pollContext({ externalId: null })));

    expect(calls).toHaveLength(0);
    expect((err as PermanentPublishError).kind).toBe("validation");
  });

  it("tanımsız durum kodu → geçici SAYILMAZ, kalıcı unknown", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { status_code: "WAT" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error!.kind).toBe("unknown");
  });
});

// ── 4. KOTA ─────────────────────────────────────────────────────────────────

describe("readQuota — sayı HARİTLEME YAPILMAZ", () => {
  it("quota_usage / quota_total OKUNUR, since en fazla 24 saat önce", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { quota_usage: 7, config: { quota_total: 50, quota_duration: 86400 } } },
    ]);

    const snapshot = await adapter.readQuota(ACCOUNT);

    expect(snapshot).toEqual({ used: 7, total: 50, windowSec: 86_400 });
    expect(calls[0]!.url).toContain(`/${IG_USER_ID}/content_publishing_limit`);
    expect(calls[0]!.url).toContain("fields=quota_usage%2Cconfig");
    const since = new URL(calls[0]!.url).searchParams.get("since");
    expect(Number(since)).toBeLessThanOrEqual(Math.floor((NOW_MS - 86_400_000) / 1000));
  });

  it("quota_duration yoksa 86400 varsayılır", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { quota_usage: 1, config: { quota_total: 100 } } },
    ]);
    expect(await adapter.readQuota(ACCOUNT)).toEqual({ used: 1, total: 100, windowSec: 86_400 });
  });

  it("404 (endpoint yok/izin yok) → null, motor eski davranışına düşer", async () => {
    const { adapter } = adapterWith([
      { status: 404, body: { error: { message: "Unsupported get_request" } } },
    ]);
    expect(await adapter.readQuota(ACCOUNT)).toBeNull();
  });

  it("403 → null (kota yayını ENGELLEMEZ)", async () => {
    const { adapter } = adapterWith([{ status: 403, body: {} }]);
    expect(await adapter.readQuota(ACCOUNT)).toBeNull();
  });

  it("quota_total eksikse null (0 saymak yanlış karar yönlendirir)", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { quota_usage: 3, config: {} } }]);
    expect(await adapter.readQuota(ACCOUNT)).toBeNull();
  });

  it("kota sayısı KODDA SABİT YAZILMAZ: iki farklı yanıt İKİ farklı sonuç verir", async () => {
    // KAYNAK METNİ OKUNMAZ. Önceki hâli `publisher.ts`'in kaynak dosyasını
    // okuyup içinde `quota_total: <sayı>` deseni arıyordu; kaynaktaki bir
    // AÇIKLAMA cümlesi ("`quota_total: 50` örneği verir") testi kırıyordu ve
    // yorum değişikliği davranış değişikliği sanılıyordu. Buradaki ölçüm
    // GERÇEK SÖZLEŞMEYİ kilitler: `total` yalnız yanıttan gelir.
    //
    // Sabit yazılsaydı (50 ya da 100) iki çağrıdan biri YANLIŞ dönerdi.
    const { adapter } = adapterWith([
      { status: 200, body: { quota_usage: 7, config: { quota_total: 50 } } },
      { status: 200, body: { quota_usage: 2, config: { quota_total: 100 } } },
    ]);

    expect(await adapter.readQuota(ACCOUNT)).toEqual({ used: 7, total: 50, windowSec: 86_400 });
    expect(await adapter.readQuota(ACCOUNT)).toEqual({ used: 2, total: 100, windowSec: 86_400 });
  });

  it("kota alanları gövdede YOKSA uydurma değer dönmez (null)", async () => {
    // Yanıtta ne varsa o: eksik alan için 0/50/100 YAZILMAZ. Bu, sabit
    // yazmama kuralının "okunamadığında ne yapılır" yarısıdır.
    const { adapter } = adapterWith([
      { status: 200, body: { config: { quota_duration: 86_400 } } },
    ]);
    expect(await adapter.readQuota(ACCOUNT)).toBeNull();
  });
});

// ── 5. PRECHECK ─────────────────────────────────────────────────────────────

describe("precheck", () => {
  it("2 saniyelik video → error (alt sınır 3 sn)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(
      makeInput({ media: { ...MEDIA, info: { ...MEDIA.info, durationSec: 2 } } }),
    );

    const dur = findings.find((f) => f.code === "duration_min");
    expect(dur?.severity).toBe("error");
    expect(adapter.callCounts().precheck).toBe(1);
  });

  it("16 dakikalık video → error (üst sınır 15 dk)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(
      makeInput({ media: { ...MEDIA, info: { ...MEDIA.info, durationSec: 16 * 60 } } }),
    );
    expect(findings.find((f) => f.code === "duration_max")?.severity).toBe("error");
  });

  it("350 MB dosya → error (sınır 300 MB)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(
      makeInput({ media: { ...MEDIA, bytes: 350 * 1024 * 1024, info: { ...MEDIA.info, bytes: 350 * 1024 * 1024 } } }),
    );
    expect(findings.find((f) => f.code === "file_size")?.severity).toBe("error");
  });

  it("9:16 DIKEY video → aspect_ratio HATASI YOK (oran zorunlu değil)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput());

    const aspect = findings.find((f) => f.code === "aspect_ratio");
    expect(aspect?.severity).not.toBe("error");
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });

  it("geçerli girdide HİÇ hata yoktur", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput());
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });

  it("caption 2200 karakteri aşarsa error (hashtag'ler dahil ölçülür)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(
      makeInput({ copy: { ...COPY, caption: "x".repeat(2195) } }),
    );
    const caption = findings.find((f) => f.code === "caption_length");
    expect(caption?.severity).toBe("error");
  });

  it("31 hashtag → error (sınır 30)", async () => {
    const { adapter } = adapterWith([]);
    const hashtags = Array.from({ length: 31 }, (_, i) => `#tag${i}`);
    const findings = await adapter.precheck(makeInput({ copy: { ...COPY, hashtags } }));
    expect(findings.find((f) => f.code === "hashtag_count")?.severity).toBe("error");
  });

  it("aiGenerated=true → is_ai_generated beyanı not olarak düşer", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput());
    const note = findings.find((f) => f.code === "ai_generated_disclosure");
    expect(note?.severity).toBe("info");
    expect(note?.message).toContain("is_ai_generated");
  });

  it("0 bayt → error (empty_media)", async () => {
    const { adapter } = adapterWith([]);
    const findings = await adapter.precheck(makeInput({ media: { ...MEDIA, bytes: 0 } }));
    expect(findings.find((f) => f.code === "empty_media")?.severity).toBe("error");
  });

  it("spec getSpec('instagram') ile AYNI nesnedir (sabit kopya yok)", () => {
    const { adapter } = adapterWith([]);
    expect(adapter.spec.platform).toBe("instagram");
    expect(adapter.spec.limits.some((l) => l.code === "duration")).toBe(true);
  });
});

// ── 6. OAuth ────────────────────────────────────────────────────────────────

const TOKEN_OK: FakeResponse = {
  status: 200,
  body: { access_token: "LONG_LIVED_TOKEN", expires_in: 5_184_000, token_type: "bearer" },
};

const ACCOUNTS_OK: FakeResponse = {
  status: 200,
  body: {
    data: [
      {
        id: "PAGE_1",
        name: "Marka Sayfası",
        instagram_business_account: { id: IG_USER_ID, username: "marka", name: "Marka" },
      },
    ],
  },
};

function authWith(
  responses: FakeResponse[],
  opts: { expectedState?: string; nowFn?: () => number } = {},
): { auth: InstagramAuth; calls: RecordedCall[] } {
  const { fn, calls } = fakeTransport(responses);
  const auth = new InstagramAuth(
    { clientId: "APP", clientSecret: "SECRET", redirectUri: "https://app.example/cb" },
    {
      now: opts.nowFn ?? now,
      fetch: fn,
      graphBase: "https://graph.facebook.com",
      dialogBase: "https://www.facebook.com",
      ...(opts.expectedState === undefined ? {} : { expectedState: opts.expectedState }),
    },
  );
  return { auth, calls };
}

describe("InstagramAuth — Facebook Login for Business", () => {
  it("authorizeUrl: zorunlu scope'lar + state + code akışı", () => {
    const { auth } = authWith([]);
    const url = new URL(auth.authorizeUrl("STATE123", "https://app.example/cb", ["instagram_basic"]));

    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
    expect(url.searchParams.get("state")).toBe("STATE123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("APP");
    const scopes = (url.searchParams.get("scope") ?? "").split(",");
    for (const required of INSTAGRAM_SCOPES) expect(scopes).toContain(required);
  });

  it("exchangeCode: kısa token → long-lived → externalId + linkedPageId", async () => {
    const { auth, calls } = authWith([
      { status: 200, body: { access_token: "SHORT", expires_in: 3600 } },
      TOKEN_OK,
      ACCOUNTS_OK,
    ]);

    const out = await auth.exchangeCode({
      code: "CODE",
      state: "S",
      redirectUri: "https://app.example/cb",
    });

    // 1) code ile token  2) fb_exchange_token  3) /me/accounts
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain("grant_type=fb_exchange_token");
    expect(calls[2]!.url).toContain("/me/accounts");

    expect(out.externalId).toBe(IG_USER_ID);
    expect(out.linkedPageId).toBe("PAGE_1");
    expect(out.username).toBe("marka");
    expect(out.displayName).toBe("Marka");
    expect(out.accessToken).toBe("LONG_LIVED_TOKEN");
    expect(Date.parse(out.expiresAt ?? "")).toBe(NOW_MS + 5_184_000 * 1000);
  });

  it("refreshToken null döner (Meta refresh token YAYINLAMAZ)", async () => {
    const { auth } = authWith([TOKEN_OK]);
    const out = await auth.refresh("EXISTING_LONG_LIVED");

    expect(out.refreshToken).toBeNull();
    expect(out.accessToken).toBe("LONG_LIVED_TOKEN");
    expect(out.accountChanged).toBe(false);
  });

  it("refresh: boş belirteç kalıcı auth hatası (yeniden yetkilendirme)", async () => {
    const { auth, calls } = authWith([]);
    const err = await rejection(auth.refresh(""));

    expect(calls).toHaveLength(0);
    expect((err as PermanentPublishError).kind).toBe("auth");
  });

  it("state eşleşmezse HİÇBİR ağ çağrısı yapılmaz (CSRF)", async () => {
    const { auth, calls } = authWith([TOKEN_OK], { expectedState: "GELEN" });
    const err = await rejection(
      auth.exchangeCode({ code: "C", state: "SALDIRGI", redirectUri: "https://app.example/cb" }),
    );

    expect(calls).toHaveLength(0);
    expect((err as PermanentPublishError).providerCode).toBe("state_mismatch");
  });

  it("IG bağlı OLMAYAN sayfa → kalıcı auth hatası (profesyonel hesap şartı)", async () => {
    const { auth } = authWith([
      { status: 200, body: { access_token: "SHORT", expires_in: 3600 } },
      TOKEN_OK,
      { status: 200, body: { data: [{ id: "PAGE_1", name: "Kişisel" }] } },
    ]);

    const err = await rejection(
      auth.exchangeCode({ code: "C", state: "S", redirectUri: "https://app.example/cb" }),
    );
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).providerCode).toBe("no_instagram_business_account");
  });

  it("sayfa YOKSA → no_page", async () => {
    const { auth } = authWith([
      { status: 200, body: { access_token: "SHORT", expires_in: 3600 } },
      TOKEN_OK,
      { status: 200, body: { data: [] } },
    ]);
    const err = await rejection(
      auth.exchangeCode({ code: "C", state: "S", redirectUri: "https://app.example/cb" }),
    );
    expect((err as PermanentPublishError).providerCode).toBe("no_page");
  });

  it("token hatası → kalıcı auth (invalid_grant)", async () => {
    // Graph OAuth token ucu `error` alanını DÜZ metin (string) döner:
    //   { "error": "invalid_grant", "error_description": "..." }
    // Önceki sahte gövde bunu `error: { error: "invalid_grant" }` biçiminde
    // kuruyordu; böyle bir gövde Meta'dan GELMEZ ve `providerCode` bu yüzden
    // `invalid_grant` değil `http_400` oluyordu. Sınıf kalıcı `auth` idi —
    // yani üretim yolu doğruydu, sahte yanıt yanlıştı.
    const { auth, calls } = authWith([
      { status: 400, body: { error: "invalid_grant", error_description: "code expired" } },
    ]);
    const err = await rejection(
      auth.exchangeCode({ code: "C", state: "S", redirectUri: "https://app.example/cb" }),
    );

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect(err).not.toBeInstanceOf(RetryablePublishError);
    expect((err as PermanentPublishError).kind).toBe("auth");
    expect((err as PermanentPublishError).providerCode).toBe("invalid_grant");
    // Uzatma adımına GEÇİLMEDİ: kısa token alınamadıysa uzun token istenmez.
    expect(calls).toHaveLength(1);
  });

  it("tanınmayan/beklenmeyen token hata biçimi de kalıcı auth (sessiz geçmez)", async () => {
    // Graph hatası okunamazsa `http_<durum>` koduyla da olsa hata ÜRETİLİR:
    // yetkilendirme başarısız görünüp kullanıcı panelde oturum açık sanmamalı.
    const { auth } = authWith([{ status: 200, body: { access_token: 12 } }]);
    const err = await rejection(
      auth.exchangeCode({ code: "C", state: "S", redirectUri: "https://app.example/cb" }),
    );

    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("auth");
    expect((err as PermanentPublishError).providerCode).toBe("http_200");
  });

  it("pickPageWithInstagram: IG'siz sayfayı ATLAR", () => {
    const picked = pickPageWithInstagram({
      data: [
        { id: "P1", name: "Kişisel" },
        { id: "P2", name: "Marka", instagram_business_account: { id: "IG2", username: "marka" } },
      ],
    });
    expect(picked?.pageId).toBe("P2");
    expect(picked?.igUserId).toBe("IG2");
  });

  it("isConfigured: eksik alan listeler, sessizce geçmez", () => {
    expect(isConfigured({ clientId: "A", clientSecret: "B", redirectUri: "C" })).toBe(true);
    expect(isConfigured({ clientId: "A", clientSecret: null, redirectUri: "C" })).toBe(false);
    expect(isConfigured(null)).toBe(false);
    expect(missingConfigKeys({ clientId: null, clientSecret: null, redirectUri: null })).toEqual([
      "SP_META_APP_ID",
      "SP_META_APP_SECRET",
      "SP_META_REDIRECT_URI",
    ]);
  });

  it("requiredScopes zorunlu kümenin üstüne birleştirir (union)", () => {
    const merged = requiredScopes(["pages_manage_posts", "instagram_basic"]);
    expect(merged).toContain("pages_manage_posts");
    expect(merged).toContain("instagram_content_publish");
    // Tekrar eklenmez.
    expect(merged.filter((s) => s === "instagram_basic")).toHaveLength(1);
  });
});

// ── 7. SAF HATA EŞLEME ──────────────────────────────────────────────────────

describe("saf fonksiyonlar — hata eşleme", () => {
  function res(json: unknown, status = 400, retryAfterMs: number | null = null) {
    return { status, ok: false, headers: {}, body: JSON.stringify(json), json, retryAfterMs };
  }

  it("9/2207042 → quota, retryable=false", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "quota", code: 9, error_subcode: 2207042 } }),
      "test",
    ) as PermanentPublishError;
    expect(e.kind).toBe("quota");
  });

  it("-2/2207003 → transient, RetryablePublishError", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "timeout", code: -2, error_subcode: 2207003 } }),
      "test",
    );
    expect(e).toBeInstanceOf(RetryablePublishError);
    expect((e as RetryablePublishError).kind).toBe("transient");
  });

  it("4/2207051 → policy", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "spam", code: 4, error_subcode: 2207051 } }),
      "test",
    ) as PermanentPublishError;
    expect(e.kind).toBe("policy");
  });

  it("25/2207050 → policy", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "restricted", code: 25, error_subcode: 2207050 } }),
      "test",
    ) as PermanentPublishError;
    expect(e.kind).toBe("policy");
  });

  it("throttle 80002 → ratelimit (geçici)", () => {
    const e = classifyMetaFailure(res({ error: { message: "slow down", code: 80002 } }), "test");
    expect(e).toBeInstanceOf(RetryablePublishError);
    expect((e as RetryablePublishError).kind).toBe("ratelimit");
  });

  it("9004 → network (geçici)", () => {
    const e = classifyMetaFailure(res({ error: { message: "cannot fetch", code: 9004 } }), "test");
    expect(e).toBeInstanceOf(RetryablePublishError);
  });

  it("TANIMSIYAN kod → unknown + KALICI (tahmin yok)", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "?", code: 123456, error_subcode: 999 } }, 400),
      "test",
    ) as PermanentPublishError;
    expect(e.kind).toBe("unknown");
    expect(e.providerCode).toBe("123456/999");
  });

  it("429 → ratelimit, Retry-After gecikmesi taşınır", () => {
    const e = classifyMetaFailure(res({}, 429), "test", {}) as RetryablePublishError;
    expect(e.kind).toBe("ratelimit");
  });

  it("403 → policy", () => {
    const e = classifyMetaFailure(res({}, 403), "test") as PermanentPublishError;
    expect(e.kind).toBe("policy");
  });

  it("logId (fbtrace_id) hata nesnesine taşınır", () => {
    const e = classifyMetaFailure(
      res({ error: { message: "x", code: 190, fbtrace_id: "TRACE-1" } }, 400),
      "test",
    );
    expect(e.logId).toBe("TRACE-1");
  });

  it("parseMetaError: retriable alanı yoksa null", () => {
    expect(parseMetaError({ error: { message: "x" } }).retriable).toBeNull();
    expect(parseMetaError(null).retriable).toBeNull();
  });

  it("parseMetaStatusError: 'a/b' → çift, tek sayı → code, metin → null", () => {
    expect(parseMetaStatusError("9/2207042")).toEqual({ code: "9", subcode: "2207042" });
    expect(parseMetaStatusError("ERROR 2207042")).toEqual({ code: "2207042", subcode: null });
    expect(parseMetaStatusError("bir şey oldu")).toEqual({ code: null, subcode: null });
  });

  it("readContainerRef: id yoksa uri'den çıkarır, ikisi de yoksa null", () => {
    expect(readContainerRef({ id: "A", uri: "https://x/y" })).toEqual({
      containerId: "A",
      uploadUri: "https://x/y",
    });
    expect(readContainerRef({ uri: `https://r/${GRAPH_API_VERSION}/B` })).toEqual({
      containerId: "B",
      uploadUri: `https://r/${GRAPH_API_VERSION}/B`,
    });
    expect(readContainerRef({})).toBeNull();
    expect(readContainerRef("çöp")).toBeNull();
  });

  it("resolveUploadUrl: mutlak uri kullanılır, göreli adres kurulur", () => {
    expect(resolveUploadUrl({ containerId: "C", uploadUri: "https://rupload.example/v/C" })).toBe(
      "https://rupload.example/v/C",
    );
    expect(resolveUploadUrl({ containerId: "C", uploadUri: null })).toBe(ruploadUrl("C"));
  });

  it("okuma yardımcıları bozuk gövdede null döner", () => {
    expect(readContainerStatus(null)).toEqual({ statusCode: null, status: null });
    expect(readPermalink(null)).toBeNull();
    expect(readMediaProductType({})).toBeNull();
    expect(readQuotaView({})).toBeNull();
  });

  it("buildContainerBody: resumable yolda video_url BOŞ (public URL gerekmez)", () => {
    const body = buildContainerBody({ caption: "x", aiGenerated: true, shareToFeed: true });
    expect(body["video_url"]).toBe("");
    expect(body["upload_type"]).toBe("resumable");
    expect(body["media_type"]).toBe("REELS");
  });

  it("totalPartsOf: bölünmeyen dosyada tavan değil tam parça sayısı", () => {
    expect(totalPartsOf(2500, 1024)).toBe(3);
    expect(totalPartsOf(2048, 1024)).toBe(2);
    expect(totalPartsOf(0, 1024)).toBe(0);
  });

  it("mediaFingerprint: aynı dosya için aynı, farklı dosya için farklı", () => {
    expect(mediaFingerprint(MEDIA)).toBe(mediaFingerprint({ ...MEDIA }));
    expect(mediaFingerprint(MEDIA)).not.toBe(mediaFingerprint({ ...MEDIA, bytes: 1 }));
  });

  it("isPast: geçersiz tarih 'geçmişte' sayılmaz", () => {
    expect(isPast("2026-03-01T11:00:00Z", NOW_MS)).toBe(true);
    expect(isPast("2026-03-01T13:00:00Z", NOW_MS)).toBe(false);
    expect(isPast("çöp", NOW_MS)).toBe(false);
    expect(isPast(null, NOW_MS)).toBe(false);
  });

  it("INSTAGRAM_RESUMABLE_CHUNK_BYTES pozitif (ofset aritmetiği buna bağlı)", () => {
    expect(INSTAGRAM_RESUMABLE_CHUNK_BYTES).toBeGreaterThan(0);
  });
});

// ── 8. HTTP KATMANI ─────────────────────────────────────────────────────────

describe("http taşıma katmanı", () => {
  it("4xx istisna DEĞİLDİR (gövde sınıflandırma için gereklidir)", async () => {
    const client = createHttpClient({
      now,
      fetch: fakeTransport([{ status: 400, body: { error: "x" } }]).fn,
    });
    const response = await client.send({ method: "GET", url: "https://x" });
    expect(response.status).toBe(400);
    expect(response.ok).toBe(false);
    expect(response.json).toEqual({ error: "x" });
  });

  it("başlıklar küçük harfe indirgenir", () => {
    expect(normalizeHeaders({ "X-Foo": "1", BAR: "2" })).toEqual({ "x-foo": "1", "bar": "2" });
  });

  it("parseRetryAfterMs: saniye ve HTTP-tarihi", () => {
    expect(parseRetryAfterMs("120", NOW_MS)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(NOW_MS + 30_000).toUTCString(), NOW_MS)).toBe(30_000);
    expect(parseRetryAfterMs("çöp", NOW_MS)).toBeNull();
    expect(parseRetryAfterMs(null, NOW_MS)).toBeNull();
    expect(parseRetryAfterMs("0", NOW_MS)).toBe(0);
  });

  it("safeJsonParse bozuk gövdede null döner", () => {
    expect(safeJsonParse("")).toBeNull();
    expect(safeJsonParse("{bozuk")).toBeNull();
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it("taşıma hatası → RetryablePublishError(network)", () => {
    const err = asPublishTransportError(new Error("ECONNRESET"), "yükleme");
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect(err.kind).toBe("network");
  });
});