/**
 * TikTok test ortak verisi. Bu dosya bir test dosyası DEĞİLDİR — vitest'in
 * `include` deseni yalnız `.test.ts` eki olan dosyaları toplar; buradan yalnız
 * test dosyaları içe aktarır.
 *
 * HİÇBİR YERDE AĞ ÇAĞRISI YOK. `transport()` gerçek `Response` nesneleri
 * üreten bir sahte taşıma döndürür; böylece istemcinin ayrıştırma, başlık
 * toplama ve gövde tüketme yolu da testte GERÇEKTEN çalışır.
 */
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PublishInput,
  ResolvedCopy,
  UploadSession,
} from "../../../src/ports/index.js";
// `MediaInfo` `ports`'ta YALNIZ içe aktarılıyor, yeniden DIŞA AKTARILMIYOR; tanım
// yeri `contract`. İçe aktarma buradan yapılır (ports'ı değiştirmiyoruz).
import type { MediaInfo } from "../../../src/contract/index.js";
import type { Fetch } from "../../../src/adapters/tiktok/http.js";

/** 2026-08-24T12:00:00Z — sabit saat, `upload_url` süresi test edilebilir olsun. */
export const NOW_ISO = "2026-08-24T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);
export const now = (): number => NOW_MS;

/** 1 saatlik `upload_url` geçerliliği sonu. */
export const UPLOAD_EXPIRES_ISO = "2026-08-24T13:00:00.000Z";

export const OPEN_ID = "oc_9f8e7d6c5b4a3210";
export const PUBLISH_ID = "v_pub_7f3a9c2b1d0e4f5a";
export const PUBLISH_ID_2 = "v_pub_0000000000second";
export const VIDEO_ID = "7412345678901234567";
export const PUBLIC_POST_ID = "7412345678901234999";

/** Sorgu parametreli (imzalı) yükleme adresi. `PUT` bunu AYNEN kullanır. */
export const UPLOAD_URL =
  "https://tosv.byted.org/upload?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=3600";

export const CREATOR_INFO_BODY = {
  code: 0,
  message: "success",
  data: {
    max_video_post_duration_sec: 600,
    privacy_level_options: [
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ],
  },
};

export const INIT_BODY = {
  code: 0,
  message: "success",
  data: { publish_id: PUBLISH_ID, upload_url: UPLOAD_URL },
};

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Gövde ham metin (bozuk JSON testi için). */
  raw?: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Gövde metin olarak gönderildiyse metin, değilse null. */
  body: string | null;
  rawBody: unknown;
}

/**
 * Sırayla yanıt veren sahte taşıma.
 *
 * Dizi tükenince **son yanıt TEKRARLANIR** (Instagram testlerindeki davranış):
 * yoklama testleri birden çok istek yapıp yalnız bir yanıt tanımlayabilir.
 */
export function transport(responses: FakeResponse[]): { fn: Fetch; calls: RecordedCall[] } {
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

/** Gövdesi JSON olan bir isteği çözer. */
export function sentJson(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? "{}") as Record<string, unknown>;
}

/**
 * Sıradaki isteği döndürür, YOKSA HATA FIRLATIR.
 *
 * Neden ayrı yardımcı: `noUncheckedIndexedAccess` açık olduğu için `calls[1]`
 * `RecordedCall | undefined`'dir. Dizi erişimini susturan bir tür iddiası tip
 * denetimini tamamen atlatır ve testin gerçekten init isteğini gördüğünü garanti
 * etmez. Burada daraltma ÇALIŞAN bir kontrole dönüşür: istek yoksa test, neden
 * başarısız olduğunu yazan bir hatayla düşer.
 */
export function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(
      `Beklenen istek (${index}. indis) yok; kaydedilen istek sayısı: ${calls.length}. ` +
        "Adımlar yanlış sırada çalışmış ya da istenen istek hiç atılmamış olabilir.",
    );
  }
  return call;
}

// ── Girdi kurulumu ──────────────────────────────────────────────────────────

export const ACCOUNT: AccountRef = {
  id: "acc-tt-1",
  platform: "tiktok",
  externalId: OPEN_ID,
  accessToken: "TT_SHORT_LIVED",
  refreshToken: "TT_REFRESH_365d",
  tokenExpiresAt: "2026-08-25T12:00:00.000Z",
};

export function mediaInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "uploads/ab/cd/klip.mp4",
    bytes: 30_000_000,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 30,
    bitrate: 10_000_000,
    hasAudio: true,
    ...over,
  };
}

export function mediaRef(over: Partial<MediaRef> = {}): MediaRef {
  // `info` ÜSTÜNE YAZILMAZ, BİRLEŞTİRİLİR. Sıradaki `...over` zaten `info`'yu
  // getiriyor; eski hâli sonradan `info` ile tekrar ezmek, testin geçtiği medyayı
  // testin ÜSTÜNE yazmak demekti ("yatay video" testi aslında dikey 30 sn video
  // ile çalışıyordu). `over.info` verilmemişse `...base` zaten tam `MediaInfo`'dir.
  const base = mediaInfo({ bytes: over.bytes ?? 30_000_000 });
  return {
    storageKey: "uploads/ab/cd/klip.mp4",
    bytes: 30_000_000,
    mimeType: "video/mp4",
    coverKey: null,
    publicUrl: null,
    ...over,
    info: { ...base, ...(over.info ?? {}) },
  };
}

export const COPY: ResolvedCopy = {
  caption: "Yaz indirimi bugün sona eriyor",
  hashtags: ["#kampanya", "#yaz"],
  title: null,
  description: null,
  tags: [],
  privacy: "public",
  coverAtPercent: 35,
  aiGenerated: true,
  selfDeclaredMadeForKids: false,
  madeForShorts: false,
};

export function makeInput(over: Partial<PublishInput> = {}): PublishInput {
  return {
    jobId: "job-tt-1",
    idempotencyKey: "tt:job-1",
    account: ACCOUNT,
    media: mediaRef(),
    copy: COPY,
    scheduledAt: null,
    coverBytes: null,
    ...over,
  };
}

export function pollContext(over: Partial<PollContext> = {}): PollContext {
  return {
    account: ACCOUNT,
    externalId: PUBLISH_ID,
    uploadUrl: UPLOAD_URL,
    uploadUrlExpiresAt: UPLOAD_EXPIRES_ISO,
    uploadedParts: 0,
    totalParts: null,
    scheduledAt: null,
    ...over,
  };
}

export function session(over: Partial<UploadSession> = {}): UploadSession {
  return {
    uploadUrl: UPLOAD_URL,
    expiresAt: UPLOAD_EXPIRES_ISO,
    totalParts: null,
    uploadedParts: 0,
    partSizeBytes: 0,
    ...over,
  };
}

/** `uploadParts` için sahte bayt okuyucu: istenen aralığı SAYILAR. */
export function countingRange(): {
  openRange: (input: { storageKey: string; offset: number; length: number }) => Uint8Array;
  ranges: Array<{ storageKey: string; offset: number; length: number }>;
} {
  const ranges: Array<{ storageKey: string; offset: number; length: number }> = [];
  return {
    ranges,
    openRange: ({ storageKey, offset, length }) => {
      ranges.push({ storageKey, offset, length });
      return new Uint8Array(Math.min(length, 8));
    },
  };
}
