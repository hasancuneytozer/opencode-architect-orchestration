/**
 * HTTP SUNUCU — Fastify.
 *
 * ── DIŞA AKTARILAN TEK FONKSİYON: `buildServer(deps)` ──────────────────────
 * Testler sunucuyu `inject()` ile çağırır; PORT AÇILMAZ. Üretimde `main.ts`
 * `listen()` çağırır. Bu ayrım sayesinde rota mantığı gerçek HTTP isteğiyle,
 * ağ olmadan sınanır.
 *
 * ── GÜVENLİK (kısaltma yok) ────────────────────────────────────────────────
 *   * `SP_ADMIN_PASSWORD` yoksa oturum AÇILAMAZ (`not_configured`). Kör mod
 *     bir arıza değildir.
 *   * Parola `scrypt` hash'i üzerinden `timingSafeEqual` ile doğrulanır;
 *     düz metin hiçbir yerde saklanmaz.
 *   * Oturum token'ı 32 bayt; `httpOnly` + `sameSite=lax` + `path=/`.
 *   * `secure` YALNIZ `SP_PUBLIC_BASE_URL` `https://` ise.
 *   * CSRF: durum değiştiren isteklerde `Origin`/`Referer` kontrolü.
 *   * Giriş hız sınırı: dakikada 5 deneme → 429.
 *   * Ingest iki kanaldır: `X-Api-Key` (`sha256`, `revoked_at` dolu anahtar
 *     reddedilir) **ya da panel oturumu**; anahtar kanalında oturum GEREKMEZ.
 *   * Loglama: `Authorization`, `X-Api-Key`, çerez, gövde parolası pino
 *     `redact` ile ZORLA maskelenir (`src/http/logger.ts`).
 *   * Gövde: JSON 2 MB. Multipart `fileSize` 2 GB, dosya DİSKE akıtılır.
 *
 * ── NEDEN `X-Api-Key` OTURUM GEREKTİRMEZ ────────────────────────────────────
 * Ingest'i yapan taraf bir tarayıcı değil, bir AI projesinin CI betiği.
 * Çerez/CSRF mantığı tarayıcı içindir ve burada anlamsızdır; kimlik başlığın
 * kendisidir. Taşıma güvenliği HTTPS'te (`SP_PUBLIC_BASE_URL`).
 *
 * Aynı sebeple ingest oturumu da KABUL EDER (`requireSessionOrKey`): panel
 * insanın kendi konsoludur ve `POST /api/v1/assets` yetkisine zaten sahiptir.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { Writable } from "node:stream";

import {
  ContentStateSchema,
  JobStateSchema,
  PLATFORMS,
  PLATFORM_LABELS,
  type Platform,
  type ValidationFinding,
} from "../contract/index.js";
import { canRequeueForRetry } from "../domain/stateMachine.js";
import type { AppConfig } from "../config/index.js";
import type {
  AccountRepo,
  ApiKeyRepo,
  AssetRepo,
  AuditRepo,
  ContentRepo,
  CredentialRepo,
  Db,
  ProjectRepo,
  PublishJobRepo,
} from "../db/index.js";
import { digestKey } from "../db/index.js";
import {
  AssetUploadError,
  IngestService,
  IngestSourceError,
  IngestValidationError,
  createApiKey,
  uploadAsset,
  type IngestResult,
} from "../ingest/index.js";
import { getSpec, validateMedia } from "../media/index.js";
import {
  DEFAULT_ANALYTICS_TIMEZONE,
  DEFAULT_COLLECT_LIMIT,
  REQUIRED_ANALYTICS_SCOPES,
  VIEWS_COUNTING_CHANGE_DATE,
  comparePeriods,
  daySpan,
  eachDay,
  isMetricDate,
  metricDate,
  shiftDays,
} from "../analytics/index.js";
import type {
  AdditiveMetricKey,
  CollectOptions,
  CollectOutcome,
  GetForContentOptions,
  MetricUnavailableReason,
  RollupResult,
} from "../analytics/index.js";
import type { ContentMetricRecord, MetricListFilter } from "../db/index.js";
import type { Account } from "../contract/index.js";
import type {
  AuthProvider,
  CredentialCipher,
  FfmpegProbe,
  MediaStore,
  Transcoder,
} from "../ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../ports/index.js";
import type { Clock, PublishService, TickResult } from "../services/index.js";
import {
  HttpError,
  errorEnvelope,
  fromFastifyError,
  notConfigured,
  notFound,
  okEnvelope,
  unauthorized,
  validationFailed,
} from "./errors.js";
import { createLogger } from "./logger.js";
import { serveFile } from "./media.js";
import { buildSetupReport, type SetupReport } from "./setup.js";
import type { SchedulerHandle } from "./scheduler.js";
import {
  LOGIN_LIMIT_PER_WINDOW,
  LOGIN_WINDOW_MS,
  LoginRateLimiter,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  csrfOk,
  hashPassword,
  isStateChanging,
  normalizeOrigin,
  verifyPassword,
  type Session,
} from "./security.js";

/** Uygulama sürümü. Panel gösterir; `package.json` ile eşleşmesi zorunlu değil. */
export const APP_VERSION = "0.1.0";

/** JSON gövde üst sınırı: 2 MB. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

/**
 * Multipart dosya üst sınırı: 2 GB.
 *
 * Neden 2 GB ve TikTok'ın 4 GB sınırı değil: yerel disk "dolsun" demek değildir.
 * 2 GB pratik video üst sınırının üzerindedir ve bir klasörü kazara yüklemeyi
 * engeller.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Multipart alan sayısı ve alan başına metin üst sınırı. */
const MAX_MULTIPART_FIELDS = 64;
const MAX_FIELD_BYTES = 64 * 1024;

/**
 * OAuth `state` ömrü (ms): 10 dakika.
 *
 * Neden 10 ve 1 değil: Google'da hesap seçimi + onay ekranı, ilk kez izin
 * veren bir kullanıcıda 2-3 dakikayı bulabiliyor; 1 dakikalık TTL gerçek
 * yetkilendirmeleri iptal ederdi. 10 dakika ise bir `state`'in ele geçirilip
 * oynatılması için hâlâ çok kısa bir pencere (CSRF penceresi = süre).
 */
const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Depoda `resolveKey`/`pathFor` bulunan medya deposu (`FsMediaStore`). */
export type HttpMediaStore = MediaStore & {
  resolveKey(key: string): string;
  readStream?(key: string): NodeJS.ReadableStream;
};

export interface BuildServerDeps {
  config: AppConfig;
  db: Db;
  repos: {
    projects: ProjectRepo;
    assets: AssetRepo;
    contents: ContentRepo;
    accounts: AccountRepo;
    credentials: CredentialRepo;
    jobs: PublishJobRepo;
    audit: AuditRepo;
    apiKeys: ApiKeyRepo;
  };
  store: HttpMediaStore;
  probe: FfmpegProbe;
  /**
   * Kapak karesi üretimi. **Verilmezse `probe` nesnesinden türetilir**
   * (bkz. `resolveTranscoder`): `main.ts` tek bir ffmpeg nesnesini hem `probe`
   * hem `transcoder` olarak kuruyor, zorunlu ikinci bir alan eklemek üretimde
   * kapak üretimini yine sessizce düşürürdü.
   */
  transcoder?: Transcoder;
  ingest: IngestService;
  publisher: PublishService | null;
  scheduler: SchedulerHandle | null;
  clock: Clock;
  /** HMAC imza sırrı (medya imzalı adresleri). `FsMediaStore` ile AYNI olmalı. */
  mediaSecret: string;
  version?: string;
  /** Testler: pino çıktısını yakalamak için akış. */
  logStream?: Writable;
  /** Loglama kapalı (testlerde gürültü). */
  logsEnabled?: boolean;
  /** Gerçek adaptörü olan platformlar (`/health.mode`, kurulum raporu). */
  liveAdapters?: ReadonlySet<Platform>;
  /**
   * Analitik servisi (`AnalyticsService`).
   *
   * OPSİYONEL: `null`/verilmezse analitik rotaları `503 not_configured`
   * döner. Zorunlu alan olsaydı `test/http/helpers.ts` içindeki ortak kurulum
   * da değişmek zorunda kalırdı; eksik bağlama sessizce "0 ölçüm" gibi
   * görünmesin diye kapı AÇIK ve dürüst bir hata kodudur.
   */
  analytics?: AnalyticsReader | null;
  /**
   * Analitik adaptörü BAĞLI olan platformlar.
   *
   * `overview.mode` ve kartlardaki "ölçüm kaynağı bağlı değil" gerekçesi
   * bundan gelir. Yayın adaptörlerinden (`liveAdapters`) ayrıdır: YouTube
   * yayın için yapılandırılmışken analitik izni eksik olabilir.
   */
  analyticsPlatforms?: ReadonlySet<Platform>;
  /**
   * OAuth sağlayıcıları (`platform → AuthProvider`).
   *
   * `main.ts` YALNIZ `isConfigured` sırasına göre bağlar: sır olmayan
   * platformun sağlayıcısı haritada BULUNMAZ ve `/auth/:platform/start`
   * 503 `not_configured` döner. Paneldeki "Yapılandırılmamış" düğmesi ile
   * buradaki cevap aynı gerçeği anlatır.
   */
  authProviders?: ReadonlyMap<Platform, AuthProvider>;
  /**
   * Belirteç şifre çözücüsü (`SP_MASTER_KEY`'den türetilir).
   *
   * `null`/verilmezse hesap bağlama **çalışmaz**: belirteç şifrelenemeyen
   * bir hesap kaydı oluşturmak, düz metin token saklamakla aynıdır. Bu
   * yüzden callback 503 döner ve HESAP OLUŞTURMAZ.
   */
  cipher?: CredentialCipher | null;
}

/**
 * HTTP katmanının analitikten ihtiyaç duyduğu YÜZEY.
 *
 * Neden `AnalyticsService` değil: sınıfın `private` alanları vardır ve bu yüzden
 * YAPISAL (structural) değildir; testlerin sahte servis geçmesi imkânsız olurdu.
 * Arayüz yalnız public metotları içerir, `AnalyticsService` ona sorunsuz atanır
 * ve testler `{ getForPlatform: () => ... }` gibi bir sahte geçebilir.
 */
export interface AnalyticsReader {
  getForContent(contentId: string, options?: GetForContentOptions): RollupResult;
  getForPlatform(platform: Platform, from: string, to: string, delayDays?: number): RollupResult;
  listForContent(contentId: string, filter?: MetricListFilter): ContentMetricRecord[];
  previousWindow(from: string, to: string): { from: string; to: string };
  collect(options?: CollectOptions): Promise<CollectOutcome>;
}

export interface BuiltServer {
  server: FastifyInstance;
  sessions: SessionStore;
  loginLimiter: LoginRateLimiter;
  /** Parola özeti veya `null` (`SP_ADMIN_PASSWORD` yok → kör mod). */
  adminHash: string | null;
}

export async function buildServer(deps: BuildServerDeps): Promise<BuiltServer> {
  const { config } = deps;
  const startedAt = deps.clock.now().getTime();

  const sessions = new SessionStore(
    SESSION_TTL_MS,
    undefined,
    () => deps.clock.now().getTime(),
  );
  const loginLimiter = new LoginRateLimiter({
    limit: LOGIN_LIMIT_PER_WINDOW,
    windowMs: LOGIN_WINDOW_MS,
    now: () => deps.clock.now().getTime(),
  });
  // Parola düz metni ASLA saklanmaz; yalnız scrypt özeti tutulur.
  const adminHash = config.adminPassword ? hashPassword(config.adminPassword) : null;

  const server = Fastify({
    // Neden `loggerInstance` ve `logger` değil: Fastify v5'te `logger` ALANI
    // düz bir SEÇENEK NESNESİ olmak zorundadır; hazır bir pino örneği verilirse
    // sunucu açılışta `FST_ERR_LOG_INVALID_LOGGER_CONFIG` fırlatır. `createLogger`
    // zaten tam bir pino örneği döndürdüğü için alan `loggerInstance`'tır.
    loggerInstance: createLogger({
      level: config.logLevel,
      destination: deps.logStream,
      enabled: deps.logsEnabled ?? true,
    }) as FastifyBaseLogger,
    bodyLimit: MAX_JSON_BYTES,
    trustProxy: false,
  });

  await server.register(fastifyCookie);
  await server.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: MAX_MULTIPART_FIELDS,
      fieldSize: MAX_FIELD_BYTES,
    },
  });
  await server.register(fastifyStatic, {
    // Arayüz dağıtımı: `web/dist` yoksa hata fırlatmaz, rota 404 döner.
    root: config.dataDir,
    prefix: "/static/",
    decorateReply: false,
    index: false,
    wildcard: false,
  });

  const ctx: Ctx = {
    config,
    db: deps.db,
    projects: deps.repos.projects,
    assets: deps.repos.assets,
    contents: deps.repos.contents,
    accounts: deps.repos.accounts,
    credentials: deps.repos.credentials,
    jobs: deps.repos.jobs,
    audit: deps.repos.audit,
    apiKeys: deps.repos.apiKeys,
    store: deps.store,
    probe: deps.probe,
    transcoder: resolveTranscoder(deps),
    clock: deps.clock,
    sessions,
    loginLimiter,
    adminHash,
    mediaSecret: deps.mediaSecret,
    version: deps.version ?? APP_VERSION,
    liveAdapters: deps.liveAdapters ?? new Set<Platform>(),
    startedAt,
    ingestService: deps.ingest,
    analytics: deps.analytics ?? null,
    analyticsPlatforms: deps.analyticsPlatforms ?? new Set<Platform>(),
    authProviders: deps.authProviders ?? new Map<Platform, AuthProvider>(),
    cipher: deps.cipher ?? null,
    oauthStates: new Map<string, PendingOAuthState>(),
  };

  // ── Zarf: 404 ve hata yakalayıcı ──────────────────────────────────────────
  server.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorEnvelope("not_found", `Uç nokta yok: ${request.method} ${request.url}`));
  });

  server.setErrorHandler((error, request, reply) => {
    const httpError = fromFastifyError(error);
    // Kriter DURUM DEĞİL, KODDUR. `not_configured` (503) ve `not_implemented`
    // (501) bilinçli olarak seçilmiş 5xx zarflarıdır; `status >= 500`
    // ölçütü onları da "beklenmeyen hata" sanıp `internal_error`'a çeviriyordu
    // ve panel "yapılandırılmamış" ile "çöktü" ayrımını kaybediyordu.
    if (httpError.code === "internal_error") {
      // 5xx AYRINTISI loglanır, İSTEMCİYE GİTMEZ: yol, SQL veya stack
      // sızıntısı yerel uygulamada bile gereksiz bilgidir.
      request.log.error({ err: error, url: request.url }, "sunucu hatası");
      reply.code(httpError.status).send(
        errorEnvelope("internal_error", "Beklenmeyen bir hata oluştu."),
      );
      return;
    }
    request.log.info(
      { code: httpError.code, status: httpError.status, url: request.url },
      "istek reddedildi",
    );
    reply.code(httpError.status).send(
      errorEnvelope(httpError.code, httpError.message, httpError.details),
    );
  });

  // ── CSRF ─────────────────────────────────────────────────────────────────
  server.addHook("onRequest", async (request) => {
    if (!isStateChanging(request.method)) return;
    // Ingest başlığıyla gelen istek CSRF dışıdır: çerez taşımıyor.
    if (request.headers["x-api-key"]) return;
    if (!csrfOk({
      expectedOrigins: expectedOrigins(request, config),
      method: request.method,
      path: request.url,
      headers: request.headers as Record<string, string | string[] | undefined>,
    })) {
      throw new HttpError(
        "csrf_failed",
        "İstek kökeni (Origin/Referer) sunucu kökeniyle uyuşmuyor; istek reddedildi.",
      );
    }
  });

  registerHealthRoutes(server, ctx, deps);
  registerAuthRoutes(server, ctx);
  registerSetupRoutes(server, ctx);
  registerProjectRoutes(server, ctx);
  registerAssetRoutes(server, ctx);
  registerContentRoutes(server, ctx, deps);
  registerJobRoutes(server, ctx);
  registerAccountRoutes(server, ctx);
  registerSchedulerRoutes(server, ctx, deps);
  registerIngestRoutes(server, ctx, deps);
  registerAnalyticsRoutes(server, ctx);
  registerMediaRoutes(server, ctx);

  return { server, sessions, loginLimiter, adminHash };
}

// ── Bağımlılık paketi ───────────────────────────────────────────────────────

/**
 * Başlatılmış ama tamamlanmamış OAuth akışı.
 *
 * `state` CSRF korumasıdır: kullanıcı tarayıcıdan sağlayıcıya gider, orada
 * onaylar, geri döner. Dönüşte `state` bilinmiyorsa istek BİZİM BAŞLATTMADIĞIMIZ
 * bir akışa ait demektir — kabul edilmez.
 */
interface PendingOAuthState {
  platform: Platform;
  /** Oturumu açan kişi. Dönüşte aynı kişi olmalı. */
  actor: string;
  createdAt: number;
  /**
   * Yetkilendirme adresine gönderilen yönlendirme adresi.
   *
   * Neden saklanıyor ve `config`'den yeniden OKUNMUYOR: OAuth'un değişmez
   * kuralı `redirect_uri` her iki istekte **AYNI** olmalıdır. Akış ortasında
   * `.env` değişirse (kullanıcı yanlış URI'yi düzeltir) geri çağırma,
   * başlangıçta gönderilenden FARKLI bir URI ile kod değişimi yapmaya
   * çalışır, sağlayıcı `invalid_grant` döner ve kullanıcı "bağlandım" sanıp
   * hiçbir şeyin değişmediğini görür. Başlangıçta ne gittiyse onunla dönülür.
   */
  redirectUri: string;
}

interface Ctx {
  config: AppConfig;
  db: Db;
  projects: ProjectRepo;
  assets: AssetRepo;
  contents: ContentRepo;
  accounts: AccountRepo;
  /** OAuth sonrası belirteçlerin şifreli saklandığı depo. */
  credentials: CredentialRepo;
  /**
   * OAuth sağlayıcıları, platform → `AuthProvider`. Sır girilmemiş platform
   * **haritada bulunmaz**; `/api/v1/auth/:platform/start` o durumda 503 döner.
   */
  authProviders: ReadonlyMap<Platform, AuthProvider>;
  /**
   * Belirteç şifreleyici. `null` ise hesap bağlama **yapılamaz**: token
   * düz metin saklanamaz, o yüzden 503 döner ve hesap oluşturulmaz.
   */
  cipher: CredentialCipher | null;
  /**
   * Başlatılan OAuth akışları. Bellekte tutulur: süreç yeniden başlarsa
   * eski `state` geçersiz sayılır — bu doğru davranıştır, çünkü `state`
   * CSRF korumasıdır ve TTL'si dolmuş demektir.
   */
  oauthStates: Map<string, PendingOAuthState>;
  jobs: PublishJobRepo;
  audit: AuditRepo;
  apiKeys: ApiKeyRepo;
  store: HttpMediaStore;
  probe: FfmpegProbe;
  /**
   * Kapak üretimi. `undefined` ise yükleme yine de çalışır ama
   * `asset.cover_skipped` denetim kaydı yazılır (bkz. `AssetOnlyDeps`).
   */
  transcoder: Transcoder | undefined;
  clock: Clock;
  sessions: SessionStore;
  loginLimiter: LoginRateLimiter;
  adminHash: string | null;
  mediaSecret: string;
  version: string;
  liveAdapters: ReadonlySet<Platform>;
  startedAt: number;
  /** Multipart ingest, `IngestService`'i doğrudan çağırır. */
  ingestService: IngestService;
  /** Analitik servisi. `null` ise rotalar `503 not_configured` döner. */
  analytics: AnalyticsReader | null;
  /** Analitik adaptörü bağlı platformlar (`mode`, kart gerekçeleri). */
  analyticsPlatforms: ReadonlySet<Platform>;
}

/**
 * `POST /api/v1/assets` yüklemesinin kapak üretebilmesi için `Transcoder`
 * çözümlenir.
 *
 * KURAL TEK: açıkça verilen `deps.transcoder` kazanır; yoksa `deps.probe`
 * nesnesi `Transcoder` yeteneklerini taşıyorsa O kullanılır.
 *
 * NEDEN `probe`'dan türetiliyor: uygulama kökünde (`main.ts`) `getFfmpegTools()`
 * çıktısı TEK nesnedir ve `probe`, `transcoder` alanlarına aynı nesne geçer
 * (`IngestService` ve `PublishService` zaten böyle kurulur). `buildServer`'a
 * ayrı bir `transcoder` alanı ZORUNLU olarak eklenseydi `main.ts`'in de
 * değişmesi gerekirdi; eklenmezse kapak üretimi üretimde yine kapanır
 * (`cover_skipped`) ve panelde her varlık kapaksız görünür.
 *
 * `Transcoder` YETENEKLERİNİN KENDİSİ kontrol edilir (`grabCover` +
 * `toFeedReady`), nesnenin sınıfı değil: port arayüzleri yapısal (structural)
 * tiplerdir ve testler yalnız `probe` uygulayan sahte bir nesne geçebilir.
 * Böyle bir nesne için sonuç `undefined`'tir ve `asset.cover_skipped` yazılır —
 * yani "kapak üretemedim" sessizce yutulmaz.
 */
function resolveTranscoder(deps: BuildServerDeps): Transcoder | undefined {
  if (deps.transcoder !== undefined) return deps.transcoder;
  const candidate = deps.probe as Partial<Transcoder>;
  const isTranscoder =
    typeof candidate.grabCover === "function" && typeof candidate.toFeedReady === "function";
  return isTranscoder ? (deps.probe as FfmpegProbe & Transcoder) : undefined;
}

// ── Kimlik doğrulama yardımcıları ───────────────────────────────────────────

/** Oturum zorunlu rotalar için kapı. Cookie geçersizse 401. */
function requireSession(ctx: Ctx, request: FastifyRequest): void {
  sessionOf(ctx, request);
}

/**
 * Oturumu ÇÖZER; yoksa aynı 401'i fırlatır.
 *
 * Neden ikinci yol: OAuth `state`'i bir oturuma BAĞLANIR ("dönüşte aynı kişi
 * olmalı"). `requireSession` yalnız "geçerli mi" diyordu, KİM olduğunu
 * söylemiyordu; ikinci bir doğrulama yazmak "biri unutuldu" demektir.
 */
function sessionOf(ctx: Ctx, request: FastifyRequest): Session {
  if (!ctx.adminHash) {
    throw unauthorized("SP_ADMIN_PASSWORD tanımlı değil; oturum açılamaz.");
  }
  const session = ctx.sessions.get(readCookie(request, SESSION_COOKIE), ctx.clock.now().getTime());
  if (!session) throw unauthorized("Oturum yok veya süresi dolmuş.");
  return session;
}

/**
 * Akışı BAĞLADIĞIMIZ oturumun belirteci.
 *
 * Neden oturumun kendisi, "panel" sabiti değil: uygulama TEK yönetici parolası
 * kullanır, yani "hangi kişi" sorusunun cevabı her zaman aynıdır ve sabit bir
 * `actor` ile eşleşme kontrolü HİÇBİR ŞEY denetlemez olurdu. Oturum belirteci
 * kontrolü gerçektir: başka bir tarayıcıda geçerli bir oturum, bu akışı
 * tamamlayamaz. Belirteç yalnız süreç belleğinde tutulur, loglanmaz ve
 * denetime yazılmaz.
 */
function sessionToken(ctx: Ctx, request: FastifyRequest): string {
  return sessionOf(ctx, request).token;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.cookies?.[name];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Bu isteğin kabul edilen kökenleri. */
function expectedOrigins(request: FastifyRequest, config: AppConfig): string[] {
  const out: string[] = [];
  if (config.publicBaseUrl) out.push(config.publicBaseUrl);
  const host = request.headers.host;
  if (typeof host === "string" && host.length > 0) {
    // `Host` başlığı SPOOF EDİLEBİLİR; yalnız `Origin` ile birlikte ve isteğin
    // kendi hedefi olarak kullanılır (`trustProxy: false`: `X-Forwarded-*`
    // güvenilmez sayılır, tünel `publicBaseUrl` ile karşılanır).
    out.push(`http://${host}`);
    out.push(`https://${host}`);
  }
  return out;
}

/**
 * Ingest kanalı: `X-Api-Key`.
 *
 * Önce `api_keys` tablosu (özet karşılaştırma, iptal denetimi), sonra
 * `SP_INGEST_KEYS` ortam anahtarları. İkisi de `sha256` üzerinden ve sabit
 * zamanlı karşılaştırılır; ham anahtar hiçbir yerde saklanmaz ya da
 * karşılaştırılmaz.
 */
function requireIngestKey(ctx: Ctx, request: FastifyRequest): { keyId: string | null } {
  const raw = request.headers["x-api-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unauthorized("X-Api-Key başlığı eksik.");
  }
  const trimmed = value.trim();

  const record = ctx.apiKeys.lookup(trimmed);
  if (record) {
    ctx.apiKeys.touch(record.id, ctx.clock.now().toISOString());
    recordAudit(ctx, "ingest", "auth.api_key", "api_key", record.id, {
      prefix: record.prefix,
    });
    return { keyId: record.id };
  }

  // Ortam anahtarları: `lookup` zaten `revoked_at IS NULL` filtresiyle aradı.
  const wanted = Buffer.from(digestKey(trimmed), "hex");
  for (const envKey of ctx.config.ingestKeys) {
    const candidate = Buffer.from(digestKey(envKey), "hex");
    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) {
      return { keyId: null };
    }
  }
  throw unauthorized("Ingest anahtarı geçersiz veya iptal edilmiş.");
}

function recordAudit(
  ctx: Ctx,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown>,
): void {
  try {
    ctx.audit.record({ actor, action, targetType, targetId, detail });
  } catch {
    // Denetim yazılamazsa akış DURMAZ: kaydın kaybolması, işin yapılmamasından
    // daha kötüdür.
  }
}

// ── Sağlık ──────────────────────────────────────────────────────────────────

interface HealthBody {
  ok: boolean;
  version: string;
  uptimeSec: number;
  db: "ok" | "error";
  scheduler: {
    running: boolean;
    tickMs: number;
    lastTickAt: string | null;
    nextTickAt: string | null;
  };
  mode: "mock" | "live";
}

function registerHealthRoutes(
  server: FastifyInstance,
  ctx: Ctx,
  deps: BuildServerDeps,
): void {
  server.get("/api/health", async (_request, reply) => {
    let dbState: "ok" | "error" = "ok";
    try {
      ctx.db.prepare("SELECT 1 AS ok").get();
    } catch {
      dbState = "error";
    }
    const body: HealthBody = {
      ok: dbState === "ok",
      version: ctx.version,
      uptimeSec: Math.max(0, Math.floor((ctx.clock.now().getTime() - ctx.startedAt) / 1000)),
      db: dbState,
      scheduler: deps.scheduler?.status() ?? {
        running: false,
        tickMs: ctx.config.schedulerTickMs,
        lastTickAt: null,
        nextTickAt: null,
      },
      // SAHTE adaptör kullanılıyorsa dürüstçe "mock". Kullanıcı sahte yayın
      // yaptığını BİLMELİDİR.
      mode: ctx.liveAdapters.size > 0 ? "live" : "mock",
    };
    reply.code(body.ok ? 200 : 500);
    return okEnvelope(body);
  });
}

// ── Oturum ──────────────────────────────────────────────────────────────────

const LoginBody = z.object({ password: z.string().min(1).max(4096) }).strict();

function registerAuthRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body ?? {});
    if (!parsed.success) throw validationFailed("Gövde geçersiz: { password } bekleniyor.");

    // Hız sınırı ÖNCE: parola doğrulanmasa bile deneme SAYILIR, yoksa kaba
    // kuvvet saldırganı yanlış parolalarla sınırı hiç tüketmezdi.
    const key = rateKey(request);
    const nowMs = ctx.clock.now().getTime();
    if (!ctx.loginLimiter.allow(key, nowMs)) {
      const retryAfterSec = Math.ceil(ctx.loginLimiter.retryAfterMs(key, nowMs) / 1000);
      reply.header("retry-after", String(Math.max(1, retryAfterSec)));
      throw new HttpError("rate_limited", "Çok fazla deneme; lütfen bekleyin.");
    }

    if (!ctx.adminHash) {
      recordAudit(ctx, "panel", "auth.login_not_configured", "session", "-", { ip: key });
      throw new HttpError("not_configured", "SP_ADMIN_PASSWORD tanımlı değil; oturum açılamaz.");
    }

    // Karşılaştırma HASH üzerinden ve sabit zamanlıdır. Parola düz metni
    // BURADA loglanmaz. Başarısızlık `not_configured` ile AYNI biçimde
    // görünmez ama mesajı da "parola var mı" sızdırmaz.
    if (!verifyPassword(parsed.data.password, ctx.adminHash)) {
      recordAudit(ctx, "panel", "auth.login_failed", "session", "-", { ip: key });
      throw unauthorized("Parola yanlış.");
    }

    ctx.loginLimiter.reset(key);
    const session = ctx.sessions.create(nowMs);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isSecurePublicUrl(ctx.config.publicBaseUrl),
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    // Denetime token'ın kendisi YAZILMAZ: yalnız ilk 8 karakter (arama için
    // yeterli, geri çağırmak için değil).
    recordAudit(ctx, "panel", "auth.login", "session", session.token.slice(0, 8), {
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    return okEnvelope({ authenticated: true });
  });

  server.post("/api/v1/auth/logout", async (request, reply) => {
    ctx.sessions.destroy(readCookie(request, SESSION_COOKIE));
    // Çerez de SİLİNİR: yalnız bellekteki kaydı düşürmek tarayıcıda geçerli
    // ama ölü bir çerez bırakır.
    reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax" });
    return okEnvelope({ authenticated: false });
  });

  server.get("/api/v1/session", async (request) => {
    const configured = ctx.adminHash !== null;
    const session = ctx.sessions.get(
      readCookie(request, SESSION_COOKIE),
      ctx.clock.now().getTime(),
    );
    const report = safeSetupReport(ctx);
    const body: {
      authenticated: boolean;
      mode: SetupReport["mode"];
      configProblems: SetupReport["problems"];
      reason?: string;
    } = {
      authenticated: Boolean(configured && session),
      mode: report.mode,
      configProblems: report.problems,
    };
    if (!configured) body.reason = "not_configured";
    else if (!session) body.reason = "no_session";
    return okEnvelope(body);
  });

  // OAuth akışı: sahte adaptörde 501. Sahte bir yetkilendirme adresi üretmek
  // kullanıcıyı "bağlandım" sanmaya yol açardı.
  // ── OAuth: hesap bağlama ───────────────────────────────────────────────────
  //
  // İKİ UÇ, TEK KURAL: `state` üretimi BİZİMDİR, geri çağırma yalnızca
  // bizim ürettiğimiz `state`'i kabul eder. Sağlayıcı (Google/Meta/TikTok)
  // `state`'i imzalamaz; doğrulaması bellekteki `oauthStates` eşleşmesidir.
  // Bu yüzden `AuthProvider.expectedState` VERİLMEZ: her istek kendi
  // `state`'ini üretir, saklar ve aynısını bekler.

  server.get("/api/v1/auth/:platform/start", async (request) => {
    const session = sessionOf(ctx, request);
    const platform = platformParam(request.params as { platform: string });
    const provider = ctx.authProviders.get(platform);
    if (!provider) {
      throw notConfigured(missingProviderMessage(ctx, platform));
    }
    const redirectUri = requireRedirectUri(ctx, platform);

    // CSRF `state`: 32 bayt → base64url (43 karakter, tahmin edilemez).
    // `randomBytes` bilerek `Math.random` DEĞİLDİR: `state` tahmin edilebilir
    // olursa saldırgan kendi kodunu kurumuzun hesabına bağlatabilir.
    const state = randomBytes(32).toString("base64url");
    ctx.oauthStates.set(state, {
      platform,
      // `actor` = oturumun KENDİSİ. "Aynı kişi" demek "aynı oturum" demektir:
      // başka bir tarayıcı/sekmede geçerli bir oturum, bu akışı tamamlayamaz.
      actor: sessionToken(ctx, request),
      createdAt: ctx.clock.now().getTime(),
      redirectUri,
    });

    // Analitik kapsamları YAYIN kapsamlarına EKLENİR (sağlayıcılar kendi
    // zorunlu kümesiyle birleştirir). Ayrı listeler `src/analytics/scopes.ts`
    // ve adaptörlerin `auth.ts` dosyalarında; ayrı kalsalardı yayın çalışır
    // ama ÖLÇÜM hiç gelmezdi (`no_scope`), çünkü analitik adaptörü izinleri
    // `credentials.scopes` sütunundan okur.
    let url: string;
    try {
      url = provider.authorizeUrl(state, redirectUri, [
        ...REQUIRED_ANALYTICS_SCOPES[platform],
      ]);
    } catch (err) {
      // Sağlayıcı `authorizeUrl`'ı reddedebilir (TikTok `https` şartı, Meta
      // fragment yasağı). Kullanıcı boş bir hata ekranı görmemeli: `.env`
      // anahtarının ADI söylenir.
      ctx.oauthStates.delete(state);
      throw validationFailed(
        `${PLATFORM_LABELS[platform]} yetkilendirme adresi üretilemedi: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    recordAudit(ctx, "panel", "auth.start", "account", platform, {
      // `state` DENETİME YAZILMAZ: CSRF sırrıdır; logda vektör olur.
      hasState: true,
      redirectOrigin: safeOrigin(redirectUri),
    });
    return okEnvelope({ url });
  });

  server.get("/api/v1/auth/:platform/callback", async (request, reply) => {
    const platform = platformParam(request.params as { platform: string });
    // Oturum zorunludur: `state` "bu akışı biz başlattık" diyor, `actor`
    // "onu BAŞLATAN oturum" diyor. Oturumsuz geri çağırma reddedilir.
    requireSession(ctx, request);

    const q = request.query as Record<string, string | undefined>;
    const code = queryValue(q["code"]);
    const state = queryValue(q["state"]);
    if (code === null || state === null) {
      throw validationFailed(
        "Eksik geri çağırma parametresi: `code` ve `state` ikisi de gerekir.",
        { hasCode: code !== null, hasState: state !== null },
      );
    }

    // `state` BİLİNMİYORSA reddet — en kritik CSRF kapısı. Kurbanın tarayıcısı
    // saldırganın `state`'iyle gelirse Map'te o `state` YOKTUR.
    const pending = ctx.oauthStates.get(state);
    if (!pending) {
      throw validationFailed("Bilinmeyen `state`: akış bizim tarafımızda başlatılmamış.");
    }
    // TEK KULLANIMLILIK: ilk okumada SİLİNİR. Aynı `state` ile ikinci bir
    // geri çağırma yeniden oynatılamaz (yetkilendirme kodu zaten tek kullanımlık
    // olsa da CSRF penceresi kapatılmadan saldırı yüzeyi açık kalır).
    ctx.oauthStates.delete(state);

    if (pending.platform !== platform) {
      throw validationFailed("`state` başka bir platformun akışına ait.");
    }
    if (ctx.clock.now().getTime() - pending.createdAt > OAUTH_STATE_TTL_MS) {
      throw validationFailed("`state` süresi doldu; akışı yeniden başlatın.");
    }
    // Oturum eşleşmesi: akışı başlatan oturum dönmek ZORUNDA. Aksi halde
    // saldırgan kendi hesabının kodunu, kurbanın tarayıcısında açık bir oturum
    // çereziyle gönderip hesabı kendi tarafına bağlayabilirdi.
    if (pending.actor !== sessionToken(ctx, request)) {
      throw validationFailed("Bu akışı başlatan oturumla dönülmedi.");
    }

    const provider = ctx.authProviders.get(platform);
    if (!provider) {
      throw notConfigured(missingProviderMessage(ctx, platform));
    }
    // Şifre ÇÖZÜCÜ YOKSA hesap OLUŞTURULMAZ. Belirteç şifrelenemeyen bir
    // hesap kaydı düz metin saklamakla aynıdır; bu yüzden kapı token
    // değişiminden ÖNCE gelir (sağlayıcıya ağ çağrısı bile yapılmaz).
    if (!ctx.cipher) {
      throw notConfigured(
        "SP_MASTER_KEY tanımlı değil: belirteçler şifrelenemediği için hesap " +
          "bağlanamaz. Hesap kaydı oluşturulmadı.",
      );
    }

    try {
      const linked = await provider.exchangeCode({
        code,
        state,
        redirectUri: pending.redirectUri,
      });

      const account = linkAccount(ctx, platform, linked);
      // `refreshToken: null` sözleşmede "yeni yenileme belirteci DÖNMEDİ"
      // demektir → ESKİSİ KORUNUR. `null` buraya yazılsaydı bir sonraki
      // yenileme denemesi elindeki tek geçerli belirteci kaybederdi.
      const previous = ctx.credentials.getByAccountId(account.id);
      const refreshEnc =
        linked.refreshToken === null || linked.refreshToken === undefined
          ? previous?.refreshTokenEnc ?? null
          : ctx.cipher.seal(linked.refreshToken);

      ctx.credentials.save({
        accountId: account.id,
        platform,
        accessTokenEnc: ctx.cipher.seal(linked.accessToken),
        refreshTokenEnc: refreshEnc,
        tokenExpiresAt: linked.expiresAt ?? null,
        scopes: linked.scopes,
        // Hesabın sağlayıcı tarafındaki kimliği. `accounts.external_id` ile aynı
        // değerdir ama ayrı sütun: hesap silinip yeniden bağlanmada eşleşme
        // kaydı buradan okunur.
        providerUserId: linked.externalId,
      });

      // Token DENETİME YAZILMAZ. Yalnız hangi platforma bağlandı.
      recordAudit(ctx, "panel", "account.linked", "account", account.id, {
        platform,
        externalId: linked.externalId,
        scopes: linked.scopes,
        // `linkedPageId` (Meta) bilerek SAKLANMAZ: şema onun için bir sütun
        // içermiyor ve IG yayın yolu sayfa kimliğini değil uzun ömürlü
        // belirteci kullanıyor; uydurma bir sütuna yazmak veri kaybı olurdu.
        hasLinkedPage: linked.linkedPageId !== undefined && linked.linkedPageId !== null,
      });

      return reply
        .code(303)
        .header("location", accountsHashPath(platform, { linked: platform, ok: "1" }))
        .send();
    } catch (err) {
      // Sağlayıcı hatası kullanıcıya ZARFLA değil, PANELE dönüşle bildirilir:
      // geri çağırma tarayıcının adres çubuğunda açılır, JSON zarf göremez.
      // URL'de yalnız KISA KOD olur — mesaj/hata metni ASLA (proxy günlüğüne
      // ve tarayıcı geçmişine sızar). Ayrıntı sunucu logunda ve denetimde.
      const kind = err instanceof PermanentPublishError ? err.kind : "unknown";
      recordAudit(ctx, "panel", "account.link_failed", "account", "-", {
        platform,
        // `providerCode` bir hata KODUDUR (token değil); yine de kısa tutulur.
        reason: err instanceof PermanentPublishError ? err.providerCode ?? null : null,
        kind,
      });
      return reply
        .code(303)
        .header(
          "location",
          accountsHashPath(platform, {
            linked: platform,
            error: shortErrorCode(kind),
          }),
        )
        .send();
    }
  });
}

/**
 * Panelin hesap sayfası hash rotası. Panel yönlendiricisi `location.hash`
 * okur (`web/src/lib/router.ts`), bu yüzden yol `/api/v1/accounts` DEĞİL
 * `/#/accounts`'tir. Sunucu `publicBaseUrl`'i bilse de onu KULLANMAZ: pano
 * başka bir origin'de servis ediliyor olabilir ve yönlendirme adresi
 * `.env`'deki `SP_*_REDIRECT_URI` ile AYNI olmak zorundadır (OAuth kuralı).
 */
function accountsHashPath(platform: Platform, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return `/#/accounts?${search}`;
}

/**
 * Hata sınıfını URL'de taşınabilecek kısa koda indirger.
 *
 * Neden eşleme gerekiyor: `PublishErrorKind` değerleri `validation` gibi
 * teknik ve `network` gibi belirsizdir. Panel bunları tanımaz; sabit üç kod
 * (bilinen durumlar) + `unknown` güvenli taraftır.
 */
function shortErrorCode(kind: string): string {
  switch (kind) {
    case "auth":
      return "auth_failed";
    case "validation":
      return "invalid_request";
    case "ratelimit":
      return "rate_limited";
    case "policy":
      return "policy";
    default:
      return "unknown";
  }
}

/** Yönlendirme adresinin yalnız kökeni (yol/sorgu sır olabilir). */
function safeOrigin(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

/** Sorgu parametresi: boş/eksik → null (yok ile boş AYNI sayılır). */
function queryValue(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Sağlayıcı yoksa ne yazılır?
 *
 * Mesaj, `/api/v1/setup`'un döndürdüğü EKSİK ANAHTAR ADLARINI birebir taşır:
 * kullanıcı iki yerde de aynı cümleyi okur, iki ayrı sözlük öğrenmez. Eksik
 * anahtar yoksa (sağlayıcı bağlanmamış ama `.env` dolu — ör. sağlayıcı
 * `isConfigured` false) mesaj bunu DÜRÜSTÇE söyler.
 */
function missingProviderMessage(ctx: Ctx, platform: Platform): string {
  const report = safeSetupReport(ctx);
  const missing = report.platforms.find((p) => p.platform === platform)?.missing ?? [];
  const label = PLATFORM_LABELS[platform];
  if (missing.length === 0) {
    return (
      `${label} OAuth sağlayıcısı bağlı değil. Eksik anahtar yok görünüyor; ` +
      "sağlayıcı bu sunucuda kurulmamış ya da `isConfigured` false döndü. " +
      "Kurulum raporu: /api/v1/setup"
    );
  }
  return (
    `${label} OAuth sağlayıcısı bağlı değil. Eksik anahtarlar: ${missing.join(", ")}. ` +
    "Bu anahtarlar tanımlanmadan hesap bağlanamaz. Adımlar: /api/v1/setup, " +
    "docs/KIMLIK-KURULUMU.md"
  );
}

/**
 * Yetkilendirme adresinde kullanılacak yönlendirme adresi.
 *
 * Neden `config`'ten ve neden 503: `AuthProvider.authorizeUrl(state, uri,
 * scopes)` URI'yi bizden ALIR; port bilinçli olarak taşımaz (aynı sağlayıcı
 * farklı ortamlarda farklı URI kullanabilir). URI yoksa yetkilendirme adresi
 * YANLIŞ üretilir ve kullanıcı Google'da onayladıktan sonra "redirect_uri
 * mismatch" alır — hatayı Google'ın yüzünden önlemek buradaki kapıdır.
 */
function requireRedirectUri(ctx: Ctx, platform: Platform): string {
  const raw =
    platform === "instagram"
      ? ctx.config.meta.redirectUri
      : platform === "tiktok"
        ? ctx.config.tiktok.redirectUri
        : ctx.config.youtube.redirectUri;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    throw notConfigured(
      `${PLATFORM_LABELS[platform]} yönlendirme adresi tanımlı değil ` +
        `(${redirectEnvKey(platform)}); hesap bağlanamaz.`,
    );
  }
  return value;
}

function redirectEnvKey(platform: Platform): string {
  switch (platform) {
    case "instagram":
      return "SP_META_REDIRECT_URI";
    case "tiktok":
      return "SP_TIKTOK_REDIRECT_URI";
    case "youtube":
      return "SP_GOOGLE_REDIRECT_URI";
  }
}

/**
 * Hesabı oluşturur veya YENİLER.
 *
 * Aynı `externalId` ikinci kez gelirse **mükerrer hesap OLUŞMAZ**: `(platform,
 * external_id)` UNIQUE indeksli olduğu için `create` UNIQUE ihlaliyle PATLAR ve
 * kullanıcı "hesabımı iki kez bağladım ama hata aldım" görür. Doğru davranış
 * yeniden yetkilendirmedir: profil tazelenir, belirteçler yenilenir.
 */
function linkAccount(
  ctx: Ctx,
  platform: Platform,
  linked: {
    externalId: string;
    username: string | null;
    displayName: string;
  },
): Account {
  const existing = ctx.accounts.findByExternal(platform, linked.externalId);
  if (existing) {
    ctx.accounts.updateProfile(existing.id, {
      displayName: linked.displayName,
      username: linked.username,
    });
    return existing;
  }
  return ctx.accounts.create({
    platform,
    externalId: linked.externalId,
    displayName: linked.displayName,
    username: linked.username,
  });
}

function platformParam(params: { platform: string }): Platform {
  const value = String(params.platform ?? "");
  if ((PLATFORMS as readonly string[]).includes(value)) return value as Platform;
  // `.env.example` yönlendirme adresi `/auth/meta/callback` kullanıyor.
  if (value === "meta") return "instagram";
  throw validationFailed(`Bilinmeyen platform: "${value}".`, { allowed: [...PLATFORMS] });
}

function rateKey(request: FastifyRequest): string {
  return typeof request.ip === "string" && request.ip.length > 0 ? request.ip : "unknown";
}

/** `secure` çerez bayrağı: yalnız `https://` herkese açık adres varsa. */
export function isSecurePublicUrl(publicBaseUrl: string | null): boolean {
  if (!publicBaseUrl) return false;
  const origin = normalizeOrigin(publicBaseUrl);
  return origin !== null && origin.startsWith("https://");
}

// ── Kurulum ─────────────────────────────────────────────────────────────────

function registerSetupRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/setup", async () => okEnvelope(safeSetupReport(ctx)));
}

/** Rapor üretilemezse panel ÇÖKMEZ: geçerli ama boş bir rapor döner. */
function safeSetupReport(ctx: Ctx): SetupReport {
  try {
    return buildSetupReport({
      config: ctx.config,
      accounts: ctx.accounts,
      liveAdapters: ctx.liveAdapters,
    });
  } catch {
    return {
      mode: "mock",
      problems: [
        {
          severity: "warning",
          code: "setup_report_failed",
          message: "Kurulum raporu üretilemedi (veritabanı okunamadı?).",
          docAnchor: "KIMLIK-KURULUMU.md#41-tamamlanma-kontrol-listesi",
          envKeys: [],
        },
      ],
      platforms: PLATFORMS.map((platform) => ({
        platform,
        configured: false,
        missing: [],
        hasAccounts: false,
        reviewNeeded: false,
        liveAdapter: ctx.liveAdapters.has(platform),
        docAnchor: "KIMLIK-KURULUMU.md",
      })),
    };
  }
}

// ── Projeler ────────────────────────────────────────────────────────────────

const ProjectBody = z.object({
  name: z.string().min(1).max(120),
  notes: z.string().max(2000).nullish(),
}).strict();

function registerProjectRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/projects", async (request) => {
    requireSession(ctx, request);
    return okEnvelope(ctx.projects.list(200));
  });

  server.post("/api/v1/projects", async (request, reply) => {
    requireSession(ctx, request);
    const parsed = ProjectBody.safeParse(request.body ?? {});
    if (!parsed.success) throw validationFailed("Proje gövdesi geçersiz.", issues(parsed.error));
    // Aynı ad iki kez: `ensure` mevcut kaydı döner. UNIQUE ihlali 500 üretmek
    // "kullanıcı aynı projeyi iki kez açtı" bilgisini gizlerdi.
    const project = ctx.projects.ensure(parsed.data.name.trim(), parsed.data.notes ?? null);
    reply.code(201);
    return okEnvelope(project);
  });
}

// ── Varlıklar ───────────────────────────────────────────────────────────────

function registerAssetRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/assets", async (request) => {
    requireSession(ctx, request);
    const q = request.query as Record<string, string | undefined>;
    return okEnvelope(
      ctx.assets.listFiltered({
        projectId: q["projectId"],
        limit: intOrUndefined(q["limit"]),
        offset: intOrUndefined(q["offset"]),
      }),
    );
  });

  server.get("/api/v1/assets/:id", async (request) => {
    requireSession(ctx, request);
    return okEnvelope(requireAsset(ctx, request));
  });

  server.get("/api/v1/assets/:id/report", async (request) => {
    requireSession(ctx, request);
    const asset = requireAsset(ctx, request);
    // Platform başına ayrı doğrulama: aynı dosya için üç farklı sonuç
    // mümkündür (TikTok'ta 9:16 zorunlu değil, YouTube Shorts'ta zorunlu).
    // Anahtarlar `contract`'teki `Platform` değerlerinin kendisidir
    // (instagram | tiktok | youtube). Kısaltma (ig/tt/yt) panelin okuduğu
    // alanlarla uyuşmadığı için doğrulama raporu sessizce boş geliyordu.
    const perPlatform = Object.fromEntries(
      PLATFORMS.map((platform) => [platform, validateMedia(asset.info, getSpec(platform))]),
    ) as Record<Platform, ValidationFinding[]>;
    return okEnvelope({ info: asset.info, findings: asset.findings, perPlatform });
  });

  server.get("/api/v1/assets/:id/video", async (request, reply) => {
    requireSession(ctx, request);
    const asset = requireAsset(ctx, request);
    return serveFile(request, reply, {
      store: ctx.store,
      key: asset.storageKey,
      contentType: asset.mimeType || "video/mp4",
      cacheControl: "private, max-age=300",
    });
  });

  server.get("/api/v1/assets/:id/cover", async (request, reply) => {
    requireSession(ctx, request);
    const asset = requireAsset(ctx, request);
    if (!asset.coverKey) throw notFound("Kapak görseli");
    return serveFile(request, reply, {
      store: ctx.store,
      key: asset.coverKey,
      contentType: "image/jpeg",
      cacheControl: "private, max-age=300",
    });
  });

  server.post("/api/v1/assets", async (request, reply) => {
    requireSession(ctx, request);
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new HttpError("unsupported_media_type", "multipart/form-data bekleniyor (alan: file).");
    }
    const req = request as FastifyRequest & {
      file(): Promise<{
        file: NodeJS.ReadableStream;
        filename: string;
        fields?: Record<string, unknown>;
      } | null>;
    };
    const part = await req.file();
    if (!part) throw validationFailed('"file" alanı eksik.');

    const fields = normalizeFields(part.fields ?? {});
    const projectId = typeof fields["projectId"] === "string" ? fields["projectId"] : null;
    try {
      const result = await uploadAsset(
        {
          assets: ctx.assets,
          store: ctx.store,
          probe: ctx.probe,
          // Kapak üretimi bu bağımlılık olmadan YAPILAMAZ: `AssetOnlyDeps`
          // `transcoder`'ı opsiyonel tuttuğu için bu alan boş bırakılırsa
          // yükleme `coverKey: null` ile kapanır ve `GET /assets/:id/cover`
          // 404 döner. `resolveTranscoder` beklentiyi karşılamıyorsa
          // `uploadAsset` `asset.cover_skipped` denetim kaydı yazar.
          transcoder: ctx.transcoder,
          audit: ctx.audit,
          getSpec,
        },
        // Akış doğrudan depoya: 2 GB belleğe ALINMAZ.
        { stream: part.file, fileName: part.filename, projectId },
      );
      reply.code(result.reused ? 200 : 201);
      return okEnvelope(result.asset);
    } catch (err) {
      if (err instanceof AssetUploadError) {
        throw new HttpError(
          err.code === "too_large" ? "payload_too_large" : "validation_failed",
          err.message,
        );
      }
      throw err;
    }
  });
}

function requireAsset(ctx: Ctx, request: FastifyRequest) {
  const id = (request.params as { id: string }).id;
  const asset = ctx.assets.getById(id);
  if (!asset) throw notFound("Varlık");
  return asset;
}

/**
 * Multipart metin alanları: ilk değer alınır, dosya parçaları atlanır.
 *
 * Neden `unwrapField` gerekiyor: `@fastify/multipart` v8+'da `part.fields`
 * sözlüğü düz metni değil, ALAN DESKRİPTÖRÜ tutar:
 *   `{ type:'field', fieldname, value, ... }`
 * Eski sürümler düz metin verdiği için (ve `attachFieldsToBody` kipi de
 * nesne gövdesi üretebildiği için) iki biçim de kabul edilir. Tanımazsak
 * `project`, `platforms`, `autoSchedule` sessizce kaybolur ve multipart ingest
 * "Ingest isteği geçersiz" ile tüm alanları kaybetmiş olur.
 */
function normalizeFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    // Aynı alan iki kez geldiyse `raw` bir DİZİ olur; ilki kullanılır.
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value = unwrapField(first);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}

function unwrapField(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object") return entry;
  const record = entry as Record<string, unknown>;
  return "value" in record ? record["value"] : entry;
}

// ── İçerik ──────────────────────────────────────────────────────────────────

/**
 * Yamalanabilir alanlar. `state` YOK: içerik durumu işlerden türetilir
 * (`aggregateContentState`); elle yazılırsa panel gerçeği göstermeyen bir
 * durum gösterir.
 */
const PatchBody = z
  .object({
    copy: z.record(z.string(), z.unknown()).optional(),
    scheduledAt: z.string().nullish(),
    timezone: z.string().optional(),
    quietHours: z.object({ start: z.string(), end: z.string() }).nullish(),
    tags: z.array(z.string().max(60)).max(30).optional(),
    campaign: z.string().max(120).nullish(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

function registerContentRoutes(
  server: FastifyInstance,
  ctx: Ctx,
  deps: BuildServerDeps,
): void {
  server.get("/api/v1/content", async (request) => {
    requireSession(ctx, request);
    const q = request.query as Record<string, string | undefined>;
    const state = q["state"] ?? undefined;
    if (state && !ContentStateSchema.safeParse(state).success) {
      throw validationFailed(`Geçersiz içerik durumu: "${state}".`, {
        allowed: ContentStateSchema.options,
      });
    }
    return okEnvelope(
      ctx.contents.listFiltered({
        state: state as never,
        projectId: q["projectId"],
        campaign: q["campaign"],
        from: q["from"],
        to: q["to"],
        limit: intOrUndefined(q["limit"]),
        offset: intOrUndefined(q["offset"]),
      }),
    );
  });

  server.get("/api/v1/content/:id", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    const content = ctx.contents.getById(id);
    if (!content) throw notFound("İçerik");
    const asset = ctx.assets.getById(content.assetId);
    return okEnvelope({
      ...content,
      asset,
      jobs: ctx.jobs.listByContent(content.id),
      findings: asset?.findings ?? [],
    });
  });

  server.patch("/api/v1/content/:id", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    if (!ctx.contents.getById(id)) throw notFound("İçerik");
    const parsed = PatchBody.safeParse(request.body ?? {});
    if (!parsed.success) throw validationFailed("Yamalar geçersiz.", issues(parsed.error));

    const patch: Record<string, unknown> = {};
    for (const key of [
      "copy",
      "tags",
      "campaign",
      "requiresApproval",
      "quietHours",
      "timezone",
      "scheduledAt",
    ] as const) {
      if (parsed.data[key] !== undefined) patch[key] = parsed.data[key];
    }
    if (Object.keys(patch).length === 0) {
      throw validationFailed("Hiçbir alan gönderilmedi.");
    }
    ctx.contents.update(id, patch as never);
    recordAudit(ctx, "panel", "content.update", "content", id, {
      fields: Object.keys(patch),
    });
    return okEnvelope(ctx.contents.getById(id));
  });

  server.post("/api/v1/content/:id/approve", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    if (!ctx.contents.getById(id)) throw notFound("İçerik");
    ctx.contents.approve(id, "panel");
    const fresh = ctx.contents.getById(id);
    recordAudit(ctx, "panel", "content.approve", "content", id, {
      approvedBy: "panel",
      approvedAt: fresh?.approvedAt ?? null,
    });
    // Onay "sadece bayrak" değil, "yayına girebilir" demektir: kuyruk boşsa
    // (ingest `autoSchedule=false` idi) işler o an oluşturulur.
    const enqueued = ensureJobs(ctx, id);
    return okEnvelope({
      approvedAt: fresh?.approvedAt ?? null,
      approvedBy: fresh?.approvedBy ?? null,
      jobIds: enqueued.jobIds,
      skipped: enqueued.skipped,
    });
  });

  server.post("/api/v1/content/:id/publish-now", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    const content = ctx.contents.getById(id);
    if (!content) throw notFound("İçerik");
    if (!deps.publisher) {
      throw new HttpError("not_configured", "Yayın motoru yok (adaptör kaydı başarısız).");
    }
    // Onay kapısı motorun kendi işidir (`runJob` kontrol eder ve "onay
    // bekliyor" gerekçesiyle erteler). Burada ikinci bir kapı koymak, panelde
    // "yayınlandı" ama içerik taslak kaldı gibi karışık sonuçlar üretirdi.
    const jobs = ctx.jobs.listByContent(id);
    const active = jobs.filter((j) => j.state === "queued" || j.state === "failed");
    const results: unknown[] = [];
    for (const job of active) {
      results.push(await deps.publisher.publishNow(job.id));
    }
    recordAudit(ctx, "panel", "content.publish_now", "content", id, {
      jobs: active.length,
    });
    return okEnvelope({
      contentId: id,
      requested: active.length,
      results,
      jobs: ctx.jobs.listByContent(id),
    });
  });

  server.post("/api/v1/content/:id/cancel", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    if (!ctx.contents.getById(id)) throw notFound("İçerik");
    const canceled: string[] = [];
    for (const job of ctx.jobs.listByContent(id)) {
      if (job.state === "canceled") continue;
      // Yayınlanmış iş iptal EDİLEMEZ: permalink kalıcıdır, geri almak yanlış
      // bir iz bırakır.
      if (job.state === "published" || job.state === "published_no_link") continue;
      if (ctx.jobs.cancel(job.id)) canceled.push(job.id);
    }
    recordAudit(ctx, "panel", "content.cancel", "content", id, { canceled });
    return okEnvelope({ contentId: id, canceled, jobs: ctx.jobs.listByContent(id) });
  });
}

/**
 * İçerik için iş kuyruğunu tamamlar.
 *
 * `ingest` `autoSchedule=false` ile geldiyse hiç iş oluşturmamıştır; onay
 * verildiğinde işler o an kuyruğa alınır. `enqueueUnique` + UNIQUE indeks
 * ikinci çağrıda mükerrer iş üretmez.
 */
function ensureJobs(
  ctx: Ctx,
  contentId: string,
): { jobIds: string[]; skipped: Array<{ platform: Platform; reason: string }> } {
  const content = ctx.contents.getById(contentId);
  if (!content) return { jobIds: [], skipped: [] };
  const existing = ctx.jobs.listByContent(contentId);
  const jobIds: string[] = [];
  const skipped: Array<{ platform: Platform; reason: string }> = [];

  const fromCopy = Object.keys(content.copy ?? {}) as Platform[];
  const platforms = (
    fromCopy.length > 0 ? fromCopy : [...new Set(existing.map((j) => j.platform))]
  ).filter((p) => (PLATFORMS as readonly string[]).includes(p));

  const when = content.scheduledAt ?? ctx.clock.now().toISOString();
  for (const platform of platforms) {
    const already = existing.filter((j) => j.platform === platform && j.state !== "canceled");
    if (already.length > 0) {
      jobIds.push(...already.map((j) => j.id));
      continue;
    }
    const account = ctx.accounts.findActiveByPlatform(platform);
    if (!account) {
      skipped.push({
        platform,
        reason: `${platform} için yayına hazır (active) hesap yok; iş oluşturulmadı.`,
      });
      continue;
    }
    const job = ctx.jobs.enqueueUnique({
      contentId,
      platform,
      accountId: account.id,
      scheduledAt: when,
      idempotencyKey: `panel:${contentId}:${platform}:${account.id}`,
    });
    jobIds.push(job.id);
    recordAudit(ctx, "panel", "job.enqueue", "publish_job", job.id, {
      contentId,
      platform,
      accountId: account.id,
    });
  }
  if (jobIds.length > 0) ctx.contents.setState(contentId, "scheduled");
  return { jobIds, skipped };
}

// ── İşler ───────────────────────────────────────────────────────────────────

function registerJobRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/jobs", async (request) => {
    requireSession(ctx, request);
    const q = request.query as Record<string, string | undefined>;
    const state = q["state"] ?? undefined;
    if (state && !JobStateSchema.safeParse(state).success) {
      throw validationFailed(`Geçersiz iş durumu: "${state}".`, {
        allowed: JobStateSchema.options,
      });
    }
    const platform = q["platform"];
    if (platform && !(PLATFORMS as readonly string[]).includes(platform)) {
      throw validationFailed(`Geçersiz platform: "${platform}".`, { allowed: [...PLATFORMS] });
    }
    return okEnvelope(
      ctx.jobs.listFiltered({
        state: state as never,
        contentId: q["contentId"],
        platform: platform as Platform | undefined,
        limit: intOrUndefined(q["limit"]),
        offset: intOrUndefined(q["offset"]),
      }),
    );
  });

  server.get("/api/v1/jobs/:id", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    const job = ctx.jobs.getById(id);
    if (!job) throw notFound("İş");
    return okEnvelope(job);
  });

  server.post("/api/v1/jobs/:id/retry", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    const job = ctx.jobs.getById(id);
    if (!job) throw notFound("İş");
    if (!canRequeueForRetry(job.state)) {
      // `published → queued` bir durum GEÇİŞİ değildir, ikinci kez
      // yayınlama kapısıdır. Sessizce "başarılı" dönmek yanlış olur.
      throw new HttpError(
        "conflict",
        `İş "${job.state}" durumunda; yalnız "failed" işler yeniden kuyruğa alınabilir.`,
      );
    }
    const when = ctx.clock.now().toISOString();
    ctx.jobs.markState(id, "queued", {
      error: null,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      scheduledAt: when,
    });
    recordAudit(ctx, "panel", "job.retry", "publish_job", id, { scheduledAt: when });
    return okEnvelope(ctx.jobs.getById(id));
  });
}

// ── Hesaplar ────────────────────────────────────────────────────────────────

function registerAccountRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/accounts", async (request) => {
    requireSession(ctx, request);
    return okEnvelope(ctx.accounts.listByPlatform(undefined, 200));
  });

  server.delete("/api/v1/accounts/:id", async (request) => {
    requireSession(ctx, request);
    const id = (request.params as { id: string }).id;
    const account = ctx.accounts.getById(id);
    if (!account) throw notFound("Hesap");
    // Kimlik bilgileri ve işler CASCADE ile silinir. Yıkıcı ama kasıtlıdır:
    // kullanıcı "hesabı kaldır" dedi.
    ctx.accounts.remove(id);
    recordAudit(ctx, "panel", "account.remove", "account", id, {
      platform: account.platform,
      externalId: account.externalId,
    });
    return okEnvelope({ id, removed: true });
  });
}

// ── Zamanlayıcı ─────────────────────────────────────────────────────────────

function registerSchedulerRoutes(
  server: FastifyInstance,
  ctx: Ctx,
  deps: BuildServerDeps,
): void {
  server.get("/api/v1/scheduler", async (request) => {
    requireSession(ctx, request);
    return okEnvelope(
      deps.scheduler?.status() ?? {
        running: false,
        tickMs: ctx.config.schedulerTickMs,
        lastTickAt: null,
        nextTickAt: null,
      },
    );
  });

  server.post("/api/v1/scheduler/tick", async (request) => {
    requireSession(ctx, request);
    if (!deps.scheduler || !deps.publisher) {
      throw new HttpError("not_configured", "Zamanlayıcı/yayın motoru yok.");
    }
    const result: TickResult = await deps.scheduler.runOnce();
    return okEnvelope(result);
  });
}

// ── Ingest kanalı ───────────────────────────────────────────────────────────

const IngestBody = z
  .object({
    project: z.string().min(1).max(120),
    platforms: z.array(z.string()).min(1).max(3),
    sourcePath: z.string().optional(),
    sourceUrl: z.string().optional(),
    fileName: z.string().max(255).optional(),
    campaign: z.string().max(120).optional(),
    scheduledAt: z.string().optional(),
    timezone: z.string().optional(),
    quietHours: z.object({ start: z.string(), end: z.string() }).optional(),
    autoSchedule: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    batchId: z.string().max(120).optional(),
    defaultCopy: z.record(z.string(), z.unknown()).optional(),
    copy: z.record(z.string(), z.unknown()).optional(),
    aiDisclosure: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** Ingest gövdesi: zod ile kabuk doğrulama + alan normalleştirme. */
function parseIngestBody(raw: unknown): Record<string, unknown> {
  const parsed = IngestBody.safeParse(raw ?? {});
  if (!parsed.success) throw validationFailed("Ingest gövdesi geçersiz.", issues(parsed.error));
  return { ...parsed.data } as Record<string, unknown>;
}

/** `platforms` alanını `Platform[]` yapar (JSON dizi ya da "ig,tt" metni). */
function normalizePlatforms(raw: unknown): Platform[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim())
      : [];
  return list.filter((p): p is Platform =>
    typeof p === "string" && (PLATFORMS as readonly string[]).includes(p),
  );
}

/** Metin alanlarını JSON'a çevirir (multipart alanları metindir). */
function decodeJsonFields(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const key of ["copy", "defaultCopy", "quietHours", "aiDisclosure", "metadata", "tags"]) {
    const raw = out[key];
    if (typeof raw !== "string") continue;
    try {
      out[key] = JSON.parse(raw);
    } catch {
      throw validationFailed(`${key} alanı geçerli JSON değil.`);
    }
  }
  if (typeof out["autoSchedule"] === "string") {
    out["autoSchedule"] = ["1", "true", "yes", "on"].includes(
      String(out["autoSchedule"]).toLowerCase(),
    );
  }
  return out;
}

function requirePlatforms(platforms: Platform[]): Platform[] {
  if (platforms.length === 0) {
    throw validationFailed("En az bir geçerli platform seçilmeli.", { allowed: [...PLATFORMS] });
  }
  return platforms;
}

/** Ingest hatalarını HTTP'ye çevirir. Bilinmeyen hata `internal_error` kalır. */
function mapIngestError(ctx: Ctx, request: FastifyRequest, err: unknown, body: Record<string, unknown>, sourceKind: string): never {
  recordAudit(ctx, "ingest", "ingest.request", "ingest", "-", {
    project: body["project"] ?? null,
    sourceKind,
    ok: false,
  });
  void request;
  if (err instanceof IngestValidationError) throw validationFailed(err.message, err.details);
  if (err instanceof IngestSourceError) {
    throw new HttpError("validation_failed", err.message);
  }
  throw err;
}

async function ingestFromJson(
  ctx: Ctx,
  deps: BuildServerDeps,
  request: FastifyRequest,
): Promise<IngestResult> {
  const body = parseIngestBody(request.body);
  const platforms = requirePlatforms(normalizePlatforms(body["platforms"]));
  const hasUrl = typeof body["sourceUrl"] === "string" && body["sourceUrl"].length > 0;
  const source = hasUrl
    ? ({ kind: "url", url: body["sourceUrl"] } as const)
    : ({ kind: "path", path: String(body["sourcePath"] ?? "") } as const);
  try {
    return await deps.ingest.ingest({ ...body, platforms } as never, source as never);
  } catch (err) {
    mapIngestError(ctx, request, err, body, source.kind);
  }
}

/**
 * Multipart ingest. Dosya DISKE AKITILIR ve `IngestService`'e `path` kaynağı
 * olarak verilir; 2 GB'lık gövde belleğe alınmaz. Alanlar metin olduğu için
 * JSON alanları çözülür.
 */
async function ingestFromMultipart(
  ctx: Ctx,
  request: FastifyRequest,
): Promise<IngestResult> {
  const req = request as FastifyRequest & {
    file(): Promise<{
      file: NodeJS.ReadableStream;
      filename: string;
      fields?: Record<string, unknown>;
    } | null>;
    parts?(): AsyncIterable<unknown>;
  };
  const part = await req.file();
  if (!part) throw validationFailed('"file" alanı eksik.');

  const body = decodeJsonFields(normalizeFields(part.fields ?? {}));
  const platforms = requirePlatforms(normalizePlatforms(body["platforms"] ?? "instagram"));

  // Depoya akıt: `store.put` geçici anahtara yazar ve bayt sayısını döner.
  const tmpKey = `tmp/ingest/${ctx.clock.now().getTime().toString(36)}-${
    Math.floor(Math.random() * 1e9).toString(36)
  }`;
  let stored;
  try {
    stored = await ctx.store.put(tmpKey, part.file);
  } catch (err) {
    throw new HttpError(
      "payload_too_large",
      `Dosya yazılamadı (üst sınır ${MAX_UPLOAD_BYTES} bayt): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    const result = await ctx.ingestService.ingest(
      // `fileName` gövdeye konur. `IngestService` kalıcı anahtarı içerik
      // adresinden üretir (`uploads/<sha>/<sha>/dosya.mp4`), bu yüzden isim
      // ayrıca verilmezse kütüphanede video `mup3ebvl-e879ae` gibi bir depo
      // anahtarı olarak görünür — kullanıcının yüklediği ad değil.
      { ...body, platforms, fileName: part.filename || body["fileName"] } as never,
      { kind: "path", path: ctx.store.pathFor(stored.key) } as never,
    );
    return result;
  } catch (err) {
    mapIngestError(ctx, request, err, body, "multipart");
  } finally {
    // Geçici dosya kalıcı depoya zaten kopyalandı; kalıntı bırakılmaz.
    await ctx.store.remove(stored.key).catch(() => undefined);
  }
}

function registerIngestRoutes(
  server: FastifyInstance,
  ctx: Ctx,
  deps: BuildServerDeps,
): void {
  server.post("/api/v1/ingest", async (request, reply) => {
    // ── İKİ KİMLİK KANALI ────────────────────────────────────────────────
    // (1) `X-Api-Key`: AI projesinin CI betiği — değişmeyen yol.
    // (2) Oturum: PANELİN KENDİSİ. Panel zaten oturumla `/assets` yüklemesi
    //     yapabiliyor; aynı kişi içerik oluştururken "neden yükleyemiyorum"
    //     demek zorunda kalmamalı. Oturum yetkisi `POST /assets` ile AYNI
    //     seviyededir: ikisi de içerik üretir, ikisi de diske yazar.
    //     CSRF kapısı zaten çerez taşıyan isteği denetler; anahtar kanalı
    //     `onRequest` kancasındaki istisnadan yararlanır.
    const { actor, keyId } = requireSessionOrKey(ctx, request);
    if (actor === "panel") {
      // Anahtar kanalı `requireIngestKey` içinde `ingest`/`auth.api_key`
      // kaydı zaten yazıyor. Oturumda böyle bir kayıt YOK; panel yüklemesi
      // denetimde görünmezse "kimin yüklediği" sorusu cevapsız kalır.
      recordAudit(ctx, "panel", "ingest.panel_upload", "ingest", "-", { keyId });
    }
    const contentType = request.headers["content-type"] ?? "";
    const result = contentType.includes("multipart/form-data")
      ? await ingestFromMultipart(ctx, request)
      : await ingestFromJson(ctx, deps, request);

    // 200: istek başarıyla İŞLENDİ. `jobIds` boş olabilir (onay bekliyor ya da
    // doğrulama hatası) ve bu bir HTTP hatası DEĞİLDİR; gerekçe gövdede.
    reply.code(200);
    return okEnvelope(result);
  });

  server.get("/api/v1/ingest/keys", async (request) => {
    requireSession(ctx, request);
    // Ham anahtar YOK: yalnız id/ön ek/son kullanım/iptal damgası.
    return okEnvelope(
      ctx.apiKeys.list(200).map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        project: k.projectName,
        scopes: k.scopes,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
      })),
    );
  });

  server.post("/api/v1/ingest/keys", async (request, reply) => {
    requireSession(ctx, request);
    const parsed = z
      .object({ project: z.string().min(1).max(120).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) throw validationFailed("{ project } bekleniyor.");
    // Anahtar üretimi `src/ingest/apikeys.ts`: ham anahtar YALNIZCA burada
    // bir kez döner, veritabanına YAZILMAZ.
    const made = createApiKey(ctx.apiKeys, { project: parsed.data.project ?? null });
    recordAudit(ctx, "panel", "api_key.create", "api_key", made.id, {
      prefix: made.prefix,
      project: parsed.data.project ?? null,
    });
    reply.code(201);
    return okEnvelope({
      key: made.key,
      prefix: made.prefix,
      id: made.id,
      note: "Bu anahtar YALNIZCA şimdi gösterilir; kaybolursa yenisi üretin.",
    });
  });
}

// ── Analitik ────────────────────────────────────────────────────────────────

/**
 * Tarih penceresinin varsayılan genişliği (gün).
 *
 * Neden 30 ve 7 değil: IG verisi 48 saat gecikmelidir; 7 günlük pencere ilk iki
 * günü "ölçülmedi" gösterir ve kullanıcı her açılışta eksik veri sanır.
 */
const DEFAULT_ANALYTICS_DAYS = 30;

/** `series` ucu GÜN BAŞINA sorgu yapar; gün sayısı tavanla sınırlıdır. */
const MAX_ANALYTICS_SERIES_DAYS = 366;
const DEFAULT_ANALYTICS_SERIES_POINTS = 500;
const MAX_ANALYTICS_SERIES_POINTS = 2000;

/** `collect` uçunda `days=N` → azami `N × JOBS_PER_COLLECT_DAY` iş. */
const JOBS_PER_COLLECT_DAY = 25;
const MAX_ANALYTICS_COLLECT_DAYS = 365;

/** İçerik detayı seri satır tavanı (`listByContent` sayfalama tavanıyla aynı). */
const ANALYTICS_CONTENT_ROW_LIMIT = 500;

/**
 * Panelde gösterilecek kanonik metrikler.
 *
 * `plays`/`impressions` KALDIRILMIŞTIR ve burada YOKTUR: panelde görünür bir
 * kalıdırılmış sayı, kullanıcıya "ölçtük" izlenimi verir.
 */
const SERIES_METRIC_KEYS: readonly AdditiveMetricKey[] = [
  "reach",
  "views",
  "interactions",
  "likes",
  "comments",
  "saves",
  "shares",
];

interface AnalyticsWindow {
  from: string;
  to: string;
}

/** Panel kartlarında gösterilen metrik sütunları. */
interface AnalyticsSeriesPoint {
  date: string;
  platform: Platform;
  views: number | null;
  interactions: number | null;
  saves: number | null;
  shares: number | null;
  /** O gün için görülen iş sayısı (ölçülen + ölçülemeyen). */
  items: number;
  /** En az bir değeri olan iş sayısı. */
  measured: number;
  unavailable: { count: number; byReason: Record<MetricUnavailableReason, number> } | null;
}

/**
 * `null` = "bu metrik için ölçülen değer yok", `0` = "ölçüldü ve sıfır".
 *
 * `totals` her zaman SAYI'dIR; ayrım `contributors`'ta durur: hiçbir iş o
 * metriği sağlamadıysa toplam `0` olsa da cevap `null`'dur. Aksi halde panel
 * "hiç kimse izlememiş" der ve gerçek olan "henüz gelmedi" olur.
 */
function measuredValue(roll: RollupResult, key: AdditiveMetricKey): number | null {
  return roll.contributors[key] > 0 ? roll.totals[key] : null;
}

function analyticsQuery(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

/** Bugünün YEREL günü. Geçersiz yapılandırılmış saat diliminde çökmez. */
function analyticsToday(ctx: Ctx): string {
  try {
    return metricDate(ctx.clock.now(), ctx.config.timezone);
  } catch {
    return metricDate(ctx.clock.now(), DEFAULT_ANALYTICS_TIMEZONE);
  }
}

/** `YYYY-MM-DD` doğrulaması. Geçersizse 400 `validation_failed`. */
function analyticsDay(raw: string | undefined, label: string): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!isMetricDate(raw)) {
    throw validationFailed(`Geçersiz ${label} tarihi: "${raw}". Beklenen biçim YYYY-MM-DD.`, {
      field: label,
      value: raw,
    });
  }
  return raw;
}

/**
 * `from`/`to` → pencere. Verilmezse **son 30 gün** (`to` = bugünün yerel günü).
 *
 * Gelecek tarih REDDEDİLMEZ: kullanıcı yarın için boş bir pencere istemiş
 * olabilir ve veri yoksa boş dönmek doğru cevaptır. `to < from` ise mantıksız
 * bir pencere ve sessizce ters çevrilmemeli → 400.
 */
function analyticsWindow(
  ctx: Ctx,
  request: FastifyRequest,
  opts: { maxDays?: number } = {},
): AnalyticsWindow {
  const q = analyticsQuery(request);
  const to = analyticsDay(q["to"], "to") ?? analyticsToday(ctx);
  const from = analyticsDay(q["from"], "from") ?? shiftDays(to, -(DEFAULT_ANALYTICS_DAYS - 1));
  if (from > to) {
    throw validationFailed(`Tarih aralığı ters: from=${from}, to=${to}.`, { from, to });
  }
  const maxDays = opts.maxDays;
  if (maxDays !== undefined) {
    const days = daySpan(from, to);
    if (days > maxDays) {
      throw validationFailed(
        `Tarih aralığı çok uzun: ${days} gün (üst sınır ${maxDays}).`,
        { from, to, days, maxDays },
      );
    }
  }
  return { from, to };
}

/** `platform` sorgu parametresi. Verilmezse `null` (tümü). */
function analyticsPlatformParam(raw: string | undefined): Platform | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!(PLATFORMS as readonly string[]).includes(raw)) {
    throw validationFailed(`Geçersiz platform: "${raw}".`, { allowed: [...PLATFORMS] });
  }
  return raw as Platform;
}

function analyticsIntParam(
  raw: string | undefined,
  fallback: number,
  max: number,
  field: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw validationFailed(`${field} pozitif tam sayı olmalı: "${raw}".`, { field, value: raw });
  }
  return Math.min(value, max);
}

function requireAnalytics(ctx: Ctx): AnalyticsReader {
  if (ctx.analytics === null) {
    throw new HttpError(
      "not_configured",
      "Analitik servisi bağlı değil (ölçüm deposu kurulmadı).",
    );
  }
  return ctx.analytics;
}

/** Kart için "ölçüm kaynağı bağlı mı?" gerekçesi. */
function availabilityOf(
  ctx: Ctx,
  platform: Platform,
): { configured: boolean; reason: string | null } {
  if (ctx.analyticsPlatforms.has(platform)) return { configured: true, reason: null };
  return {
    configured: false,
    reason:
      `${platform} için ölçüm adaptörü bağlı değil; bu platformda ölçüm toplanmıyor. ` +
      "Kimlik kurulumundan sonra otomatik bağlanır.",
  };
}

/**
 * Kimlik kapısı: **oturum YA DA `X-Api-Key`**.
 *
 * AI projelerinin CI betiği tarayıcı değildir; `ingest` ile aynı anahtar
 * tablosunu kullanır. Başlık varsa geçersizse sessizce oturuma düşülmez —
 * `requireIngestKey` 401 fırlatır. Böylece "yanlış anahtar" sessizce "oturum
 * yok" görünmez.
 *
 * ── NEDEN İKİ KANAL ────────────────────────────────────────────────────────
 * `actor` alanı denetim kaydının sahibidir: anahtarla gelen istek `ingest`,
 * oturumla (panelden) gelen istek `panel` olarak işaretlenir. Böylece "bu içeriği
 * kim gönderdi" sorusu denetim dökümünde tek bakışta yanıtlanır.
 *
 * Oturumla gelen istek CSRF denetimine GİRER (çerez taşır); `X-Api-Key` ile
 * gelen istek `onRequest` kancasındaki istisnadan yararlanarak CSRF dışıdır.
 * Güvenlik farkı kaza değil, kanalın doğası: çerez taşıyan istek tarayıcıdan
 * gelir, başlık taşıyan istek CI'dan.
 */
function requireSessionOrKey(
  ctx: Ctx,
  request: FastifyRequest,
): { actor: "panel" | "ingest"; keyId: string | null } {
  const raw = request.headers["x-api-key"];
  const hasKey = typeof raw === "string" ? raw.trim() !== "" : Array.isArray(raw);
  if (hasKey) {
    const { keyId } = requireIngestKey(ctx, request);
    return { actor: "ingest", keyId };
  }
  requireSession(ctx, request);
  return { actor: "panel", keyId: null };
}

/** Günlük seri: aynı gün + aynı platform için SON kayıt kazanır. */
function buildContentSeries(
  records: readonly ContentMetricRecord[],
): Array<{
  date: string;
  platform: Platform;
  metrics: Record<string, number | null>;
  unavailable: { reason: MetricUnavailableReason; message: string } | null;
}> {
  const byKey = new Map<
    string,
    {
      date: string;
      platform: Platform;
      metrics: Record<string, number | null>;
      unavailable: { reason: MetricUnavailableReason; message: string } | null;
    }
  >();
  for (const record of records) {
    const metrics: Record<string, number | null> = {};
    for (const key of SERIES_METRIC_KEYS) {
      const value = record.metrics[key];
      metrics[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    byKey.set(`${record.platform}|${record.metricDate}`, {
      date: record.metricDate,
      platform: record.platform,
      metrics,
      unavailable:
        record.unavailable === null
          ? null
          : { reason: record.unavailable.reason, message: record.unavailable.message },
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform),
  );
}

/** `collect` sonucunun panel için okunabilir listesi. */
function buildCollectResults(outcome: CollectOutcome): Array<{
  jobId: string;
  ok: boolean;
  reason: string | null;
}> {
  const out: Array<{ jobId: string; ok: boolean; reason: string | null }> = [];
  for (const record of outcome.records) {
    out.push({
      jobId: record.jobId,
      // Yazıldı AMA "ölçülemiyor" ⇒ `ok:false`. Bu HATA DEĞİLDİR: eksik izin
      // ya da herkese açık olmayan içerik bir sonuçtur.
      ok: record.unavailable === null,
      reason: record.unavailable?.reason ?? null,
    });
  }
  for (const skip of outcome.skipped) {
    out.push({ jobId: skip.jobId, ok: false, reason: skip.reason });
  }
  return out;
}

function registerAnalyticsRoutes(server: FastifyInstance, ctx: Ctx): void {
  server.get("/api/v1/analytics/overview", async (request) => {
    requireSession(ctx, request);
    const analytics = requireAnalytics(ctx);
    const window = analyticsWindow(ctx, request);
    const only = analyticsPlatformParam(analyticsQuery(request)["platform"]);
    const targets = only === null ? [...PLATFORMS] : [only];
    const platforms = targets.map((platform) => {
      const roll = analytics.getForPlatform(platform, window.from, window.to);
      return {
        platform,
        totals: roll.totals,
        contributors: roll.contributors,
        rates: roll.rates,
        available: availabilityOf(ctx, platform),
        latestDate: roll.latestDate,
        itemCount: roll.itemCount,
        measuredCount: roll.measuredCount,
        noDataCount: roll.noDataCount,
        unavailableCount: roll.unavailableCount,
        unavailableReasons: roll.unavailableReasons,
        missingDataDays: roll.completeness.missingDataDays,
        completeness: roll.completeness,
      };
    });
    return okEnvelope({
      // `mock` = hiçbir platformda ölçüm adaptörü bağlı değil. Yayın modundan
      // AYRI: ölçüm sağlayıcı sırrı yokken yayın sahte olabilir ama ölçüm
      // adaptörü bağlı olabilir de.
      mode: ctx.analyticsPlatforms.size > 0 ? "live" : "mock",
      from: window.from,
      to: window.to,
      previous: analytics.previousWindow(window.from, window.to),
      platforms,
    });
  });

  server.get("/api/v1/analytics/content/:id", async (request) => {
    requireSession(ctx, request);
    const analytics = requireAnalytics(ctx);
    const contentId = (request.params as { id: string }).id;
    const content = ctx.contents.getById(contentId);
    if (!content) throw notFound("İçerik");
    const window = analyticsWindow(ctx, request);

    const rollup = analytics.getForContent(contentId, {
      from: window.from,
      to: window.to,
    });
    const records = analytics.listForContent(contentId, {
      from: window.from,
      to: window.to,
      limit: ANALYTICS_CONTENT_ROW_LIMIT,
    });
    const previousWindow = analytics.previousWindow(window.from, window.to);
    // Karşılaştırma YAPILAMAZ durumu ayrıdır: pencerede hiç satır yoksa
    // `previous` bir "0" dönemi değil, karşılaştırılacak veri yoktur.
    const hasCurrent = records.length > 0;
    const previous = hasCurrent
      ? analytics.getForContent(contentId, { from: previousWindow.from, to: previousWindow.to })
      : null;
    const change = previous === null ? null : comparePeriods(rollup, previous);
    const asset = ctx.assets.getById(content.assetId);

    return okEnvelope({
      contentId,
      asset:
        asset === null || asset === undefined
          ? null
          : {
              id: asset.id,
              originalName: asset.originalName,
              mimeType: asset.mimeType,
              bytes: asset.bytes,
              hasCover: asset.coverKey !== null,
            },
      jobs: ctx.jobs.listByContent(contentId),
      rollup,
      series: buildContentSeries(records),
      previous: previous === null ? null : { window: previousWindow, rollup: previous },
      change,
      // Tarih kırılması sabiti TEK kaynaktan gelir; panel karşılaştırma
      // yaparken kendi metnini bu tarihe göre kurar.
      viewsCountingChangeDate: VIEWS_COUNTING_CHANGE_DATE,
    });
  });

  server.get("/api/v1/analytics/series", async (request) => {
    requireSession(ctx, request);
    const analytics = requireAnalytics(ctx);
    const q = analyticsQuery(request);
    // Gün başına sorgu yapılır; aralık tavanı olmadan bir istek binlerce
    // sorgu demektir.
    const window = analyticsWindow(ctx, request, { maxDays: MAX_ANALYTICS_SERIES_DAYS });
    const only = analyticsPlatformParam(q["platform"]);
    const limit = analyticsIntParam(
      q["limit"],
      DEFAULT_ANALYTICS_SERIES_POINTS,
      MAX_ANALYTICS_SERIES_POINTS,
      "limit",
    );
    const targets = only === null ? [...PLATFORMS] : [only];

    const points: AnalyticsSeriesPoint[] = [];
    for (const day of eachDay(window.from, window.to)) {
      for (const platform of targets) {
        if (points.length >= limit) break;
        const roll = analytics.getForPlatform(platform, day, day);
        // Hiç satır olmayan gün gösterilmez: "hiç ölçüm yok" ile
        // "ölçüldü ve sıfır" aynı satır gibi okunmasın.
        if (roll.itemCount === 0) continue;
        points.push({
          date: day,
          platform,
          views: measuredValue(roll, "views"),
          interactions: measuredValue(roll, "interactions"),
          saves: measuredValue(roll, "saves"),
          shares: measuredValue(roll, "shares"),
          items: roll.itemCount,
          measured: roll.measuredCount,
          unavailable:
            roll.unavailableCount === 0
              ? null
              : { count: roll.unavailableCount, byReason: roll.unavailableReasons },
        });
      }
      if (points.length >= limit) break;
    }
    return okEnvelope({ from: window.from, to: window.to, points });
  });

  server.get("/api/v1/analytics/coverage", async (request) => {
    requireSession(ctx, request);
    const analytics = requireAnalytics(ctx);
    const window = analyticsWindow(ctx, request);
    const unavailable: Array<{
      platform: Platform;
      count: number;
      byReason: Record<MetricUnavailableReason, number>;
    }> = [];
    let totalJobs = 0;
    let measurable = 0;
    for (const platform of PLATFORMS) {
      const roll = analytics.getForPlatform(platform, window.from, window.to);
      totalJobs += roll.itemCount;
      measurable += roll.measuredCount;
      if (roll.unavailableCount === 0) continue;
      unavailable.push({
        platform,
        count: roll.unavailableCount,
        byReason: roll.unavailableReasons,
      });
    }
    return okEnvelope({ from: window.from, to: window.to, totalJobs, measurable, unavailable });
  });

  server.post("/api/v1/analytics/collect", async (request) => {
    const { actor, keyId } = requireSessionOrKey(ctx, request);
    const analytics = requireAnalytics(ctx);
    const q = analyticsQuery(request);
    const days = analyticsIntParam(
      q["days"],
      1,
      MAX_ANALYTICS_COLLECT_DAYS,
      "days",
    );
    // `AnalyticsService.collect` bir TARİH PENCERESİ değil, bir iş LİSTESİ
    // toplar ve güncel gün satırı yazar. `days` bu yüzden "kaç günlük iş
    // yığını" sorusuna, günlük ortalama iş sayısıyla çevrilir; tavan
    // `DEFAULT_COLLECT_LIMIT`'tir.
    const limit = Math.min(DEFAULT_COLLECT_LIMIT, days * JOBS_PER_COLLECT_DAY);
    const outcome = await analytics.collect({ limit, timezone: ctx.config.timezone });
    const results = buildCollectResults(outcome);
    recordAudit(ctx, actor, "analytics.collect", "analytics", "-", {
      keyId,
      days,
      limit,
      written: outcome.written,
      skipped: outcome.skipped.length,
    });
    return okEnvelope({
      collected: outcome.written,
      fetched: outcome.fetched,
      skipped: outcome.skipped.length,
      metricDate: outcome.metricDate,
      results,
    });
  });
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): unknown {
  return error.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(kök)",
    message: i.message,
  }));
}

/** `HMAC-SHA256(secret, "<key>:<exp>")` — `FsMediaStore.signKey` ile AYNI. */
export function verifyMediaSignature(
  secret: string,
  key: string,
  expires: number,
  signature: string,
  nowMs: number,
): boolean {
  if (!Number.isFinite(expires)) return false;
  // `exp` imzanın parçasıdır: süresi dolmuş bağlantı "geçerli görünerek"
  // kullanılamaz.
  if (Math.floor(nowMs / 1000) >= expires) return false;
  const expected = createHmac("sha256", secret)
    .update(`${key}:${expires}`, "utf8")
    .digest("base64url");
  const provided = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (provided.length !== want.length) return false;
  return timingSafeEqual(provided, want);
}

function decodeMediaKey(wildcard: string): string {
  return wildcard
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
}

function registerMediaRoutes(server: FastifyInstance, ctx: Ctx): void {
  // `GET /api/v1/media/*` — imzalı medya. Oturum GEREKMEZ: sağlayıcı
  // sunucusu imzalı adresi kendisi çeker.
  server.get<{ Params: Record<string, string>; Querystring: Record<string, string> }>(
    "/api/v1/media/*",
    async (request, reply) => {
      const query = request.query ?? {};
      const expires = Number(query["expires"]);
      const signature = query["sig"];
      if (!Number.isInteger(expires) || typeof signature !== "string" || signature.length === 0) {
        throw new HttpError("forbidden", "İmzalı medya adresi eksik (expires/sig).");
      }
      const key = decodeMediaKey((request.params as Record<string, string>)["*"] ?? "");
      if (!verifyMediaSignature(ctx.mediaSecret, key, expires, signature, ctx.clock.now().getTime())) {
        throw new HttpError("forbidden", "Medya imzası geçersiz veya süresi dolmuş.");
      }
      if (!(await ctx.store.exists(key))) throw notFound("Medya");
      const type = /\.jpe?g$/i.test(key) ? "image/jpeg" : "video/mp4";
      return serveFile(request, reply, {
        store: ctx.store,
        key,
        contentType: type,
        cacheControl: "private, max-age=600",
      });
    },
  );
}