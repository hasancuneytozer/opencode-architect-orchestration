/**
 * GERÇEK Instagram yayın adaptörü — Meta Graph API + `rupload.facebook.com`
 * resumable upload (Content Publishing API).
 *
 * ── GİRİŞ YOLU: FACEBOOK LOGIN FOR BUSINESS ──────────────────────────────────
 * İki giriş yolu var:
 *   |                        | Facebook Login | Business Login for Instagram |
 *   |------------------------|----------------|------------------------------|
 *   | host                   | graph.facebook.com | graph.instagram.com     |
 *   | FB Page ZORUNLU        | EVET            | hayır                         |
 *   | resumable upload       | VAR             | yok (public URL şart)        |
 * Biz **Facebook Login** yolunu uygularız: resumable upload orada vardır ve
 * `requiresPublicMediaUrl: false` sayesinde uygulamamızın medyası internete
 * açılmaz. `externalId` = IG user id, `linkedPageId` = Facebook Page id.
 *
 * ── AKIŞ (dört adım, üçü ayrı uç nokta) ─────────────────────────────────────
 *   1) `POST /{ig-user-id}/media`      → `{ id, uri }` (container + yükleme adresi)
 *   2) `POST {RUPLOAD_BASE}/{v}/{id}` → baytlar (`offset`, `file_size`, `OAuth`)
 *   3) `POST /{ig-user-id}/media_publish` `{ creation_id }` → `{ id }` (media id)
 *   4) `GET  /{media-id}?fields=permalink`
 *
 * ── BU DOSYANIN ÜÇ KRİTİK DETAYI ────────────────────────────────────────────
 * 1) **`Authorization: OAuth`, `Bearer` DEĞİL.** `rupload.facebook.com`
 *    Graph API değildir; `Bearer <token>` gönderilirse istek `400 OAuth
 *    Access Token Redacted` ile döner ve hata "dosya geçersiz" gibi görünür.
 *    Bu tek başlık, canlıda ilk denemede bulunması en kolay hatadır.
 * 2) **`debug_info.retriable` YENİ DENEME KARARINI VERİR.** 4xx/5xx ayrımı
 *    tek başına yanlıştır: Meta aynı 400'ü "offset çakıştı, tekrar gönder"
 *    (geçici) ve "oturum öldü" (kalıcı) için dönebilir. Bu yüzden HTTP durumu
 *    gÖNCE okunur, gövdedeki `debug_info.retriable` SONRA ve O DAHA KUVVETLİDİR.
 * 3) **KOTA HARİTLEME YAPILMAZ.** Resmî sayfalar çelişiyor (rehber "100/24s",
 *    `content_publishing_limit` dokümanı `quota_total: 50`). `readQuota`
 *    değeri **endpoint'ten okur**; 404/izin yoksa `null` döner ve motor eski
 *    davranışına düner. Sabit yazmak, Meta'nın hesap başına değiştirdiği bir
 *    değeri uydurmak olurdu.
 *
 * ── `media_type` YANILTICISI ────────────────────────────────────────────────
 * Yayın sonrası `media_type` **VIDEO** döner; Reels ayrımı
 * `media_product_type` alanıyla yapılır. `PUBLISHED` durumunda
 * `media_product_type` okunur ve `REELS` değilse `providerStatus`
 * `PUBLISHED_NON_REELS` olur — içerik FEED'a düşmüş demektir ve arşivde
 * görünmelidir.
 *
 * ── SÜRÜM TUZAĞI ───────────────────────────────────────────────────────────
 * Graph API **v26.0**. v20.0 24 Eylül 2026'da kaldırıldı. Sürüm
 * `src/media/specs/instagram.ts`'ten içe aktarılır; burada SABİT YAZILMAZ,
 * çünkü iki yerde farklı sürüm yazmak "sadece bir yerde eski" hatası üretir.
 *
 * ── SİMULASYONUN DIŞINDA KALAN YER ──────────────────────────────────────────
 * Bu adaptör baytların KENDİSİNİ `NodeJS.ReadableStream` olarak açmak zorunda
 * (`openRange`/`resolvePath` seçenekleri). `PublishInput` yalnız `storageKey`
 * taşır, dosya yolu taşımaz; bu yüzden 300 MB'lık gövde belleğe alınamaz.
 * Depo erişimi enjekte edilir: `openRange` verilirse o, yoksa `resolvePath`
 * (MediaStore.pathFor) üzerinden `node:fs` kullanılır. HİÇBİRİ verilmezse
 * `uploadParts` sessizce "başarılı" demez — açık bir kalıcı hata verir.
 * `resolvePath` yolunda dosya da ÖNCE doğrulanır: `fs.ReadStream` eksik
 * dosyada hata fırlatmaz, hata gövde okunurken doğan yakalanmamış bir olay
 * olurdu.
 */
import type {
  JobState,
  Platform,
  PlatformSpec,
  PublishErrorKind,
  ValidationFinding,
} from "../../contract/index.js";
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PollResult,
  PublishAdapter,
  PublishFailureLite,
  PublishInput,
  QuotaSnapshot,
  StartResult,
  UploadProgress,
  UploadSession,
} from "../../ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../../ports/index.js";
import { mapMetaError, mapMetaStatus } from "../../domain/providerErrors.js";
import type { ProviderErrorMapping } from "../../domain/providerErrors.js";
import { canTransition } from "../../domain/stateMachine.js";
import { composeCaptionDetailed } from "../../domain/copy.js";
import { findLimit, getSpec, validateMedia } from "../../media/index.js";
import { GRAPH_API_VERSION, RUPLOAD_BASE } from "../../media/specs/instagram.js";
import { INSTAGRAM_CONTAINER_TTL_SEC } from "../../media/presets.js";
import type { InstagramHttpClient, InstagramHttpResponse } from "./http.js";
import { INSTAGRAM_UPLOAD_TIMEOUT_MS, asPublishTransportError, createHttpClient } from "./http.js";

// ── Sabitler ────────────────────────────────────────────────────────────────

/** Graph API kökü. `rupload.facebook.com` BUNDAN FARKLIDIR (bkz. `RUPLOAD_BASE`). */
export const INSTAGRAM_GRAPH_BASE = "https://graph.facebook.com";

/** Facebook Login yetkilendirme diyaloğu. Sürüm YOLDA. */
export const INSTAGRAM_OAUTH_DIALOG_BASE = "https://www.facebook.com";

/**
 * Zorunlu scope'lar (Facebook Login for Business + resumable upload).
 *
 * - `instagram_content_publish`: container + `media_publish` (yayının kendisi).
 * - `instagram_basic`: hesabın kimliği/kullanıcı adı okuma.
 * - `pages_read_engagement`: `/me/accounts` ve `instagram_business_account`.
 * - `pages_show_list`: `/me/accounts` sayfa listesini gösterebilmek için.
 * - `instagram_manage_contents`: `DELETE /{ig-media-id}` (silme) + yeniden
 *   yayınlama. **Yayın zorunlu DEĞİLDİR** ama silme yeteneği bu scope'a bağlı;
 *   scope dışarıda bırakılırsa `delete()` 403 döner.
 *
 * `business_management` **BİLEREK YOK**: bu uygulama sayfa YÖNETMİYOR, yalnız
 * yayın yapıyor. Gereksiz geniş yetki, hesap güvenliği incelemesinde gerekçe
 * sorar.
 */
export const INSTAGRAM_SCOPES: readonly string[] = [
  "instagram_content_publish",
  "instagram_basic",
  "pages_read_engagement",
  "pages_show_list",
  "instagram_manage_contents",
];

/** Container oluşturma isteğinin `media_type` değeri (Reels). */
export const INSTAGRAM_MEDIA_TYPE = "REELS";

/** Container oluşturma isteğinin `upload_type` değeri. */
export const INSTAGRAM_UPLOAD_TYPE = "resumable";

/**
 * Yayın TAMAMLANDIKTAN SONRA arşivde yazan durum kodu.
 *
 * `FINISHED` ham kod DEĞİLDİR: o kod "container işlendi, medya henüz
 * yayınlanmadı" demektir. `media_publish` 200 döndükten sonra iş durumu
 * `published` olduğuna göre arşiv kaydı da yayınlanmış olmalıdır.
 */
export const INSTAGRAM_PUBLISHED_STATUS = "PUBLISHED";

/**
 * Container durum yoklama aralığı (1 dakika).
 *
 * Meta resmî olarak **dakikada bir, en fazla 5 dakika** yoklama önerir. Daha
 * sık yoklama (aşağıdaki aralıkta) yalnız API kotasını harcar; daha seyrek
 * yoklama yayını geciktirir. İki uç arasında resmî öneri olan dakika seçildi.
 */
export const INSTAGRAM_CONTAINER_POLL_MS = 60_000;

/**
 * Yükleme parçası (varsayılan 8 MB).
 *
 * NEDEN 8 MB: Meta'nın resumable upload için parça başına ALT SINIR koyduğu en
 * yaygın belgelenen değerdir; 8 MB hem alt sınırın üstünde hem de 300 MB
 * dosyayı 38 parçaya böler (her biri için yeniden deneme ucuz).
 *
 * **DOĞRULANMAMIŞTIR** — alt sınır canlı ölçülmedi (bkz. `NOTES.md` 4).
 * Değiştirmek tek yerdedir; `UploadSession.partSizeBytes` kalıcı yazıldığı için
 * süren bir yüklemede değer ARTMALI, azalmamalıdır (ofset aritmetiği bozulur).
 */
export const INSTAGRAM_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

/** `content_publishing_limit?since=` için en eski kabul edilen nokta: 24 saat. */
export const INSTAGRAM_QUOTA_WINDOW_SEC = 86_400;

/** `config.quota_duration` yoksa kullanılan pencere (24 saat). */
export const INSTAGRAM_DEFAULT_QUOTA_WINDOW_SEC = INSTAGRAM_QUOTA_WINDOW_SEC;

// ── Adres kurucuları (saf) ──────────────────────────────────────────────────

/**
 * Graph API adresi.
 *
 * `path` DÖNÜŞTÜRÜLMEDEN eklenir: `ig-user-id` gibi üs sıralar sayısal string
 * olduğu için güvenli, `container id` ise string olduğu için de güvenli. Meta
 * kimlikleri `/` veya `?` içermez; yine de `path` önceden kaçırılmış gelmelidir.
 */
export function graphUrl(path: string, query?: Readonly<Record<string, string>>): string {
  const base = `${INSTAGRAM_GRAPH_BASE}/${GRAPH_API_VERSION}${path}`;
  if (query === undefined) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, value);
  const qs = params.toString();
  return qs === "" ? base : `${base}?${qs}`;
}

/** Resumable yükleme adresi (sürüm YOLDA). */
export function ruploadUrl(containerId: string): string {
  return `${RUPLOAD_BASE}/${GRAPH_API_VERSION}/${containerId}`;
}

// ── Gövde kurucuları (saf) ──────────────────────────────────────────────────

export interface InstagramContainerInput {
  caption: string | null;
  /** `is_ai_generated` — `ResolvedCopy.aiGenerated`'ın doğrudan karşılığı. */
  aiGenerated: boolean;
  shareToFeed: boolean;
}

/**
 * `POST /{ig-user-id}/media` gövdesi.
 *
 * - `upload_type: "resumable"` → sunucu baytları ADRESİYLE kabul eder.
 * - `media_type: "REELS"` → Reels (paylaşım akışı). `media_product_type`
 *   yayın sonrası okunur.
 * - `video_url: ""` → resumable yolda BOŞ gönderilir. Alan resmî örnekte yer
 *   alır; dolu bir URL verilirse Meta "public URL doğrulanamıyor" hatasıyla
 *   reddeder ve bizim medyamız internete açık olmak zorunda kalır.
 * - `is_ai_generated` → Meta'nın AI içeriği beyanı. `false` bile AÇIKÇA
 *   gönderilir: alan yok bırakılırsa sunucu "beyan yok" ile ayırt edemez ve
 *   içerik sessizce AI etiketsiz yayınlanır.
 */
export function buildContainerBody(input: InstagramContainerInput): Record<string, unknown> {
  return {
    upload_type: INSTAGRAM_UPLOAD_TYPE,
    media_type: INSTAGRAM_MEDIA_TYPE,
    video_url: "",
    caption: input.caption ?? "",
    is_ai_generated: input.aiGenerated,
    share_to_feed: input.shareToFeed,
  };
}

/** `POST /{ig-user-id}/media_publish` gövdesi. */
export function buildPublishBody(containerId: string): Record<string, unknown> {
  return { creation_id: containerId };
}

// ── Container yanıtı ────────────────────────────────────────────────────────

export interface InstagramContainerRef {
  /** `StartResult.externalId` ve `pollPublish`'in `ctx.externalId` değeri. */
  containerId: string;
  /** Sunucu döndürdüyse ham `uri`; yoksa `null` (adres bizim kurulur). */
  uploadUri: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * `POST /{ig-user-id}/media` yanıtından container kimliği.
 *
 * **`id` ve `uri` İKİ FARKLI ŞEYDİR ve hangisinin yetkili olduğu resmî
 * dokümanda net değil.** Bu yüzden ikisi de kabul edilir:
 *   - `id` varsa → yetkili container kimliği odur (durum sorgusu `/{id}`
 *     kullanır, bu bizim `externalId`'mız).
 *   - `id` yoksa → `uri`'nin **son yol segmenti** kimlik olarak alınır
 *     (rupload adresi `.../{version}/{container_id}` biçimindedir). Bu bir
 *     ÇIKARIMDIR; `NOTES.md` 3'te canlı doğrulama bekliyor diye yazılıdır.
 *   - `uri` mutlak bir adresse `uploadUrl` olarak KULLANILIR; değilse
 *     `ruploadUrl(containerId)` ile kurulur.
 * İkisi de varsa ve farklıysa `id` kazanır (durum sorgusu `id` ile tutarlı
 * olmalıdır), `uri` yalnız yükleme adresi olarak kullanılır.
 */
export function readContainerRef(json: unknown): InstagramContainerRef | null {
  const root = asRecord(json);
  if (root === null) return null;
  const uploadUri =
    asText(root["uri"]) ?? asText(root["upload_uri"]) ?? asText(root["resumable_uri"]);
  const id = asText(root["id"]);
  if (id !== null) return { containerId: id, uploadUri };

  if (uploadUri !== null) {
    const withoutQuery = uploadUri.split("?")[0] ?? "";
    const segments = withoutQuery.split("/").filter((s) => s !== "");
    const last = segments.length > 0 ? segments[segments.length - 1] : undefined;
    if (typeof last === "string" && /^[A-Za-z0-9_.:-]+$/.test(last)) {
      return { containerId: last, uploadUri };
    }
  }
  return null;
}

/** Container `uploadUrl`'i: sunucunun `uri`'si varsa o, yoksa kurulan adres. */
export function resolveUploadUrl(ref: InstagramContainerRef): string {
  if (ref.uploadUri !== null && /^https?:\/\//i.test(ref.uploadUri)) return ref.uploadUri;
  return ruploadUrl(ref.containerId);
}

// ── Hata gövdesi ayrıştırma ─────────────────────────────────────────────────

export interface MetaErrorInfo {
  /** Graph API `error.code` (9, 4, 25, -2, 9004, 80002…). */
  code: string | null;
  /** `error.error_subcode` (2207042…). */
  subcode: string | null;
  message: string | null;
  /** `error.fbtrace_id` — destek talebinde tek ipucu. */
  fbtraceId: string | null;
  /** `error.error_log_id` — ikinci izleme numarası. */
  logId: string | null;
  /**
   * `debug_info.retriable`. Meta'nın KENDİ yeniden deneme kararı.
   * `null` = gövdede yok (karar HTTP durumuna bırakılır).
   *
   * `debug_info` çoğu zaman GÖVDE İÇİNDE JSON OLARAK STRING gelir; burada iki
   * biçim de çözülür. Üçüncü biçim yoktur: alan hiç gelmezse `null`'dur.
   */
  retriable: boolean | null;
}

/** `debug_info` gömülü JSON string ise çözer, nesne ise olduğu gibi döner. */
function readDebugInfo(container: Record<string, unknown> | null): Record<string, unknown> | null {
  if (container === null) return null;
  const raw = container["debug_info"];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const parsed = safeParseObject(raw);
    return parsed;
  }
  return asRecord(raw);
}

function safeParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Meta hata gövdesini okur. Bozuk/boş gövde → tüm alanlar `null`.
 *
 * `error.code` sayı YA DA string olabilir; `codeText` benzeri bir normalizasyon
 * uygulanır ama BİÇİM UYDURULMAZ: olmayan koda `0`/`-1` gibi bir değer yazmak
 * onu "tanınmıyor" yerine "geçici" gösterebilirdi.
 */
export function parseMetaError(json: unknown): MetaErrorInfo {
  const root = asRecord(json);
  if (root === null) return emptyMetaError();
  const err = asRecord(root["error"]) ?? root;

  const code = numericText(err["code"]) ?? asText(err["code"]);
  const subcode = numericText(err["error_subcode"]) ?? numericText(err["subcode"]);
  const debug = readDebugInfo(err) ?? readDebugInfo(root);
  const retriableRaw = debug === null ? null : debug["retriable"];

  return {
    code,
    subcode,
    message: asText(err["message"]),
    fbtraceId: asText(err["fbtrace_id"]),
    logId: asText(err["error_log_id"]) ?? asText(root["error_log_id"]),
    retriable: typeof retriableRaw === "boolean" ? retriableRaw : null,
  };
}

function emptyMetaError(): MetaErrorInfo {
  return { code: null, subcode: null, message: null, fbtraceId: null, logId: null, retriable: null };
}

function numericText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

/**
 * `classifyMetaFailure` için bağlam.
 * `sessionGone: true` → 404/410 "yükleme oturumu öldü" demektir (kalıcı,
 * baştan başlat), `validation` değil.
 */
export interface MetaFailureContext {
  /** Bu istek bir resumable YÜKLEME oturumuna mı gidiyor? */
  sessionGone?: boolean;
}

function retryableKindOf(kind: PublishErrorKind): Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient"> {
  return kind as Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient">;
}

/**
 * HTTP hatasını yayın hatasına çevirir.
 *
 * ÖNCELİK (kısmen ters sırada, bilinçli):
 *   1) `debug_info.retriable === true` → GEÇİCİ. Meta'ya "aynı istek geçici
 *      olarak başarısız oldu" diyor; HTTP 400 olsa bile yeniden denemek
 *      anlamlıdır.
 *   2) `code`/`subcode` → `mapMetaError` tablosu. Bu tablo DOĞRULANMIŞ
 *      satırlardan oluşur; tanınmayan kod `unknown` + KALICI olur.
 *   3) `debug_info.retriable === false` → KALICI (Meta açıkça "tekrar deneme").
 *   4) HTTP durumu: 429 → ratelimit, 5xx → server, 401 → auth, 403 → policy,
 *      404/410 → oturum öldü (`sessionGone`) ya da `validation`.
 *
 * NEDEN 4. adımda `unknown` kalıcı: HTTP durumu bir KOD DEĞİLDİR. "Belki
 * geçcidir" diye 4xx'i geçici saymak, destek talebinde yanlış teşhis ve
 * sonsuz yeniden deneme demektir.
 */
export function classifyMetaFailure(
  response: InstagramHttpResponse,
  what: string,
  ctx: MetaFailureContext = {},
): PermanentPublishError | RetryablePublishError {
  const info = parseMetaError(response.json);
  const status = response.status;
  const detail = info.message ?? (response.body !== "" ? response.body.slice(0, 400) : "(gövde boş)");
  const base = `${what} — HTTP ${status}${info.code !== null ? ` (code=${info.code}` : ""}${
    info.subcode !== null ? `${info.code !== null ? "," : ""} subcode=${info.subcode}` : ""
  }${info.code !== null || info.subcode !== null ? ")" : ""}: ${detail}`;
  const logId = info.fbtraceId ?? info.logId;

  const asRetryable = (kind: PublishErrorKind, providerCode: string | null): RetryablePublishError =>
    new RetryablePublishError(
      `${base} — ${providerCode !== null ? "Meta `debug_info.retriable=true` dedi." : ""}`.trim(),
      retryableKindOf(kind),
      response.retryAfterMs,
      providerCode,
      logId,
      status,
    );

  /**
   * Kalıcı hata kurucusu. `mapping: null` → `kind` AÇIKÇA verilmelidir; verilmez
   *se `unknown` + kalıcı olur (tahmin yok kuralı). `asPermanent(null, ...)`
   * çağrılarının hepsi bu yüzden `kind` argümanı taşır.
   */
  const asPermanent = (
    mapping: ProviderErrorMapping | null,
    providerCode: string | null,
    kind: PublishErrorKind = "unknown",
  ): PermanentPublishError =>
    new PermanentPublishError(
      mapping !== null ? `${base} — ${mapping.message}` : base,
      mapping !== null ? mapping.kind : kind,
      providerCode,
      logId,
      status,
    );

  // 1) Meta'nın kendi kararı: geçici.
  if (info.retriable === true) return asRetryable("transient", info.code ?? "retriable");

  // 2) Doğrulanmış kod/subcode tablosu.
  //
  // SUBCODE TEK BAŞINA: Meta throttle bildirimlerinde `80002` çoğu zaman
  // `error_subcode` alanında ve `error.code` YOKTUR. `mapMetaError` çift arar ve
  // bulamazsa kalıcı `unknown` döner — bu güvenli ama throttle'ı geçici saymayı
  // kaçırırdı. Bu yüzden `code` yokken subcode ÖNCE tekil kod tablosunda
  // aranır; bulunamazsa normal çift/uyumsuz yol devreye girer (kalıcı).
  if (info.code === null && info.subcode !== null) {
    const asCode = mapMetaError({ errorCode: info.subcode });
    if (asCode.providerCode !== "" || asCode.kind !== "unknown") {
      return asCode.retryable
        ? new RetryablePublishError(
            `${base} — ${asCode.message}`,
            retryableKindOf(asCode.kind),
            response.retryAfterMs,
            asCode.providerCode,
            logId,
            status,
          )
        : asPermanent(asCode, asCode.providerCode);
    }
  }

  const hasCode = info.code !== null || info.subcode !== null;
  if (hasCode) {
    const mapping = mapMetaError({ code: info.code, subcode: info.subcode });
    if (mapping.retryable) {
      return new RetryablePublishError(
        `${base} — ${mapping.message}`,
        retryableKindOf(mapping.kind),
        response.retryAfterMs,
        mapping.providerCode || info.code,
        logId,
        status,
      );
    }
    return asPermanent(mapping, mapping.providerCode || info.code);
  }

  // 3) Meta "tekrar deneme" diyor.
  if (info.retriable === false) return asPermanent(null, info.code ?? "not_retriable");

  // 4) Kod yok: HTTP durumu.
  if (status === 429) return asRetryable("ratelimit", "http_429");
  if (status >= 500) return asRetryable("server", `http_${status}`);
  if (status === 408) return asRetryable("transient", "http_408");
  // 401/403 "yetki yok" DEMEZ — belirtecin süresi dolmuş ya da kapsam eksik
  // OLABİLİR (401) ve 403 izin/politika kararıdır (403). İkisi de kalıcıdır ama
  // farklı düzeltme gerektirir; bu yüzden `auth` ve `policy` ayrılır.
  if (status === 401) return asPermanent(null, "unauthorized", "auth");
  if (status === 403) return asPermanent(null, "forbidden", "policy");
  if (status === 404 || status === 410) {
    return new PermanentPublishError(
      `${base}. ${
        ctx.sessionGone === true
          ? "Resumable yükleme oturumu artık kabul edilmiyor; yükleme BAŞTAN başlatılmalıdır."
          : "Düğüm bulunamadı."
      }`,
      ctx.sessionGone === true ? "container_expired" : "validation",
      ctx.sessionGone === true ? "session_expired" : "not_found",
      logId,
      status,
    );
  }
  if (status >= 400) return asPermanent(null, `http_${status}`);
  return asPermanent(null, `http_${status}`);
}

// ── Container durumu ─────────────────────────────────────────────────────────

export interface InstagramContainerStatus {
  statusCode: string | null;
  /** `status` alanı. `ERROR` halinde hata subcode'unu/metnini taşır. */
  status: string | null;
}

/** `GET /{container}?fields=status_code,status` gövdesi. */
export function readContainerStatus(json: unknown): InstagramContainerStatus {
  const root = asRecord(json);
  if (root === null) return { statusCode: null, status: null };
  return {
    statusCode: asText(root["status_code"]),
    status: asText(root["status"]),
  };
}

/**
 * `ERROR` halinde `status` metninden `code`/`subcode` çıkarır.
 *
 * ÖRNEKLER (canlıda görülen biçimler):
 *   `"9/2207042"`     → code=9, subcode=2207042  (günlük kota doldu)
 *   `"2207051"`       → code=2207051             (tek sayı → `code`)
 *   `"ERROR 2207042"` → code=2207042
 *
 * NEDEN tek sayı `code` sayılır: `mapMetaError` tablosunda TEK BAŞINA anlam
 * taşıyan kodlar (`80002` throttle, `9004` çekilemedi) `code` alanındadır;
 * `code/subcode` ÇİFTLERİ ise `9/2207042` gibi ayraçlı gelir. Tersi yapılırsa
 * `80002` throttle kalıcı görünür ve dakikalarca yeniden denenir.
 *
 * HİÇBİR SAYI YOKSA `null` döner: o durumda `status` yalnızca insan metnidir
 * ve `mapMetaStatus("ERROR")` (`media_rejected`, kalıcı) kullanılır.
 */
export function parseMetaStatusError(status: string | null | undefined): {
  code: string | null;
  subcode: string | null;
} {
  if (typeof status !== "string") return { code: null, subcode: null };
  const pair = /(-?\d+)\s*[/:,|]\s*(-?\d+)/.exec(status);
  if (pair !== null) return { code: pair[1] ?? null, subcode: pair[2] ?? null };
  const single = /(-?\d+)/.exec(status);
  return single !== null ? { code: single[1] ?? null, subcode: null } : { code: null, subcode: null };
}

/** `GET /{media-id}?fields=permalink,media_product_type` → permalink. */
export function readPermalink(json: unknown): string | null {
  const root = asRecord(json);
  return root === null ? null : asText(root["permalink"]);
}

/**
 * `media_product_type` — Reels mi, Feed mı?
 *
 * Yayın sonrası `media_type` **HER ZAMAN `VIDEO`** döner; Reels ayrımı yalnız
 * bu alanla yapılır. `FEED` dönmesi "Reels olarak paylaşıldı" beklentisini
 * bozar ve arşivde görünmelidir.
 */
export function readMediaProductType(json: unknown): string | null {
  const root = asRecord(json);
  return root === null ? null : asText(root["media_product_type"]);
}

// ── Kota ────────────────────────────────────────────────────────────────────

/**
 * `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config&since=`
 * gövdesini okur. **Kota SAYISI BURADA SABİT YAZILMAZ.**
 *
 * Gerekçe: resmî kaynaklar çelişiyor — Content Publishing rehberi "24 saatte
 * 100 API yayını" derken `content_publishing_limit` dokümanı `quota_total: 50`
 * örneği verir. Hangisinin doğru olduğu hesap/uygulama türüne göre değişebilir;
 * sabit bir sayı yazmak, Meta'nın değiştirdiği bir değeri UYDURMAK olurdu.
 * Okunamazsa `null` → motor yayını engellemez (kota zaten sağlayıcıda uygulanır).
 *
 * `quota_usage` ya da `quota_total` eksikse/bozuksa `null` döner: eksik alanı 0
 * saymak, kotanın dolu olduğu ya da kullanılmadığı anlamına gelir ve motorun
 * kararını yanlış yönlendirir.
 */
export function readQuotaView(json: unknown): QuotaSnapshot | null {
  const root = asRecord(json);
  if (root === null) return null;
  const used = root["quota_usage"];
  const config = asRecord(root["config"]);
  if (config === null) return null;
  const total = config["quota_total"];
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  const rawDuration = config["quota_duration"];
  const windowSec =
    typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.floor(rawDuration)
      : INSTAGRAM_DEFAULT_QUOTA_WINDOW_SEC;
  return { used, total, windowSec };
}

// ── Bayt aralığı kaynağı ────────────────────────────────────────────────────

/** `uploadParts` için bayt aralığı okuyucu. Büyük gövdelerde AKIM döner. */
export type OpenRangeFn = (input: {
  storageKey: string;
  offset: number;
  length: number;
}) => Promise<Uint8Array | NodeJS.ReadableStream> | Uint8Array | NodeJS.ReadableStream;

// ── Adaptör ──────────────────────────────────────────────────────────────────

export interface InstagramSession {
  containerId: string;
  uploadUrl: string;
  expiresAt: string;
  /** "Aynı dosya mı" sorusunun yanıtı — mükerrer korumanın parçası. */
  mediaKey: string;
}

export interface InstagramAdapterOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (süre hesabı test edilemez olmasın). */
  now: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `rupload` yüklemesi için zaman aşımı (varsayılan 30 dakika). */
  uploadTimeoutMs?: number;
  /** Parça boyutu (varsayılan 8 MB). `UploadSession.partSizeBytes` varsa O kazanır. */
  partSizeBytes?: number;
  /** Bayt aralığı okuyucu. Verilirse `resolvePath` yok sayılır. */
  openRange?: OpenRangeFn;
  /** Depo anahtarını dosya yoluna çözer (MediaStore.pathFor). */
  resolvePath?: (storageKey: string) => string;
  /** Test kancaları. Üretimde Graph API adresleri kullanılır. */
  graphBase?: string;
  ruploadBase?: string;
}

export interface InstagramCounters {
  precheck: number;
  start: number;
  upload: number;
  poll: number;
  publish: number;
  permalink: number;
  finalize: number;
  quota: number;
}

export class InstagramPublishAdapter implements PublishAdapter {
  readonly platform: Platform = "instagram";
  readonly spec: PlatformSpec = getSpec("instagram");

  private readonly now: () => number;
  private readonly client: InstagramHttpClient;
  private readonly uploadTimeoutMs: number;
  private readonly partSizeBytes: number;
  private readonly openRange: OpenRangeFn | null;
  private readonly graphBase: string;
  private readonly ruploadBase: string;
  /** `idempotencyKey` → açılmış container. Aynı süreç içinde mükerrer koruması. */
  private readonly sessions = new Map<string, InstagramSession>();
  private readonly counts: InstagramCounters = {
    precheck: 0,
    start: 0,
    upload: 0,
    poll: 0,
    publish: 0,
    permalink: 0,
    finalize: 0,
    quota: 0,
  };

  constructor(options: InstagramAdapterOptions) {
    this.now = options.now;
    this.client = createHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? INSTAGRAM_UPLOAD_TIMEOUT_MS;
    this.partSizeBytes = options.partSizeBytes ?? INSTAGRAM_RESUMABLE_CHUNK_BYTES;
    this.graphBase = options.graphBase ?? INSTAGRAM_GRAPH_BASE;
    this.ruploadBase = options.ruploadBase ?? RUPLOAD_BASE;
    if (options.openRange !== undefined) {
      this.openRange = options.openRange;
    } else if (options.resolvePath !== undefined) {
      // `node:fs` yalnız lazy olarak yüklenir: `openRange` verilmişse gerekmez.
      const resolvePath = options.resolvePath;
      this.openRange = async ({ storageKey, offset, length }) => {
        const path = resolvePath(storageKey);
        // Varlık ÖNCE doğrulanır. `createReadStream` dosya yoksa HATA
        // FIRLATMAZ: eksik dosyada akım nesnesi döner, hata gövde tüketilirken
        // `error` OLAYI olarak doğar. O olay `client.send` tarafından
        // YAKALANAMAZ (gövde sahibi orası değildir) → süreçte yakalanmamış
        // istisna olur; üstelik istek 200 dönseydi `uploadParts` "başarılı"
        // derdi. `statSync` burada, eşzamansız ve yakalanabilir biçimde
        // patlar: bayt gönderilmeden `openRange` sözleşmesi ihlal edilir.
        const { createReadStream, statSync } = await import("node:fs");
        statSync(path);
        return createReadStream(path, {
          start: offset,
          end: offset + length - 1,
        });
      };
    } else {
      this.openRange = null;
    }
  }

  /** Test kancası: sayaçları okur. */
  callCounts(): Readonly<InstagramCounters> {
    return { ...this.counts };
  }

  /** Test kancası: açılmış container'ları okur. */
  session(idempotencyKey: string): InstagramSession | null {
    const found = this.sessions.get(idempotencyKey);
    return found === undefined ? null : { ...found };
  }

  // ── precheck ─────────────────────────────────────────────────────────────

  /**
   * Yayına gitmeden önceki son kontrol.
   *
   * Katman 1 — `validateMedia(info, getSpec("instagram"))`: ölçü, kapsayıcı,
   * kodek, fps, süre (3 sn-15 dk), boyut (300 MB). Bu katmanın bulguları ASSET
   * kaydında da üretilir; aynı kuralın iki yerde farklı sertlikte olması
   * panelde "uyarı" derken işin "hata" ile kapanmasına yol açar. Bu yüzden
   * SEVİYE DÖNÜŞTÜRÜLMEZ.
   *
   * Katman 2 — yalnız bu katmanın bildiği kurallar:
   *   - caption + hashtag BİLEŞİK uzunluğu (2200 karakter),
   *   - hashtag sayısı (30),
   *   - `aiGenerated` beyanı (gönderilecek `is_ai_generated` alanının notu),
   *   - zamanlamanın Meta'da YAPILAMADIĞI bilgisi (bizim kuyruğumuzda).
   *
   * 9:16 DIKEY video Instagram'da HATA DEĞİLDİR (oran zorunlu değil, yalnız
   * önerilir); bu yüzden bu katman oran kurallarını `validateMedia`'a bırakır.
   */
  async precheck(input: PublishInput): Promise<ValidationFinding[]> {
    this.counts.precheck += 1;
    const findings: ValidationFinding[] = validateMedia(input.media.info, this.spec);

    if (!(input.media.bytes > 0)) {
      findings.push({
        code: "empty_media",
        severity: "error",
        message:
          `Medya ${input.media.bytes} bayt. Boş dosya için container oluşturulmaz; ` +
          "sunucu anlık reddeder.",
        observed: String(input.media.bytes),
      });
    }

    const captionLimit = findLimit(this.spec.limits, "caption");
    const maxChars =
      typeof captionLimit?.max === "number" && captionLimit.max > 0
        ? captionLimit.max
        : undefined;
    const composed = composeCaptionDetailed(input.copy.caption, input.copy.hashtags, {
      ...(maxChars === undefined ? {} : { maxChars }),
      platform: "instagram",
    });
    if (composed.problem !== null) {
      findings.push({
        code: "caption_length",
        severity: "error",
        message:
          `${composed.problem} Metin kırpılmadı; Instagram'da sessiz kırpma yerine ` +
          "reddetmek tercih edilir.",
        ...(captionLimit === undefined ? {} : { limit: captionLimit.rule }),
        observed: `${composed.length} karakter`,
      });
    }

    const hashtagLimit = findLimit(this.spec.limits, "hashtag_count");
    const hashtagCount = Array.isArray(input.copy.hashtags)
      ? input.copy.hashtags.filter((t) => typeof t === "string" && t.trim() !== "").length
      : 0;
    if (typeof hashtagLimit?.max === "number" && hashtagCount > hashtagLimit.max) {
      findings.push({
        code: "hashtag_count",
        severity: "error",
        message: `${hashtagCount} hashtag; Instagram en çok ${hashtagLimit.max} hashtag kabul eder.`,
        ...(hashtagLimit.rule === undefined ? {} : { limit: hashtagLimit.rule }),
        observed: String(hashtagCount),
      });
    }

    if (input.copy.aiGenerated) {
      findings.push({
        code: "ai_generated_disclosure",
        severity: "info",
        message:
          "`is_ai_generated: true` gönderilecek. Meta bu beyanı platformda AI " +
          "etiketine çevirir; alan gönderilmezse içerik sessizce etiketsiz yayınlanır.",
        observed: "aiGenerated=true",
      });
    }

    const scheduledText = typeof input.scheduledAt === "string" ? input.scheduledAt : null;
    if (scheduledText !== null) {
      findings.push({
        code: "schedule_local_only",
        severity: "info",
        message:
          "Instagram Graph API'de yayın zamanlaması YOKTUR. Zamanlama bizim iş " +
          "kuyruğumuzda yapılır; `media_publish` çağrısı yalnız kuyruk o anı " +
          "geldiğinde yapılır.",
        observed: scheduledText,
      });
    }

    return findings;
  }

  // ── startPublish ─────────────────────────────────────────────────────────

  /**
   * Container açar ve yükleme adresini döndürür.
   *
   * MÜKERRER KORUMA: Instagram'ın container gövdesinde resmî bir idempotens
   * alanı **YOKTUR**. Bu yüzden:
   *   - `idempotencyKey` → süreç içi `sessions` haritası.
   *   - Anahtarın "aynı dosya" olduğu `storageKey|bytes|mimeType` üçlüsüyle
   *     doğrulanır. FARKLI bir dosya aynı anahtarla gelirse bu artık mükerrer
   *     DEĞİLDİR (farklı bir iş) ve yeni container açılır.
   *   - Süresi dolmuş container yenilenir (Meta 24 saat sonra `EXPIRED`
   *     döner; aynı `creation_id` ile yeniden kullanılamaz).
   * KORUMA SÜREÇ İÇİDİR: süreç yeniden başlarsa harita boşalır. Kalıcılık
   * `publish_jobs.idempotencyKey` sütununda (db katmanı) zaten vardır; bu
   * katman yalnız aynı süreç içindeki çağrıları kapatır.
   */
  async startPublish(input: PublishInput): Promise<StartResult> {
    this.counts.start += 1;
    const key = input.idempotencyKey;
    const mediaKey = mediaFingerprint(input.media);

    const existing = this.sessions.get(key);
    if (existing !== undefined && existing.mediaKey === mediaKey && !isPast(existing.expiresAt, this.now())) {
      return {
        kind: "uploadUrl",
        externalId: existing.containerId,
        uploadUrl: existing.uploadUrl,
        expiresAt: existing.expiresAt,
        state: "processing",
      };
    }

    if (!(input.media.bytes > 0)) {
      throw new PermanentPublishError(
        `Container açılamaz: medya ${input.media.bytes} bayt. Boş dosya için container ` +
          "oluşturulmaz; yerinde kalıcı hata verilir.",
        "media_rejected",
        "empty_media",
      );
    }

    const caption = this.resolveCaption(input);
    const response = await this.send({
      method: "POST",
      url: this.graphUrl(`/${encodeURIComponent(input.account.externalId)}/media`),
      what: "Container açılamadı",
      account: input.account,
      body: buildContainerBody({
        caption,
        aiGenerated: input.copy.aiGenerated,
        shareToFeed: true,
      }),
    });
    if (!response.ok) throw classifyMetaFailure(response, "Container açılamadı");

    const ref = readContainerRef(response.json);
    if (ref === null) {
      // 200 geldi ama container kimliği yok: bayt GÖNDERİLMEDİ, dolayısıyla
      // mükerrer yayın riski yok → geçici sınıf.
      throw new RetryablePublishError(
        `Container isteği 200 döndü ama gövdede \`id\`/\`uri\` yok (gövde: ` +
          `${response.body.slice(0, 300)}). Bayt gönderilmediği için yeniden denemek güvenli.`,
        "transient",
        null,
        "missing_container_id",
        null,
        response.status,
      );
    }

    const expiresAt = new Date(this.now() + INSTAGRAM_CONTAINER_TTL_SEC * 1000).toISOString();
    const uploadUrl = resolveUploadUrl(ref);
    this.sessions.set(key, { containerId: ref.containerId, uploadUrl, expiresAt, mediaKey });

    return {
      kind: "uploadUrl",
      externalId: ref.containerId,
      uploadUrl,
      expiresAt,
      state: "processing",
    };
  }

  // ── uploadParts ──────────────────────────────────────────────────────────

  /**
   * Baytları `rupload` adresine gönderir ve **kaldığı yerden** devam eder.
   *
   * OFSET HESABI — `offset = session.uploadedParts * partSize`.
   * `partSize` önce `session.partSizeBytes`'tan okunur (motor oturumu kalıcı
   * yazdığı için bu değer süreç yeniden başlasa da aynıdır), yoksa yapılandırma
   * değeri kullanılır. **Neden oturumdaki değer kazanır:** offset aritmetiği
   * parça boyutuna BAĞLIDIR; süreç yeniden başlarken sabit değişmişse
   * `uploadedParts × yeni boyut` yanlış ofset üretir ve Meta "offset çakıştı"
   * ile reddeder. Bu yüzden oturumdaki değer kilitlenir.
   *
   * GÖNDERİLEN BAYTLAR — yalnız `[offset, offset + length)` aralığı:
   * `length = min(partSize, totalBytes - offset)`. Son parça küçüktür.
   * Gövde belleğe ALINMAZ: `openRange` bir `fs.ReadStream` döner.
   *
   * `done` — `UploadProgress.done` sözleşmesi "TÜM baytlar gönderildi mi"
   * der. Bu yüzden `done = offset + length >= totalBytes`; orta parçada gönderilen
   * bir parça için `done: false` ve `nextOffset` doludur. Meta her çağrıda
   * `offset` beklediği için bu bilgi motorun kaldığı yeri doğru izlemesini sağlar.
   *
   * BAŞARISIZLIK — `debug_info.retriable` kararı verir:
   *   `true`  → `RetryablePublishError` (aynı ofsetle tekrar gönderilebilir)
   *   `false` → `PermanentPublishError` (aynı ofsetle tekrar gönderilemez)
   * Alan YOKSA HTTP durumuna düşülür ve 4xx (oturum/eylem sırası hatası)
   * KALICI sayılır: baytların kısmı yüklenmiş olabilir, sessizce tekrarlamak
   * veri bozar.
   */
  async uploadParts(input: PublishInput, session: UploadSession): Promise<UploadProgress> {
    this.counts.upload += 1;
    const totalBytes = input.media.bytes;
    if (!(totalBytes > 0)) {
      throw new PermanentPublishError(
        `Yükleme yapılamaz: ${totalBytes} bayt. Container açılmış olsa bile gövde boş.`,
        "media_rejected",
        "empty_media",
      );
    }
    const containerId = this.containerIdFrom(input, session);
    if (this.openRange === null) {
      throw new PermanentPublishError(
        "Instagram adaptörü bayt aralığı okuyacak bir kaynağa bağlı değil. " +
          "`openRange` ya da `resolvePath` seçeneği verilmelidir; aksi halde 300 MB " +
          "gövde belleğe alınamaz ve yükleme sessizce yapılamaz.",
        "validation",
        "range_source_missing",
      );
    }

    const partSize =
      Number.isFinite(session.partSizeBytes) && session.partSizeBytes > 0
        ? Math.floor(session.partSizeBytes)
        : this.partSizeBytes;
    const offset = Math.max(0, session.uploadedParts) * partSize;

    if (offset >= totalBytes) {
      // Tüm baytlar önceki turlarda gönderilmiş. Yeni istek YOK: aynı ofseti
      // tekrar göndermek Meta'da "offset çakıştı" hatası üretir.
      return {
        uploadedParts: session.uploadedParts,
        totalParts: totalPartsOf(totalBytes, partSize),
        done: true,
        nextOffset: null,
      };
    }
    const length = Math.min(partSize, totalBytes - offset);
    const body = await this.openRange({
      storageKey: input.media.storageKey,
      offset,
      length,
    });

    let response: InstagramHttpResponse;
    try {
      response = await this.client.send({
        method: "POST",
        url: this.ruploadUrl(containerId),
        headers: {
          // ⚠️ `OAuth`, `Bearer` DEĞİL. `rupload.facebook.com` Graph API
          // değildir; `Bearer` gönderilirse 400 döner.
          authorization: `OAuth ${input.account.accessToken}`,
          offset: String(offset),
          file_size: String(totalBytes),
          "content-type": "video/mp4",
          "content-length": String(length),
        },
        body,
        timeoutMs: this.uploadTimeoutMs,
      });
    } catch (err) {
      throw asPublishTransportError(err, `Yükleme gönderilemedi (offset=${offset})`);
    }

    if (response.status === 200 || response.status === 201) {
      const nextOffset = offset + length;
      const done = nextOffset >= totalBytes;
      return {
        uploadedParts: session.uploadedParts + 1,
        totalParts: totalPartsOf(totalBytes, partSize),
        done,
        nextOffset: done ? null : nextOffset,
      };
    }

    throw classifyMetaFailure(response, `Yükleme reddedildi (offset=${offset})`, {
      sessionGone: true,
    });
  }

  // ── pollPublish ──────────────────────────────────────────────────────────

  /**
   * Container durumunu okur ve gerekiyorsa YAYINLAR.
   *
   * Durum makinesi:
   *   `IN_PROGRESS` → `processing` + `retryAfterMs: 60_000` (Meta dakikada bir
   *                  öneriyor; `status.status` alanı varsa arşivde korunur).
   *   `FINISHED`    → HENÜZ YAYINLANMAMIŞ demektir: `POST /media_publish`
   *                  çağrısı YAPILIR, sonra permalink okunur.
   *   `PUBLISHED`   → yayın tamam; permalink "en iyi çaba" ile okunur.
   *   `EXPIRED`     → `PermanentPublishError("container_expired")`. 24 saat
   *                  geçmiş bir container YENİDEN KULLANILAMAZ; yeniden denemek
   *                  anlamsız, bu yüzden THROW edilir (motor işi kalıcı kapatır).
   *   `ERROR`       → `status` alanı hata kodunu taşır; `mapMetaError` ile
   *                  sınıflandırılır ve `PollResult.error` olarak DÖNER (motor
   *                  `handleFailure` ile kapatır). Kota (9/2207042) kalıcı,
   *                  -2/2207003 geçici olur.
   *
   * PERMALINK YOKSA `published_no_link`: permalink okuma HATASI yayını
   * GERİ ALMAZ (medya zaten yayınlandı, `media_publish` çağrısı geri
   * alınamaz). `permalink: null` + `state: "published"` döner; motor
   * `finishPublished` içinde `published_no_link` durumuna çevirir.
   *
   * `providerStatus` YAYIN SONRASI durumu yazar: `FINISHED` ham kod DEĞİLDİR
   * (`INSTAGRAM_PUBLISHED_STATUS`).
   */
  async pollPublish(ctx: PollContext): Promise<PollResult> {
    this.counts.poll += 1;
    const containerId = ctx.externalId;
    if (typeof containerId !== "string" || containerId.trim() === "") {
      throw new PermanentPublishError(
        "Instagram yoklaması container kimliği olmadan yapılamaz (externalId boş). " +
          "Yüklenmemiş bir container yoklanamaz; kalıcı hata.",
        "validation",
        "unknown_external_id",
      );
    }
    const igUserId = ctx.account.externalId;
    if (typeof igUserId !== "string" || igUserId.trim() === "") {
      throw new PermanentPublishError(
        "Instagram yoklaması IG user id olmadan yapılamaz (account.externalId boş).",
        "validation",
        "unknown_ig_user_id",
      );
    }

    if (ctx.uploadUrlExpiresAt !== null && isPast(ctx.uploadUrlExpiresAt, this.now())) {
      throw new PermanentPublishError(
        `Container süresi doldu (${ctx.uploadUrlExpiresAt}); Instagram bu container'ı ` +
          "artık kabul etmez. Yeni container gerekir (yükleme baştan başlamalıdır).",
        "container_expired",
        "container_ttl",
        null,
        null,
      );
    }

    const response = await this.send({
      method: "GET",
      url: this.graphUrl(`/${encodeURIComponent(containerId)}`, {
        fields: "status_code,status",
      }),
      what: "Container durumu okunamadı",
      account: ctx.account,
    });
    if (!response.ok) throw classifyMetaFailure(response, "Container durumu okunamadı");

    const view = readContainerStatus(response.json);
    const mapped = mapMetaStatus(view.statusCode);

    if (mapped.status === "processing") {
      return {
        state: assertReachable("processing"),
        retryAfterMs: INSTAGRAM_CONTAINER_POLL_MS,
        providerStatus: mapped.providerCode,
      };
    }

    if (mapped.status === "expired") {
      throw new PermanentPublishError(
        `Container EXPIRED (${containerId}). Meta container'ı 24 saat sonra geçersiz ` +
          "kılar; aynı `creation_id` ile yeniden yayınlanamaz. Yeni container gerekir.",
        "container_expired",
        "EXPIRED",
        null,
        null,
      );
    }

    if (mapped.status === "failed") {
      const parsed = parseMetaStatusError(view.status);
      const hasCode = parsed.code !== null || parsed.subcode !== null;
      // `status` SAYI İÇERMİYORSA (salt insan metni) kod uydurulmaz: o zaman
      // `mapMetaStatus("ERROR")` kararı geçerlidir — `media_rejected` + kalıcı.
      // Bu, "belki geçcidir" deyip geçici saymaktan dürüsttür.
      const mapping = hasCode
        ? mapMetaError({ code: parsed.code, subcode: parsed.subcode })
        : { kind: mapped.kind ?? "media_rejected", message: mapped.message, providerCode: "ERROR" };
      return {
        state: assertReachable("processing"),
        providerStatus: mapping.providerCode === "" ? "ERROR" : mapping.providerCode,
        error: toFailureLite(
          mapping.kind,
          `Meta container işlemeyi başaramadı (status_code=ERROR, status="${
            view.status ?? "(yok)"
          }") — ${mapping.message}`,
          mapping.providerCode === "" ? null : mapping.providerCode,
          null,
        ),
      };
    }

    if (mapped.status === "ready" || mapped.status === "published") {
      // FINISHED: container işlendi ama medya YAYINLANMADI → publish gerekir.
      // PUBLISHED: başka bir yol yayınlamış olabilir; yeniden `media_publish`
      // çağırmak mükerrer yayın riski taşır, bu yüzden YALNIZCA permalink okunur.
      const alreadyPublished = mapped.status === "published";
      const mediaId = alreadyPublished
        ? containerId
        : await this.publishContainer(ctx.account, igUserId, containerId);
      const { permalink, productType } = await this.readPermalinkSafely(ctx.account, mediaId);
      // `FINISHED` container bu çağrıyla YAYINLANDI; ham kod ("FINISHED")
      // yayınlanmış bir işi arşivde "işleniyor" gibi gösterir ve `FEED`
      // ayrımında `FINISHED_FEED` gibi VAR OLMAYAN bir kod üretir. Her iki
      // yolda da nihai sağlayıcı durumu `PUBLISHED`'tir.
      const publishedCode = alreadyPublished ? mapped.providerCode : INSTAGRAM_PUBLISHED_STATUS;
      return {
        state: assertReachable("published"),
        remoteId: mediaId,
        permalink,
        providerStatus:
          productType !== null && productType !== INSTAGRAM_MEDIA_TYPE
            ? `${publishedCode}_${productType.toUpperCase()}`
            : publishedCode,
      };
    }

    // Tanımsız durum: geçici SAYILMAZ. `unknown` + kalıcı hata dönülür; motor
    // işi kapatır. (MetaStatus "bilinmeyen kod kalıcı kabul edildi" der.)
    return {
      state: assertReachable("processing"),
      providerStatus: mapped.providerCode === "" ? null : mapped.providerCode,
      error: toFailureLite(
        // `MetaStatusMapping.kind` `null` olabilir ("bu bir hata değil" demek);
        // bu dal zaten "hata üret" dalı olduğu için `null` → `unknown`.
        mapped.kind ?? "unknown",
        `Meta container durumu okunamadı (status_code=${view.statusCode ?? "(yok)"}) — ${mapped.message}`,
        mapped.providerCode === "" ? null : mapped.providerCode,
        null,
      ),
    };
  }

  // ── finalize ─────────────────────────────────────────────────────────────

  /**
   * `finalize` AĞ ÇAĞRISI YAPMAZ.
   *
   * Gerekçe: (a) geçici dosya yok — medya kalıcı anahtarda duruyor; (b) Meta'da
   * kapatılacak bir oturum/session yok (TikTok'nin `publish_status` sorgusu
   * gibi bir "kapat" çağrısı Instagram'da YOKTUR); (c) her `DELETE`/kota
   * harcanan bir çağrıdır. Oturum kaydı yalnız süreç belleğindedir, iş bitince
   * unutulur.
   */
  async finalize(_input: PublishInput, _result: PollResult): Promise<void> {
    this.counts.finalize += 1;
  }

  // ── readQuota ────────────────────────────────────────────────────────────

  /**
   * `content_publishing_limit` uç noktasından anlık kota okuması.
   *
   * **HARDCODE YAPILMAZ** — resmî sayfalar çeliştiği için (bkz. dosya başı).
   * Okunamazsa `null` döner: motor `enforceQuotaIfNeeded` `null` görünce yayını
   * ENGELLEMEZ, çünkü kısıt zaten Meta tarafında uygulanıyor; buradaki okuma
   * yalnızca "boşuna denemeyelim" ipucudur.
   *
   * `since` en fazla 24 saat öncesine gösterilir (doküman sınırı); daha eski bir
   * an istenirse Meta 400 döner.
   */
  async readQuota(account: AccountRef): Promise<QuotaSnapshot | null> {
    this.counts.quota += 1;
    const since = Math.floor((this.now() - INSTAGRAM_QUOTA_WINDOW_SEC * 1000) / 1000);
    let response: InstagramHttpResponse;
    try {
      response = await this.client.send({
        method: "GET",
        url: this.graphUrl(`/${encodeURIComponent(account.externalId)}/content_publishing_limit`, {
          fields: "quota_usage,config",
          since: String(since),
        }),
        headers: { authorization: `Bearer ${account.accessToken}` },
      });
    } catch (err) {
      throw asPublishTransportError(err, "Kota okunamadı");
    }
    // 404 (endpoint yok/izin yok), 403 (izin) ve 5xx → null: motor eski
    // davranışına döner. Hata fırlatmak yayını durdururdu; kotanın varlığı
    // yayın için ön koşul DEĞİLDİR.
    if (!response.ok) return null;
    return readQuotaView(response.json);
  }

  // ── delete (opsiyonel yetenek) ───────────────────────────────────────────

  /**
   * Yayını siler (`DELETE /{ig-media-id}`, `instagram_manage_contents`).
   *
   * `PublishAdapter` sözleşmesinde `delete` YOKTUR; bu bir OPSİYONEL yetenektir
   * ve motor tarafından çağrılmaz. Yanlışlıkla silinmiş yayını geri almak
   * mümkün olmadığı için metot açıkça adlandırılmış ve çağıran zorunlu tutulmuştur.
   */
  async deleteMedia(input: { account: AccountRef; mediaId: string }): Promise<boolean> {
    const response = await this.send({
      method: "DELETE",
      url: this.graphUrl(`/${encodeURIComponent(input.mediaId)}`),
      what: "Yayın silinemedi",
      account: input.account,
    });
    if (response.ok) return true;
    // 400/404 = "zaten silinmiş ya da yok". Silme İDEMPOTENT olmalıdır; bu
    // iki durum başarı sayılır, aksi halde tekrar denemek mümkün olmaz.
    if (response.status === 400 || response.status === 404) return true;
    throw classifyMetaFailure(response, "Yayın silinemedi");
  }

  // ── İç yardımcılar ──────────────────────────────────────────────────────

  private graphUrl(path: string, query?: Readonly<Record<string, string>>): string {
    const base = `${this.graphBase}/${GRAPH_API_VERSION}${path}`;
    if (query === undefined) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, value);
    const qs = params.toString();
    return qs === "" ? base : `${base}?${qs}`;
  }

  private ruploadUrl(containerId: string): string {
    return `${this.ruploadBase}/${GRAPH_API_VERSION}/${containerId}`;
  }

  private async send(input: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    what: string;
    account: AccountRef;
    body?: Record<string, unknown>;
  }): Promise<InstagramHttpResponse> {
    let response: InstagramHttpResponse;
    try {
      response = await this.client.send({
        method: input.method,
        url: input.url,
        headers: {
          authorization: `Bearer ${input.account.accessToken}`,
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch (err) {
      throw asPublishTransportError(err, input.what);
    }
    return response;
  }

  /**
   * `POST /{ig-user-id}/media_publish`.
   *
   * AYNI İSTEK İKİ KEZ GÖNDERİLMEZ: `PollContext` bu bilgiyi taşımadığı için
   * çağıranın `FINISHED` → `publish` zincirini yalnız bir kez kurması gerekir.
   * Meta `media_publish` çağrısını çoğaltmak aynı medyayı iki kez paylaşma
   * riski taşır; bu yüzden `MEDIA_PUBLISH` çağrısı `FINISHED` dalının İÇİNDE ve
   * tek yerde yapılır.
   */
  private async publishContainer(
    account: AccountRef,
    igUserId: string,
    containerId: string,
  ): Promise<string> {
    this.counts.publish += 1;
    const response = await this.send({
      method: "POST",
      url: this.graphUrl(`/${encodeURIComponent(igUserId)}/media_publish`),
      what: "Yayınlama (media_publish) başarısız",
      account,
      body: buildPublishBody(containerId),
    });
    if (!response.ok) throw classifyMetaFailure(response, "Yayınlama (media_publish) başarısız");
    const root = asRecord(response.json);
    const mediaId = root === null ? null : asText(root["id"]);
    if (mediaId === null) {
      // Yayın MUHTEMELEN oldu (200) ama medya kimliği okunamadı. Kalıcı hata
      // ÜRETMEK, yoksa "başarısız" görünen bir yayın aslında yayınlanmış olur
      // ve iş yeniden denendiğinde mükerrer paylaşım yapar. Bu yüzden
      // geçici sınıf + açıklama.
      throw new RetryablePublishError(
        `media_publish 200 döndü ama \`id\` yok (gövde: ${response.body.slice(0, 300)}). ` +
          "Yayın yapılmış olabilir; yeniden denemeden önce `/{ig-user-id}/media?fields=id` " +
          "ile doğrulanmalı.",
        "transient",
        null,
        "missing_media_id",
        null,
        response.status,
      );
    }
    return mediaId;
  }

  /** Permalink + `media_product_type` okuması. Hata YUTULUR (yayın geri alınamaz). */
  private async readPermalinkSafely(
    account: AccountRef,
    mediaId: string,
  ): Promise<{ permalink: string | null; productType: string | null }> {
    this.counts.permalink += 1;
    try {
      const response = await this.send({
        method: "GET",
        url: this.graphUrl(`/${encodeURIComponent(mediaId)}`, {
          fields: "permalink,media_product_type",
        }),
        what: "Permalink okunamadı",
        account,
      });
      if (!response.ok) return { permalink: null, productType: null };
      return { permalink: readPermalink(response.json), productType: readMediaProductType(response.json) };
    } catch {
      // Taşıma hatası da yutulur: medya YAYINLANDI. Permalink sonradan
      // tekrar okunabilir; yayını geri almak ise mümkün değildir.
      return { permalink: null, productType: null };
    }
  }

  /** Caption'ı 2200 karaktere SIKIŞTIRMADAN üretir; sığmıyorsa kalıcı hata. */
  private resolveCaption(input: PublishInput): string {
    const captionLimit = findLimit(this.spec.limits, "caption");
    const maxChars =
      typeof captionLimit?.max === "number" && captionLimit.max > 0
        ? captionLimit.max
        : undefined;
    const composed = composeCaptionDetailed(input.copy.caption, input.copy.hashtags, {
      ...(maxChars === undefined ? {} : { maxChars }),
      platform: "instagram",
    });
    if (composed.text === null) {
      throw new PermanentPublishError(
        `Caption üretilemedi: ${composed.problem ?? "bilinmeyen neden"} Metin kırpılmadı.`,
        "validation",
        "caption_too_long",
      );
    }
    return composed.text;
  }

  /** Container kimliği: süreç içi oturum kaydından, yoksa `uploadUrl`'dan. */
  private containerIdFrom(input: PublishInput, session: UploadSession): string {
    const known = this.sessions.get(input.idempotencyKey);
    if (known !== undefined) return known.containerId;
    // Süreç yeniden başlamışsa harita boştur: `rupload` adresinin son segmenti
    // container kimliğidir (`.../ig-api-upload/{version}/{container_id}`).
    const stripped = session.uploadUrl.replace(/\?.*$/, "").replace(/\/+$/, "");
    const fromUrl = /\/([^/]+)$/.exec(stripped);
    const candidate = fromUrl === null ? null : (fromUrl[1] ?? null);
    if (candidate !== null && candidate !== "" && /^[A-Za-z0-9_.:-]+$/.test(candidate)) {
      return candidate;
    }
    throw new PermanentPublishError(
      "Container kimliği bulunamadı (uploadUrl'dan okunamadı ve oturum kaydı yok). " +
        "Yükleme baştan başlatılmalıdır.",
      "validation",
      "unknown_container_id",
    );
  }
}

// ── Saf yardımcılar ─────────────────────────────────────────────────────────

/** `storageKey|bytes|mimeType` — "aynı dosya mı" sorusunun tek yanıtı. */
export function mediaFingerprint(media: MediaRef): string {
  return `${media.storageKey}|${media.bytes}|${media.mimeType}`;
}

/** `ceil(totalBytes / partSize)` — parça sayısı. */
export function totalPartsOf(totalBytes: number, partSize: number): number {
  if (!(partSize > 0)) return 0;
  return Math.ceil(Math.max(0, totalBytes) / partSize);
}

function toFailureLite(
  kind: PublishErrorKind,
  message: string,
  providerCode: string | null = null,
  httpStatus: number | null = null,
): PublishFailureLite {
  return { kind, message, providerCode, logId: null, httpStatus };
}

/** ISO metni geçmişte mi? Geçersiz/bozuk tarih "geçmişte" sayılmaz. */
export function isPast(iso: string | null | undefined, nowMs: number): boolean {
  if (typeof iso !== "string" || iso.trim() === "") return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms <= nowMs;
}

/**
 * Adaptörün döndürdüğü her durum `processing`'den GEÇİLEBİLİR olmalıdır.
 * Motor durum makinesine göre yazıyor; bir kontrol sözleşmeyi bozan sonucu
 * motora değil burada durdurur.
 */
function assertReachable(next: JobState): JobState {
  if (next !== "processing" && !canTransition("processing", next)) {
    throw new PermanentPublishError(
      `Instagram adaptörü geçersiz iş durumu üretti: processing → ${next}.`,
      "validation",
      "illegal_state",
    );
  }
  return next;
}