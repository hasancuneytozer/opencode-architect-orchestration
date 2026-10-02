/**
 * TikTok yayın adaptörü testleri (2/2) — `startPublish`, `uploadParts`,
 * `pollPublish`, `readQuota`, `isConfigured`.
 *
 * HİÇBİR TEST AĞA ÇIKMAZ: taşıma daima `fixtures.ts`'teki sahte işlevdir ve
 * gerçek `Response` nesneleri döndürür (ayrıştırma ve başlık toplama yolu da
 * testte çalışır). `openRange` de enjekte edilir; `node:fs` hiç çalışmaz.
 *
 * Beş kanıt sütunu:
 *   1) AKIŞ — `creator_info` → `init` sırası ve `init` gövdesinin alanları.
 *   2) MÜKERRER — aynı `idempotencyKey` ikinci `publish_id` AÇMAZ.
 *   3) PARÇA — yalnız SIRADAKİ parça, doğru `Content-Range`, 206/201 ayrımı,
 *      403 → kalıcı `container_expired`, 416 → kalıcı `validation`, 5xx → geçici.
 *   4) YOKLAMA — `PROCESSING_UPLOAD` → `processing` + `retryAfterMs ≥ 2000`,
 *      `PUBLISH_COMPLETE` → `remoteId` + `permalink: null`, `FAILED` →
 *      `mapTikTokFailReason` sınıflandırması.
 *   5) DÜRÜST YANIT — `readQuota` `null` döner ve AĞ İSTEĞİ ATMAMAZ.
 */
import { describe, expect, it } from "vitest";
import { PermanentPublishError, RetryablePublishError } from "../../../src/ports/index.js";
import {
  TIKTOK_CHUNK_MIN_BYTES,
  TIKTOK_STATUS_POLL_MS,
  TIKTOK_SOURCE_FILE_UPLOAD,
  TikTokPublishAdapter,
  classifyTikTokFailure,
  parseTikTokError,
} from "../../../src/adapters/tiktok/publisher.js";
import { isConfigured, missingConfigKeys } from "../../../src/adapters/tiktok/index.js";
import {
  ACCOUNT,
  CREATOR_INFO_BODY,
  INIT_BODY,
  NOW_MS,
  PUBLISH_ID,
  PUBLISH_ID_2,
  PUBLIC_POST_ID,
  UPLOAD_EXPIRES_ISO,
  UPLOAD_URL,
  VIDEO_ID,
  callAt,
  countingRange,
  makeInput,
  mediaInfo,
  mediaRef,
  pollContext,
  sentJson,
  session,
  transport,
  type FakeResponse,
} from "./fixtures.js";

const MB = 1024 * 1024;

/** `startPublish` için iki yanıt: creator_info + init. */
function startResponses(over: { creator?: FakeResponse; init?: FakeResponse } = {}): FakeResponse[] {
  return [
    over.creator ?? { status: 200, body: CREATOR_INFO_BODY },
    over.init ?? { status: 200, body: INIT_BODY },
  ];
}

interface Harness {
  adapter: TikTokPublishAdapter;
  calls: ReturnType<typeof transport>["calls"];
  ranges: ReturnType<typeof countingRange>["ranges"];
}

/** `openRange` sahte okuyucu + sahte taşıma ile donatılmış adaptör. */
function harness(responses: FakeResponse[], over: { partSizeBytes?: number } = {}): Harness {
  const { fn, calls } = transport(responses);
  const { openRange, ranges } = countingRange();
  const adapter = new TikTokPublishAdapter({
    now: () => NOW_MS,
    fetch: fn,
    ...(over.partSizeBytes === undefined ? {} : { partSizeBytes: over.partSizeBytes }),
    openRange,
  });
  return { adapter, calls, ranges };
}

// ── 1) startPublish ──────────────────────────────────────────────────────────

describe("startPublish", () => {
  it("creator_info önce, init sonra çağrılır (yayın öncesi ZORUNLU)", async () => {
    const { adapter, calls } = harness(startResponses());
    await adapter.startPublish(makeInput());
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/post/publish/creator_info/query/");
    expect(calls[1]?.url).toContain("/post/publish/video/init/");
  });

  it("init gövdesi: FILE_UPLOAD, privacy_level, title, is_aigc, video_size", async () => {
    const { adapter, calls } = harness(startResponses());
    await adapter.startPublish(makeInput());
    const body = sentJson(callAt(calls, 1));
    expect((body["source_info"] as Record<string, unknown>)["source"]).toBe(
      TIKTOK_SOURCE_FILE_UPLOAD,
    );
    const post = body["post_info"] as Record<string, unknown>;
    expect(post["privacy_level"]).toBe("PUBLIC_TO_EVERYONE");
    expect(post["title"]).toBe("Yaz indirimi bugün sona eriyor #kampanya #yaz");
    expect(post["is_aigc"]).toBe(true);
    expect(body["video_size"]).toBe(30_000_000);
  });

  it("çok parçalı medyada init gövdesi: chunk_size, total_chunk_count ve kapak ms'i", async () => {
    // Neden 200 MB: `total_chunk_count = floor(size/chunk)` ve `count === 1` ise
    // `chunk_size = video_size` yapılır (TEK PARÇA kuralı). Varsayılan 30 MB
    // medya 16 MiB chunk'tan küçük olduğu için `floor = 1` → tek parça dalına
    // düşer ve `chunk_size` 30 MB olur; `chunk_size` sabitini ölçemezdik. O dal
    // ayrıca "5 MB altı dosya tek parça olarak bildirilir" testinde kilitlidir.
    const size = 200 * MB;
    const chunk = 16 * MB;
    const { adapter, calls } = harness(startResponses());
    await adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const body = sentJson(callAt(calls, 1));
    expect(body["chunk_size"]).toBe(chunk);
    expect(body["total_chunk_count"]).toBe(Math.floor(size / chunk));
    expect(body["total_chunk_count"]).toBeGreaterThan(1);
    expect((body["post_info"] as Record<string, unknown>)["video_cover_timestamp_ms"]).toBe(10_500);
  });

  it("StartResult.uploadUrl: externalId = publish_id, expiresAt = +1 saat", async () => {
    const { adapter } = harness(startResponses());
    const result = await adapter.startPublish(makeInput());
    expect(result.kind).toBe("uploadUrl");
    if (result.kind !== "uploadUrl") throw new Error("beklenmeyen sonuç");
    expect(result.externalId).toBe(PUBLISH_ID);
    expect(result.uploadUrl).toBe(UPLOAD_URL);
    expect(result.expiresAt).toBe(UPLOAD_EXPIRES_ISO);
    expect(result.state).toBe("processing");
  });

  it("her çağrıda Authorization: Bearer taşınır", async () => {
    const { adapter, calls } = harness(startResponses());
    await adapter.startPublish(makeInput());
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${ACCOUNT.accessToken}`);
  });

  it("hesapta SELF_ONLY yoksa public isteği → kalıcı policy, init ÇAĞRILMAZ", async () => {
    const { adapter, calls } = harness(
      startResponses({
        creator: {
          status: 200,
          body: { code: 0, data: { max_video_post_duration_sec: 600, privacy_level_options: ["SELF_ONLY"] } },
        },
      }),
    );
    await expect(adapter.startPublish(makeInput())).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "policy",
      providerCode: "privacy_level_option_mismatch",
    });
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(0);
  });

  it("hesap limiti aşılan süre → kalıcı media_rejected, init ÇAĞRILMAZ", async () => {
    const { adapter, calls } = harness(
      startResponses({
        creator: {
          status: 200,
          body: {
            code: 0,
            data: { max_video_post_duration_sec: 15, privacy_level_options: ["PUBLIC_TO_EVERYONE"] },
          },
        },
      }),
    );
    await expect(
      adapter.startPublish(makeInput({ media: mediaRef({ info: mediaInfo({ durationSec: 30 }) }) })),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "media_rejected",
      providerCode: "duration_check_failed",
    });
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(0);
  });

  it("idempotencyKey ile İKİNCİ startPublish yeni publish_id AÇMAZ", async () => {
    const { adapter, calls } = harness(startResponses());
    const first = await adapter.startPublish(makeInput());
    const second = await adapter.startPublish(makeInput());
    if (first.kind !== "uploadUrl" || second.kind !== "uploadUrl") throw new Error("beklenmeyen sonuç");
    expect(second.externalId).toBe(first.externalId);
    expect(second.uploadUrl).toBe(first.uploadUrl);
    // Yalnız ilk turda iki istek (creator_info + init) yapıldı.
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("FARKLI dosya aynı anahtarla gelirse yeni init AÇILIR", async () => {
    const { adapter, calls } = harness([
      { status: 200, body: CREATOR_INFO_BODY },
      { status: 200, body: INIT_BODY },
      { status: 200, body: CREATOR_INFO_BODY },
      { status: 200, body: { code: 0, data: { publish_id: PUBLISH_ID_2, upload_url: UPLOAD_URL } } },
    ]);
    const first = await adapter.startPublish(makeInput());
    const second = await adapter.startPublish(
      makeInput({ media: mediaRef({ storageKey: "uploads/ba/ba/baska.mp4" }) }),
    );
    if (first.kind !== "uploadUrl" || second.kind !== "uploadUrl") throw new Error("beklenmeyen sonuç");
    expect(second.externalId).toBe(PUBLISH_ID_2);
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(2);
  });

  it("200 geldi ama publish_id yoksa GEÇİCİ hata (bayt gönderilmedi)", async () => {
    const { adapter } = harness(
      startResponses({ init: { status: 200, body: { code: 0, message: "success", data: {} } } }),
    );
    await expect(adapter.startPublish(makeInput())).rejects.toMatchObject({
      name: "RetryablePublishError",
      kind: "transient",
      providerCode: "missing_publish_id",
    });
  });

  it("denetimsiz istemci 403'ü kalıcı policy olarak sınıflandırır", async () => {
    const { adapter } = harness(
      startResponses({
        init: {
          status: 403,
          body: {
            code: 40301,
            message: "unaudited_client_can_only_post_to_private_accounts",
            log_id: "20260824120000abc",
          },
        },
      }),
    );
    await expect(adapter.startPublish(makeInput())).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "policy",
      logId: "20260824120000abc",
    });
  });

  it("boş dosyada init ÇAĞRILMAZ (media_rejected)", async () => {
    const { adapter, calls } = harness(startResponses());
    await expect(
      adapter.startPublish(makeInput({ media: mediaRef({ bytes: 0, info: mediaInfo({ bytes: 0 }) }) })),
    ).rejects.toMatchObject({ name: "PermanentPublishError", kind: "media_rejected" });
    expect(calls).toHaveLength(0);
  });

  it("caption 2200'ü aşarsa init ÇAĞRILMAZ (metin kırpılmaz)", async () => {
    const { adapter, calls } = harness(startResponses());
    await expect(
      adapter.startPublish(
        makeInput({
          copy: { ...makeInput().copy, caption: "a".repeat(2201) },
        }),
      ),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "validation",
      providerCode: "caption_too_long",
    });
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(0);
  });

  it("5 MB altı dosya tek parça olarak bildirilir", async () => {
    const size = 4 * MB;
    const { adapter, calls } = harness(startResponses());
    await adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const body = sentJson(callAt(calls, 1));
    expect(body["chunk_size"]).toBe(size);
    expect(body["total_chunk_count"]).toBe(1);
  });

  it("parça boyutu seçeneği init gövdesine yansır (5 MB'a kırpılır)", async () => {
    const { adapter, calls } = harness(startResponses(), { partSizeBytes: 1024 });
    await adapter.startPublish(makeInput());
    expect(sentJson(callAt(calls, 1))["chunk_size"]).toBe(TIKTOK_CHUNK_MIN_BYTES);
  });
});

// ── 2) getCreatorOptions ────────────────────────────────────────────────────

describe("getCreatorOptions", () => {
  it("süre sınırı ve gizlilik seçeneklerini döner", async () => {
    const { adapter } = harness([{ status: 200, body: CREATOR_INFO_BODY }]);
    const options = await adapter.getCreatorOptions(ACCOUNT);
    expect(options.maxVideoPostDurationSec).toBe(600);
    expect(options.privacyLevelOptions).toContain("PUBLIC_TO_EVERYONE");
  });

  it("401 → kalıcı auth (yeniden yetkilendirme gerekir)", async () => {
    const { adapter } = harness([
      { status: 401, body: { error: "access_token_invalid", log_id: "l1" } },
    ]);
    await expect(adapter.getCreatorOptions(ACCOUNT)).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "auth",
    });
  });
});

// ── 3) uploadParts ──────────────────────────────────────────────────────────

describe("uploadParts", () => {
  /** Oturum açılmış bir adaptör + oturum. */
  async function opened(over: { partSizeBytes?: number } = {}): Promise<Harness> {
    const h = harness(startResponses(), over);
    await h.adapter.startPublish(makeInput());
    return h;
  }

  it("4 MB tek parça: bytes 0-4194303/4194304 + Content-Type: video/mp4", async () => {
    const size = 4 * MB;
    const h = harness([...startResponses(), { status: 201 }]);
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const progress = await h.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session(),
    );
    const put = callAt(h.calls, h.calls.length - 1);
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(UPLOAD_URL);
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(put.headers["content-range"]).toBe("bytes 0-4194303/4194304");
    expect(put.headers["content-length"]).toBe(String(size));
    expect(progress.done).toBe(true);
    expect(progress.uploadedParts).toBe(1);
    expect(progress.totalParts).toBe(1);
  });

  it("uploadedParts=2 ise ÜÇÜNCÜ parça gönderilir (2. değil, 1. değil)", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    const h = harness([...startResponses(), { status: 206 }], { partSizeBytes: chunk });
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const before = h.calls.length;
    const progress = await h.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: 2 }),
    );
    const put = callAt(h.calls, before);
    expect(h.calls.length).toBe(before + 1);
    expect(put.headers["content-range"]).toBe(`bytes ${2 * chunk}-${3 * chunk - 1}/${size}`);
    expect(progress.uploadedParts).toBe(3);
    expect(progress.done).toBe(false);
    expect(progress.nextOffset).toBe(3 * chunk);
  });

  it("bayt okuyucu doğru ofsetten doğru uzunlukta çağrılır", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    const h = harness([...startResponses(), { status: 206 }], { partSizeBytes: chunk });
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    h.ranges.length = 0;
    await h.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: 1 }),
    );
    expect(h.ranges).toEqual([
      { storageKey: "uploads/ab/cd/klip.mp4", offset: chunk, length: chunk },
    ]);
  });

  it("206 → done:false, 201 → done:true", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    const mid = harness([...startResponses(), { status: 206 }], { partSizeBytes: chunk });
    await mid.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const midProgress = await mid.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: 0 }),
    );
    expect(midProgress.done).toBe(false);

    const done = harness([...startResponses(), { status: 201 }], { partSizeBytes: chunk });
    await done.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const lastIndex = Math.floor(size / chunk) - 1;
    const lastProgress = await done.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: lastIndex }),
    );
    expect(lastProgress.done).toBe(true);
    expect(lastProgress.uploadedParts).toBe(lastIndex + 1);
    expect(lastProgress.nextOffset).toBeNull();
  });

  it("SON parça kalanın tamamını taşır (bayt atlanmaz)", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    const h = harness([...startResponses(), { status: 201 }], { partSizeBytes: chunk });
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const lastIndex = Math.floor(size / chunk) - 1;
    h.ranges.length = 0;
    await h.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: lastIndex }),
    );
    const range = h.ranges[0] as { offset: number; length: number };
    expect(range.offset + range.length).toBe(size);
  });

  it("tüm parçalar gönderilmişse YENİ İSTEK ATILMAZ", async () => {
    const size = 4 * MB;
    const h = harness([...startResponses()]);
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    const before = h.calls.length;
    const progress = await h.adapter.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: 1 }),
    );
    expect(h.calls.length).toBe(before);
    expect(progress.done).toBe(true);
  });

  it("403 → kalıcı container_expired (upload_url süresi doldu)", async () => {
    // Gövde DÜZ METİN: imzalı depolama adresi (TOS) hataları XML döner, JSON
    // değil. Makine okunur bir kod AYRIŞTIRILAMADIĞI için `providerCode` dokümanlanmış
    // yedeğe (`upload_url_expired`) düşer — kod uydurulmaz.
    const size = 4 * MB;
    const h = harness([
      ...startResponses(),
      { status: 403, raw: "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>" },
    ]);
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    await expect(
      h.adapter.uploadParts(makeInput({ media: mediaRef({ bytes: size }) }), session()),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "container_expired",
      providerCode: "upload_url_expired",
    });
  });

  it("yükleme 403'ü API 403'ünden AYRIŞIR (aynı HTTP kodu, farklı karar)", async () => {
    // Aynı 403 iki bağlamda İKİ FARKLI karar verir: yükleme adresinde kalıcı
    // `container_expired` (bayt gönderilemez), API ucunda kalıcı `policy`
    // (token/politika kararı). Bu ayrım yanlışlıkla birleştirilirse ya da
    // yayın gereksiz yere kapatılır ya da süresi dolmuş `upload_url` ile
    // dakikalarca yeniden denenir.
    const size = 4 * MB;
    const upload = harness([...startResponses(), { status: 403, raw: "expired" }]);
    await upload.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    await expect(
      upload.adapter.uploadParts(makeInput({ media: mediaRef({ bytes: size }) }), session()),
    ).rejects.toMatchObject({ kind: "container_expired" });

    const api = harness([{ status: 403, body: { error: "forbidden" } }]);
    await expect(api.adapter.getCreatorOptions(ACCOUNT)).rejects.toMatchObject({
      kind: "policy",
      providerCode: "forbidden",
    });
  });

  it("416 → kalıcı validation (Content-Range ilerlemeyi yansıtmıyor)", async () => {
    const size = 200 * MB;
    const h = harness([...startResponses(), { status: 416 }], { partSizeBytes: 6 * MB });
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    await expect(
      h.adapter.uploadParts(makeInput({ media: mediaRef({ bytes: size }) }), session()),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "validation",
      providerCode: "content_range_rejected",
    });
  });

  it("5xx → GEÇİCİ server (parça yeniden gönderilir)", async () => {
    const size = 4 * MB;
    const h = harness([...startResponses(), { status: 503, body: { error: "internal_error" } }]);
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    await expect(
      h.adapter.uploadParts(makeInput({ media: mediaRef({ bytes: size }) }), session()),
    ).rejects.toMatchObject({ name: "RetryablePublishError", kind: "server" });
  });

  it("bayt okuyucu yoksa kalıcı validation (sessizce başarılı olmaz)", async () => {
    const { fn } = transport(startResponses());
    const adapter = new TikTokPublishAdapter({ now: () => NOW_MS, fetch: fn });
    await expect(adapter.uploadParts(makeInput(), session())).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "validation",
      providerCode: "range_source_missing",
    });
  });

  it("oturumdaki parça boyutu init ile çelişirse kalıcı hata", async () => {
    const size = 200 * MB;
    const h = harness([...startResponses(), { status: 206 }], { partSizeBytes: 6 * MB });
    await h.adapter.startPublish(makeInput({ media: mediaRef({ bytes: size }) }));
    await expect(
      h.adapter.uploadParts(
        makeInput({ media: mediaRef({ bytes: size }) }),
        session({ partSizeBytes: 8 * MB }),
      ),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      providerCode: "chunk_size_mismatch",
    });
  });

  it("süreç yeniden başlamışsa totalParts çapraz denetimi çalışır", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    // YENİ adaptör: oturum haritası boş (süreç yeniden başlamış gibi).
    const { fn, calls } = transport([{ status: 206 }]);
    const { openRange } = countingRange();
    const fresh = new TikTokPublishAdapter({
      now: () => NOW_MS,
      fetch: fn,
      partSizeBytes: chunk,
      openRange,
    });
    await expect(
      fresh.uploadParts(makeInput({ media: mediaRef({ bytes: size }) }), session({ totalParts: 3 })),
    ).rejects.toMatchObject({
      name: "PermanentPublishError",
      providerCode: "chunk_count_mismatch",
    });
    expect(calls).toHaveLength(0);
  });

  it("süreç yeniden başlamış ama totalParts UYUŞUYORSA yüklemeye devam eder", async () => {
    const size = 200 * MB;
    const chunk = 6 * MB;
    const totalParts = Math.floor(size / chunk);
    const { fn } = transport([{ status: 206 }]);
    const { openRange } = countingRange();
    const fresh = new TikTokPublishAdapter({
      now: () => NOW_MS,
      fetch: fn,
      partSizeBytes: chunk,
      openRange,
    });
    const progress = await fresh.uploadParts(
      makeInput({ media: mediaRef({ bytes: size }) }),
      session({ uploadedParts: 2, totalParts }),
    );
    expect(progress.uploadedParts).toBe(3);
    expect(progress.totalParts).toBe(totalParts);
  });
});

// ── 4) pollPublish ──────────────────────────────────────────────────────────

describe("pollPublish", () => {
  it("PROCESSING_UPLOAD → processing ve retryAfterMs ≥ 2000", async () => {
    const { adapter } = harness([{ status: 200, body: { publish_id: PUBLISH_ID, status: "PROCESSING_UPLOAD" } }]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.state).toBe("processing");
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(2000);
    expect(result.retryAfterMs).toBe(TIKTOK_STATUS_POLL_MS);
    expect(result.providerStatus).toBe("PROCESSING_UPLOAD");
  });

  it("SEND_TO_USER_INBOX da işleniyor sayılır", async () => {
    const { adapter } = harness([{ status: 200, body: { status: "SEND_TO_USER_INBOX" } }]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.state).toBe("processing");
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(2000);
  });

  it("küçük Retry-After bile 2 saniyenin altına indirilmez", async () => {
    const { adapter } = harness([
      { status: 200, headers: { "retry-after": "0" }, body: { status: "PROCESSING_DOWNLOAD" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(2000);
  });

  it("büyük Retry-After AŞILMAZ (değer dikkate alınır)", async () => {
    const { adapter } = harness([
      { status: 200, headers: { "retry-after": "30" }, body: { status: "PROCESSING_UPLOAD" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("PUBLISH_COMPLETE → published + remoteId + permalink NULL", async () => {
    const { adapter } = harness([
      {
        status: 200,
        body: {
          publish_id: PUBLISH_ID,
          status: "PUBLISH_COMPLETE",
          publicaly_available_post_id: PUBLIC_POST_ID,
        },
      },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.state).toBe("published");
    expect(result.remoteId).toBe(PUBLIC_POST_ID);
    expect(result.permalink).toBeNull();
    expect(result.providerStatus).toBe("PUBLISH_COMPLETE");
  });

  it("publicaly_available_post_id yoksa video_id kullanılır", async () => {
    const { adapter } = harness([
      { status: 200, body: { status: "PUBLISH_COMPLETE", video_id: VIDEO_ID } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.remoteId).toBe(VIDEO_ID);
    expect(result.permalink).toBeNull();
  });

  it("FAILED + file_format_check_failed → mapTikTokFailReason (media_rejected)", async () => {
    const { adapter } = harness([
      { status: 200, body: { status: "FAILED", fail_reason: "file_format_check_failed" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.state).toBe("processing");
    expect(result.error?.kind).toBe("media_rejected");
    expect(result.error?.providerCode).toBe("file_format_check_failed");
  });

  it("FAILED + internal → mapTikTokFailReason (transient)", async () => {
    const { adapter } = harness([
      { status: 200, body: { status: "FAILED", fail_reason: "internal" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error?.kind).toBe("transient");
  });

  it("FAILED + spam_risk_too_many_posts → kalıcı quota", async () => {
    const { adapter } = harness([
      { status: 200, body: { status: "FAILED", fail_reason: "spam_risk_too_many_posts" } },
    ]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error?.kind).toBe("quota");
    expect(result.providerStatus).toContain("spam_risk_too_many_posts");
  });

  it("bilinmeyen durum kodu → unknown + kalıcı kabul", async () => {
    const { adapter } = harness([{ status: 200, body: { status: "WAT" } }]);
    const result = await adapter.pollPublish(pollContext());
    expect(result.error?.kind).toBe("unknown");
  });

  it("externalId boşsa kalıcı validation", async () => {
    const { adapter } = harness([{ status: 200, body: { status: "PUBLISH_COMPLETE" } }]);
    await expect(adapter.pollPublish(pollContext({ externalId: null }))).rejects.toMatchObject({
      name: "PermanentPublishError",
      kind: "validation",
      providerCode: "unknown_external_id",
    });
  });

  it("upload_url süresi dolmuş olsa da yoklama YAPILIR (yayın geri alınamaz)", async () => {
    const { adapter, calls } = harness([
      { status: 200, body: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: PUBLIC_POST_ID } },
    ]);
    const result = await adapter.pollPublish(pollContext({ uploadUrlExpiresAt: "2026-08-24T09:00:00.000Z" }));
    expect(result.state).toBe("published");
    expect(calls).toHaveLength(1);
  });
});

// ── 5) Hata sınıflandırma ve kota ───────────────────────────────────────────

describe("classifyTikTokFailure", () => {
  function response(status: number, json: unknown): Parameters<typeof classifyTikTokFailure>[0] {
    return {
      status,
      ok: false,
      headers: {},
      body: JSON.stringify(json),
      json,
      retryAfterMs: null,
    };
  }

  it("429 → geçici ratelimit", () => {
    const err = classifyTikTokFailure(response(429, { error: "too_many_requests" }), "x");
    expect(err).toBeInstanceOf(RetryablePublishError);
    expect((err as RetryablePublishError).kind).toBe("ratelimit");
  });

  it("5xx → geçici server", () => {
    const err = classifyTikTokFailure(response(500, { message: "boom" }), "x");
    expect((err as RetryablePublishError).kind).toBe("server");
  });

  it("401 → kalıcı auth", () => {
    const err = classifyTikTokFailure(response(401, { error: "access_token_expired" }), "x");
    expect(err).toBeInstanceOf(PermanentPublishError);
    expect((err as PermanentPublishError).kind).toBe("auth");
  });

  it("yükleme 410 → kalıcı container_expired", () => {
    const err = classifyTikTokFailure(response(410, { error: "expired" }), "x", { upload: true });
    expect((err as PermanentPublishError).kind).toBe("container_expired");
  });

  it("log_id hata nesnesine taşınır (destek talebi)", () => {
    const err = classifyTikTokFailure(response(400, { log_id: "L9", message: "bad" }), "x");
    expect((err as PermanentPublishError).logId).toBe("L9");
  });

  it("bozuk JSON'da alan UYDURULMAZ", () => {
    const info = parseTikTokError(null, "not json at all");
    expect(info.code).toBeNull();
    expect(info.logId).toBeNull();
    expect(info.description).toContain("not json");
  });
});

describe("readQuota", () => {
  it("null döner ve AĞ İSTEĞİ ATMAMAZ", async () => {
    const { fn, calls } = transport([{ status: 200, body: {} }]);
    const adapter = new TikTokPublishAdapter({ now: () => NOW_MS, fetch: fn });
    const quota = await adapter.readQuota(ACCOUNT);
    expect(quota).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// ── 6) Yapılandırma ─────────────────────────────────────────────────────────

describe("isConfigured / missingConfigKeys", () => {
  const full = { clientKey: "k", clientSecret: "s", redirectUri: "https://app.test/cb" };

  it("üç alan da varsa yapılandırılmıştır", () => {
    expect(isConfigured(full)).toBe(true);
    expect(missingConfigKeys(full)).toEqual([]);
  });

  it("eksik alanlar ORTAM DEĞİŞKENİ ADIYLA bildirilir", () => {
    expect(missingConfigKeys({ ...full, clientKey: null })).toEqual(["SP_TIKTOK_CLIENT_KEY"]);
    expect(missingConfigKeys({ ...full, clientSecret: "  " })).toEqual(["SP_TIKTOK_CLIENT_SECRET"]);
    expect(missingConfigKeys(null)).toEqual([
      "SP_TIKTOK_CLIENT_KEY",
      "SP_TIKTOK_CLIENT_SECRET",
      "SP_TIKTOK_REDIRECT_URI",
    ]);
    expect(isConfigured(null)).toBe(false);
  });
});
