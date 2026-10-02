/**
 * TikTok yayın adaptörü testleri (1/2) — saf parça planı, gövde kurucular,
 * yanıt okuyucuları ve `precheck`.
 *
 * HİÇBİR TEST AĞA ÇIKMAZ: bu dosyada ağ YOKTUR; yalnız saf fonksiyonlar ve
 * ağ çağrısı yapmayan `precheck` ölçülür. (Akış testleri `flow.test.ts` içindedir.)
 *
 * Dört kanıt sütunu:
 *   1) PARÇA PLANI — `floor(size/chunk)` bağı, 4 MB → tek parça, 200 MB → çok
 *      parça (ara parça ≤64 MB, son parça ≤128 MB).
 *   2) OFSET ARİTMETİĞİ — parça uzunluklarının TOPLAMI dosya boyutudur
 *      (bayt atlanmaz, bayt tekrarlanmaz).
 *   3) GÖVDE — `FILE_UPLOAD`, `privacy_level`, `title`, `is_aigc`,
 *      `video_size`, `chunk_size`, `total_chunk_count`, kapak zaman damgası.
 *   4) DÜRÜST YANIT — 9:16 TikTok'ta HATA DEĞİL (warning), hesap limiti
 *      `precheck`'te doğrulanamaz (bilgi olarak bildirilir), eksik alan
 *      UYDURULMAZ.
 */
import { describe, expect, it } from "vitest";
import {
  TIKTOK_CAPTION_MAX_CHARS,
  TIKTOK_CHUNK_MAX_BYTES,
  TIKTOK_CHUNK_MIN_BYTES,
  TIKTOK_DEFAULT_CHUNK_BYTES,
  TIKTOK_LAST_CHUNK_MAX_BYTES,
  TIKTOK_MAX_CHUNK_COUNT,
  TIKTOK_PRIVACY_LEVELS,
  TIKTOK_SOURCE_FILE_UPLOAD,
  TikTokPublishAdapter,
  buildInitBody,
  buildStatusBody,
  buildTitle,
  chunkRange,
  coverTimestampMs,
  creatorInfoUrl,
  planChunks,
  privacyLevelFor,
  privacyLevelProblem,
  readCreatorOptions,
  readInitRef,
  readStatusView,
  statusFetchUrl,
  videoInitUrl,
} from "../../../src/adapters/tiktok/publisher.js";
import { NOW_MS, countingRange, mediaInfo, mediaRef, makeInput, transport, UPLOAD_URL } from "./fixtures.js";
import { COPY } from "./fixtures.js";

const MB = 1024 * 1024;

/** `precheck` ağ çağrısı yapmaz; taşıma yine de verilir (savunma). */
function adapter(over: { partSizeBytes?: number } = {}): TikTokPublishAdapter {
  const { fn } = transport([{ status: 200, body: {} }]);
  return new TikTokPublishAdapter({
    now: () => NOW_MS,
    fetch: fn,
    ...(over.partSizeBytes === undefined ? {} : { partSizeBytes: over.partSizeBytes }),
    openRange: countingRange().openRange,
  });
}

// ── 1) Parça planı ──────────────────────────────────────────────────────────

describe("planChunks — parça boyutu seçimi", () => {
  it("4 MB video TEK parça olur (5 MB altı kuralı)", () => {
    const size = 4 * MB;
    const plan = planChunks(size);
    expect(plan.problem).toBeNull();
    expect(plan.single).toBe(true);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(size);
  });

  it("200 MB çok parçaya bölünür ve floor(size/chunk) bağı korunur", () => {
    const size = 200 * MB;
    const plan = planChunks(size);
    expect(plan.problem).toBeNull();
    expect(plan.single).toBe(false);
    expect(plan.totalChunkCount).toBeGreaterThan(1);
    // Dokümanın verdiği formül birebir uygulanır.
    expect(plan.totalChunkCount).toBe(Math.floor(size / plan.chunkSize));
    expect(plan.chunkSize).toBeLessThanOrEqual(TIKTOK_CHUNK_MAX_BYTES);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(TIKTOK_CHUNK_MIN_BYTES);
  });

  it("200 MB için ARA parçalar ≤64 MB, SON parça ≤128 MB", () => {
    const size = 200 * MB;
    const plan = planChunks(size);
    for (let i = 0; i < plan.totalChunkCount - 1; i += 1) {
      const range = chunkRange(plan, size, i);
      expect(range.length).toBeLessThanOrEqual(TIKTOK_CHUNK_MAX_BYTES);
      expect(range.final).toBe(false);
    }
    const last = chunkRange(plan, size, plan.totalChunkCount - 1);
    expect(last.final).toBe(true);
    expect(last.length).toBeLessThanOrEqual(TIKTOK_LAST_CHUNK_MAX_BYTES);
    // `floor` formülü yüzünden son parça EN BÜYÜK parçadır: `son ∈ [chunk, 2·chunk)`.
    expect(last.length).toBeGreaterThanOrEqual(plan.chunkSize);
  });

  it("varsayılan parça boyutu 16 MiB ve 5-64 MB aralığındadır", () => {
    const plan = planChunks(200 * MB);
    expect(plan.chunkSize).toBe(TIKTOK_DEFAULT_CHUNK_BYTES);
    expect(TIKTOK_DEFAULT_CHUNK_BYTES).toBeGreaterThanOrEqual(TIKTOK_CHUNK_MIN_BYTES);
    expect(TIKTOK_DEFAULT_CHUNK_BYTES).toBeLessThanOrEqual(TIKTOK_CHUNK_MAX_BYTES);
  });

  it("parça uzunluklarının TOPLAMI dosya boyutuna eşittir (bayt atlanmaz)", () => {
    for (const size of [4 * MB, 5 * MB, 30_000_000, 64 * MB, 200 * MB, 512 * MB]) {
      const plan = planChunks(size);
      let covered = 0;
      for (let i = 0; i < plan.totalChunkCount; i += 1) {
        covered += chunkRange(plan, size, i).length;
      }
      expect(covered).toBe(size);
      expect(plan.totalChunkCount).toBe(Math.floor(size / plan.chunkSize));
    }
  });

  it("5 MB dosyada chunk_size dosyanın kendisi olur (kendi gövdemizle çelişmez)", () => {
    const plan = planChunks(5 * MB);
    expect(plan.chunkSize).toBe(5 * MB);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.single).toBe(true);
  });

  it("5 MB altı tercih 5 MB'a kırpılır (doküman alt sınırı)", () => {
    const plan = planChunks(512 * MB, 1 * MB);
    expect(plan.chunkSize).toBe(TIKTOK_CHUNK_MIN_BYTES);
    expect(plan.totalChunkCount).toBe(Math.floor((512 * MB) / TIKTOK_CHUNK_MIN_BYTES));
  });

  it("64 MB üstü tercih 64 MB'a kırpılır", () => {
    const plan = planChunks(512 * MB, 256 * MB);
    expect(plan.chunkSize).toBe(TIKTOK_CHUNK_MAX_BYTES);
    expect(plan.totalChunkCount).toBe(Math.floor((512 * MB) / TIKTOK_CHUNK_MAX_BYTES));
  });

  it("boş dosya planlanamaz", () => {
    const plan = planChunks(0);
    expect(plan.problem).not.toBeNull();
    expect(plan.totalChunkCount).toBe(0);
  });

  it("1000 parça sınırı aşılırsa plan reddedilir (savunma)", () => {
    const plan = planChunks(5.5 * 1024 * MB, TIKTOK_CHUNK_MIN_BYTES);
    expect(plan.problem).not.toBeNull();
    expect(plan.problem).toContain(String(TIKTOK_MAX_CHUNK_COUNT));
  });
});

describe("chunkRange — Content-Range aritmetiği", () => {
  const plan = planChunks(200_000_000, 6 * MB);

  it("ilk parça offset 0'da başlar (brif örneği: bytes 0-6291455/200000000)", () => {
    const range = chunkRange(plan, 200_000_000, 0);
    expect(range.offset).toBe(0);
    expect(range.length).toBe(6 * MB);
    expect(range.contentRange).toBe("bytes 0-6291455/200000000");
  });

  it("ikinci parça offset = 1 × chunk_size", () => {
    const range = chunkRange(plan, 200_000_000, 1);
    expect(range.offset).toBe(6 * MB);
    expect(range.contentRange).toBe(`bytes ${6 * MB}-${2 * 6 * MB - 1}/200000000`);
  });

  it("son parça kalanın TAMAMINI alır ve dosyada biter", () => {
    const last = chunkRange(plan, 200_000_000, plan.totalChunkCount - 1);
    expect(last.final).toBe(true);
    expect(last.offset + last.length).toBe(200_000_000);
    expect(last.contentRange).toBe(`bytes ${last.offset}-${200_000_000 - 1}/200000000`);
  });

  it("tek parçalı planda ilk parça zaten sondur", () => {
    const single = planChunks(4 * MB);
    const range = chunkRange(single, 4 * MB, 0);
    expect(range.final).toBe(true);
    expect(range.contentRange).toBe("bytes 0-4194303/4194304");
  });
});

// ── 2) Kapak zaman damgası ──────────────────────────────────────────────────

describe("coverTimestampMs — yüzde → milisaniye", () => {
  it("30 saniyede %35 → 10 500 ms", () => {
    expect(coverTimestampMs(35, 30)).toBe(10_500);
  });

  it("süre bilinmiyorsa alan GÖNDERİLMEZ (null)", () => {
    expect(coverTimestampMs(35, null)).toBeNull();
    expect(coverTimestampMs(35, 0)).toBeNull();
  });

  it("yüzde 0-100 aralığına kırpılır", () => {
    expect(coverTimestampMs(120, 10)).toBe(10_000);
    expect(coverTimestampMs(-5, 10)).toBe(0);
  });

  it("ondalıklı süre yuvarlanır (tam ms)", () => {
    expect(coverTimestampMs(33, 12.5)).toBe(4_125);
  });
});

// ── 3) Gizlilik ─────────────────────────────────────────────────────────────

describe("privacy_level", () => {
  it("public → PUBLIC_TO_EVERYONE, private → SELF_ONLY", () => {
    expect(privacyLevelFor("public")).toBe("PUBLIC_TO_EVERYONE");
    expect(privacyLevelFor("private")).toBe("SELF_ONLY");
  });

  it("unlisted → MUTUAL_FOLLOW_FRIENDS (TikTok'ta tam karşılığı yok)", () => {
    expect(privacyLevelFor("unlisted")).toBe("MUTUAL_FOLLOW_FRIENDS");
  });

  it("hesap seçeneği sunuyorsa sorun yok", () => {
    expect(privacyLevelProblem("public", TIKTOK_PRIVACY_LEVELS)).toBeNull();
    expect(privacyLevelProblem("private", ["SELF_ONLY"])).toBeNull();
  });

  it("denetimsiz hesapta public isteği → AÇIKLAYICI politika hatası", () => {
    const problem = privacyLevelProblem("public", ["SELF_ONLY"]);
    expect(problem).not.toBeNull();
    expect(problem).toContain("denetim");
    expect(problem).toContain("SELF_ONLY");
  });

  it("seçenek listesinde yoksa sessizce başka değer SEÇİLMEZ", () => {
    const problem = privacyLevelProblem("public", ["SELF_ONLY", "FOLLOWER_OF_CREATOR"]);
    expect(problem).toContain("PUBLIC_TO_EVERYONE");
    expect(problem).toContain("SELF_ONLY, FOLLOWER_OF_CREATOR");
  });

  it("liste boşsa 'hesap bildirmiyor' denir, dört değer uydurulmaz", () => {
    expect(privacyLevelProblem("private", [])).toContain("hiçbir seçenek bildirmiyor");
  });
});

// ── 4) Gövde kurucuları ─────────────────────────────────────────────────────

describe("buildInitBody", () => {
  const body = buildInitBody({
    privacyLevel: "MUTUAL_FOLLOW_FRIENDS",
    title: "Yaz indirimi",
    aiGenerated: true,
    videoSizeBytes: 200_000_000,
    chunkSizeBytes: 6 * MB,
    totalChunkCount: 31,
    coverTimestampMs: 10_500,
  });

  it("source_info.source = FILE_UPLOAD (PULL_FROM_URL kullanılmaz)", () => {
    expect(TIKTOK_SOURCE_FILE_UPLOAD).toBe("FILE_UPLOAD");
    expect(body["source_info"]).toEqual({ source: "FILE_UPLOAD" });
  });

  it("post_info: privacy_level, title, is_aigc, video_cover_timestamp_ms", () => {
    const post = body["post_info"] as Record<string, unknown>;
    expect(post["privacy_level"]).toBe("MUTUAL_FOLLOW_FRIENDS");
    expect(post["title"]).toBe("Yaz indirimi");
    expect(post["is_aigc"]).toBe(true);
    expect(post["video_cover_timestamp_ms"]).toBe(10_500);
  });

  it("video_size, chunk_size, total_chunk_count gövdede", () => {
    expect(body["video_size"]).toBe(200_000_000);
    expect(body["chunk_size"]).toBe(6 * MB);
    expect(body["total_chunk_count"]).toBe(31);
  });

  it("süre bilinmiyorsa kapak alanı GÖNDERİLMEZ", () => {
    const withoutCover = buildInitBody({
      privacyLevel: "SELF_ONLY",
      title: "x",
      aiGenerated: false,
      videoSizeBytes: 1000,
      chunkSizeBytes: 1000,
      totalChunkCount: 1,
      coverTimestampMs: null,
    });
    expect(Object.keys(withoutCover["post_info"] as object)).not.toContain(
      "video_cover_timestamp_ms",
    );
  });

  it("is_aigc false bile AÇIKÇA gönderilir (alan yok bırakılmaz)", () => {
    const notAi = buildInitBody({
      privacyLevel: "SELF_ONLY",
      title: "x",
      aiGenerated: false,
      videoSizeBytes: 1000,
      chunkSizeBytes: 1000,
      totalChunkCount: 1,
      coverTimestampMs: null,
    });
    expect((notAi["post_info"] as Record<string, unknown>)["is_aigc"]).toBe(false);
  });
});

describe("buildTitle", () => {
  it("caption + hashtag'ler tek metinde birleşir", () => {
    const built = buildTitle("Yaz indirimi", ["#kampanya"]);
    expect(built.problem).toBeNull();
    expect(built.text).toBe("Yaz indirimi #kampanya");
  });

  it("2200 sınırı aşılırsa metin KIRPILMAZ, sorun döner", () => {
    const built = buildTitle("a".repeat(TIKTOK_CAPTION_MAX_CHARS + 1), []);
    expect(built.problem).not.toBeNull();
    expect(built.text).toBe("");
  });

  it("emoji iki UTF-16 birim sayılır (sınır dibinde ret edilebilir)", () => {
    // 1099 "x" + boşluk + "#a" = 1102 birim → sığar.
    expect(buildTitle("x".repeat(1099), ["#a"]).problem).toBeNull();
    // 2199 + boşluk + "#a" = 2202 birim → aşar.
    expect(buildTitle("x".repeat(2199), ["#a"]).problem).not.toBeNull();
  });
});

describe("uç nokta kurucuları", () => {
  it("üç uç nokta da /v2/ altında ve sonunda eğik çizgi var", () => {
    expect(creatorInfoUrl("https://x/v2")).toBe("https://x/v2/post/publish/creator_info/query/");
    expect(videoInitUrl("https://x/v2")).toBe("https://x/v2/post/publish/video/init/");
    expect(statusFetchUrl("https://x/v2")).toBe("https://x/v2/post/publish/status/fetch/");
  });

  it("status gövdesi publish_id taşır", () => {
    expect(buildStatusBody("v_pub_1")).toEqual({ publish_id: "v_pub_1" });
  });
});

// ── 5) Yanıt okuyucuları ────────────────────────────────────────────────────

describe("yanıt okuyucuları", () => {
  it("readInitRef data zarfından publish_id + upload_url okur", () => {
    const ref = readInitRef({
      code: 0,
      data: { publish_id: "v_pub_x", upload_url: "https://tos/x?sig=1" },
    });
    expect(ref).toEqual({ publishId: "v_pub_x", uploadUrl: "https://tos/x?sig=1" });
  });

  it("readInitRef eksik alanda null döner (kimlik uydurulmaz)", () => {
    expect(readInitRef({ code: 0, data: { publish_id: "v_pub_x" } })).toBeNull();
    expect(readInitRef(null)).toBeNull();
  });

  it("readCreatorOptions süre + tanınan gizlilik seçeneklerini okur", () => {
    const view = readCreatorOptions({
      data: {
        max_video_post_duration_sec: 600,
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY", "BILINMEYEN_DEGER"],
      },
    });
    expect(view.maxVideoPostDurationSec).toBe(600);
    expect(view.privacyLevelOptions).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
  });

  it("readCreatorOptions alan yoksa null/boş döner (uydurma yok)", () => {
    const view = readCreatorOptions({ code: 0, message: "success" });
    expect(view.maxVideoPostDurationSec).toBeNull();
    expect(view.privacyLevelOptions).toEqual([]);
  });

  it("readStatusView ham alanları okur (publicaly yazımı korunur)", () => {
    const view = readStatusView({
      publish_id: "v_pub_x",
      status: "PUBLISH_COMPLETE",
      publicaly_available_post_id: "7412",
    });
    expect(view.status).toBe("PUBLISH_COMPLETE");
    expect(view.publicPostId).toBe("7412");
    expect(view.failReason).toBeNull();
  });

  it("readStatusView data zarfını da destekler", () => {
    const view = readStatusView({ data: { status: "FAILED", fail_reason: "internal" } });
    expect(view.status).toBe("FAILED");
    expect(view.failReason).toBe("internal");
  });
});

// ── 6) precheck ─────────────────────────────────────────────────────────────

describe("precheck", () => {
  it("yatay video UYARI üretir, HATA DEĞİL (TikTok'ta aspect zorunlu değil)", async () => {
    const findings = await adapter().precheck(
      makeInput({ media: mediaRef({ info: mediaInfo({ width: 1920, height: 1080 }) }) }),
    );
    const aspect = findings.find((f) => f.code === "aspect_ratio");
    expect(aspect).toBeDefined();
    expect(aspect?.severity).toBe("warning");
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("2 saniyelik video HATA üretir (genel taban 3 sn)", async () => {
    const findings = await adapter().precheck(
      makeInput({ media: mediaRef({ info: mediaInfo({ durationSec: 2 }) }) }),
    );
    expect(findings.find((f) => f.code === "duration_min")?.severity).toBe("error");
  });

  it("5 GB dosya HATA üretir (sınır 4 GB)", async () => {
    const big = 5 * 1024 * MB;
    const findings = await adapter().precheck(
      makeInput({ media: mediaRef({ bytes: big, info: mediaInfo({ bytes: big }) }) }),
    );
    expect(findings.find((f) => f.code === "file_size")?.severity).toBe("error");
  });

  it("2200 karakteri aşan caption HATA üretir", async () => {
    const findings = await adapter().precheck(
      makeInput({ copy: { ...COPY, caption: "a".repeat(2201) } }),
    );
    expect(findings.find((f) => f.code === "caption_length")?.severity).toBe("error");
  });

  it("aiGenerated → is_aigc bildirimi info olarak üretilir", async () => {
    const findings = await adapter().precheck(makeInput());
    const ai = findings.find((f) => f.code === "ai_generated_disclosure");
    expect(ai?.severity).toBe("info");
    expect(ai?.message).toContain("is_aigc");
  });

  it("hesaba özel süre sınırının burada doğrulanamayacağı BİLDİRİLİR", async () => {
    const findings = await adapter().precheck(makeInput());
    const note = findings.find((f) => f.code === "duration_account_limit");
    expect(note?.severity).toBe("info");
    expect(note?.message).toContain("HESABA ÖZELDİR");
  });

  it("unlisted gizliliği MUTUAL_FOLLOW_FRIENDS olarak bildirilir", async () => {
    const findings = await adapter().precheck(
      makeInput({ copy: { ...COPY, privacy: "unlisted" } }),
    );
    const privacy = findings.find((f) => f.code === "privacy_level");
    expect(privacy?.severity).toBe("info");
    expect(privacy?.observed).toBe("MUTUAL_FOLLOW_FRIENDS");
  });

  it("zamanlama TikTok'ta yerel olduğu için info olarak bildirilir", async () => {
    const findings = await adapter().precheck(
      makeInput({ scheduledAt: "2026-08-25T09:00:00.000Z" }),
    );
    expect(findings.find((f) => f.code === "schedule_local_only")?.severity).toBe("info");
  });

  it("kapak zaman damgası info bulgusunda ms olarak görünür", async () => {
    const findings = await adapter().precheck(
      makeInput({ media: mediaRef({ info: mediaInfo({ durationSec: 30 }) }) }),
    );
    expect(findings.find((f) => f.code === "cover_timestamp")?.observed).toBe("10500");
  });

  it("BOŞ dosya hata üretir", async () => {
    const findings = await adapter().precheck(
      makeInput({ media: mediaRef({ bytes: 0, info: mediaInfo({ bytes: 0 }) }) }),
    );
    expect(findings.find((f) => f.code === "empty_media")?.severity).toBe("error");
    expect(planChunks(0).problem).not.toBeNull();
  });

  it("9:16 dikey video HATA üretmez", async () => {
    const findings = await adapter().precheck(makeInput());
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

/** Ters yönlü kontrol: imzalı `upload_url` sorgu dizesiyle gelir. */
it("upload_url sorgu dizesiyle gelir (PUT'ta AYNEN kullanılmalı)", () => {
  expect(UPLOAD_URL).toContain("X-Amz-Signature=");
  expect(UPLOAD_URL.startsWith("https://")).toBe(true);
});
