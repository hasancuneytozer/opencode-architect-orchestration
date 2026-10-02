/**
 * UYGULAMA GİRİŞ NOKTASI — `npm run dev:api` / `npm start`.
 *
 * ── SORUMLULUK ───────────────────────────────────────────────────────────────
 * Sadece BAĞLAMA (wiring): yapılandırma → veritabanı → depo → motor → HTTP.
 * İş kuralı burada BİR SATIR bile yoktur; her katman kendi sorusunu kendisi
 * yanıtlar. `main.ts`'de bir `if` bile koşul mantığı gibi görünür.
 *
 * ── KÖR MOD BİLİNÇLİDİR ──────────────────────────────────────────────────────
 * `SP_MASTER_KEY` yoksa şifre çözücü `null` olur ve yayın motoru işleri
 * "şifre çözücü yok" gerekçesiyle ATLAR — uygulama sahte modda çalışır, çökmez.
 * `SP_ADMIN_PASSWORD` yoksa oturum açılamaz. `config.isTest` altında
 * `masterKey` yoksa rastgele bir üretim anahtarı türetilir: testin amacı
 * şifreleme değil, kuyruk akışı; rastgele anahtar aynı testi "master key
 * tanımla" adımına bağımlı olmaktan kurtarır ve ÜRETİMDE hiçbir zaman
 * kullanılmaz (`nodeEnv === "test"` dışında `config.masterKey` null ise
 * üretim anahtarı türetilmez).
 *
 * ── SİNYAL İŞLEYİŞİ ─────────────────────────────────────────────────────────
 * `SIGINT`/`SIGTERM` → `scheduler.stop()`, sunucuyu kapat, veritabanını kapat.
 * Kapatma sırasında hata YUTULMAZ: süreç çıkış kodu 1 ile biter, çünkü
 * "temiz kapanamadı" sessiz geçilirse açık dosya kalmış bir yayın olabilir.
 */
import { createDatabase, MIGRATIONS_DIR } from "./db/index.js";
import { loadConfigFromDisk } from "./config/index.js";
import { FsMediaStore, getFfmpegTools, getSpec } from "./media/index.js";
import { IngestService } from "./ingest/index.js";
import { createCipher } from "./security/cipher.js";
import {
  PublishService,
  Scheduler,
  StoreMediaRefResolver,
  systemClock,
} from "./services/index.js";
import {
  createYouTubeAdapter,
  createYouTubeAuth,
  isConfigured as youtubeConfigured,
} from "./adapters/youtube/index.js";
import {
  createInstagramAdapter,
  createInstagramAuth,
  isConfigured as instagramConfigured,
} from "./adapters/instagram/index.js";
import {
  createTikTokAdapter,
  createTikTokAuth,
  isConfigured as tiktokConfigured,
} from "./adapters/tiktok/index.js";
import { mockAdapter } from "./adapters/mock/index.js";
import {
  AnalyticsService,
  InstagramAnalyticsAdapter,
  TiktokAnalyticsAdapter,
  YoutubeAnalyticsAdapter,
  type AnalyticsAdapterSet,
  type AnalyticsAccountContext,
} from "./analytics/index.js";
import { buildServer, wrapScheduler } from "./http/index.js";
import type { Platform } from "./contract/index.js";
import type { AuthProvider, PublishAdapter } from "./ports/index.js";

async function main(): Promise<void> {
  const config = loadConfigFromDisk();

  // ── Veri katmanı ─────────────────────────────────────────────────────────
  const { db, repos } = createDatabase(config.databaseFile, {
    migrationsDir: MIGRATIONS_DIR,
  });

  // Medya imzası sırrı. `masterKey` ile AYNI kaynaktan türetilir: iki ayrı sır
  // "biri döndü, diğeri değişti" durumunda imzalı adresler sessizce geçersiz
  // olur ve bu hata kullanıcıya "video açılmıyor" olarak görünür.
  //
  // Tek değişken olarak üretilir ve hem `FsMediaStore`'a hem `buildServer`'a
  // AYNI değer geçer; depoun `private` alanını okumak gerekmez.
  const mediaSecret = config.masterKey ?? "sp-gelistirme-imza-sirri";

  const store = new FsMediaStore(config.storageDir, {
    publicBaseUrl: config.publicBaseUrl,
    // Medya imzası sırrı. `masterKey` ile AYNI kaynaktan türer: iki ayrı sır
    // "biri döndü, diğeri değişti" durumunda imzalı adresler sessizce geçersiz
    // olur ve bu hata kullanıcıya "video açılmıyor" olarak görünür.
    secret: mediaSecret,
    defaultUrlTtlSec: 86_400,
  });

  const ffmpeg = getFfmpegTools();
  const cipher = createCipher(config.masterKey);

  // ── Adaptör kaydı ────────────────────────────────────────────────────────
  // YouTube kimlik anahtarları TAM ise gerçek adaptör; değilse sahte. Meta ve
  // TikTok'ın gerçek adaptörü bu pakette yok (bkz. `src/adapters/*/NOTES.md`),
  // onlar sahte kalır ve panelde "mock" rozeti görünür.
  const adapters = new Map<Platform, PublishAdapter>();
  const liveAdapters = new Set<Platform>();
  // ── OAuth sağlayıcıları ─────────────────────────────────────────────────
  //
  // KURAL: bir platformun sağlayıcısı YALNIZ `isConfigured` doğruysa haritaya
  // girer. Sağlayıcı `null`/eksik kalırsa `/auth/:platform/start` 503 döner ve
  // paneldeki "Yapılandırılmamış" düğmesi AYNI gerçeği anlatır. Yarım
  // yapılandırılmış bir sağlayıcı (client id var, secret yok) kurmak, kullanıcıyı
  // yetkilendirme ekranına gönderip sonra `invalid_client` ile boş bir hata
  // ekranı göstermekten iyidir.
  const authProviders = new Map<Platform, AuthProvider>();
  const now = (): number => Date.now();

  if (youtubeConfigured(config.youtube)) {
    adapters.set(
      "youtube",
      // `readMedia` ZORUNLUDUR. `PublishInput.media` yalnız depo içi `storageKey`
      // taşır, mutlak yol değildir; okuyucu verilmezse `uploadParts` KALICI
      // `validation/no_media_reader` hatası verir ve video hiç yüklenmez
      // (bkz. `src/adapters/youtube/NOTES.md` §12.1).
      createYouTubeAdapter({ now, readMedia: (media) => store.read(media.storageKey) }),
    );
    liveAdapters.add("youtube");
    authProviders.set(
      "youtube",
      createYouTubeAuth(
        {
          clientId: config.youtube.clientId as string,
          clientSecret: config.youtube.clientSecret as string,
          redirectUri: config.youtube.redirectUri as string,
        },
        { now },
      ),
    );
  } else {
    adapters.set("youtube", mockAdapter("youtube"));
  }

  // Meta: `isConfigured` alanları `clientId`/`clientSecret` adıyla bekler,
  // `AppConfig.meta` ise `appId`/`appSecret` der. Aynı değerler, farklı adlar —
  // eşleme burada bir kez yapılır (aşağıdaki analitik bağlaması da aynı eşlemeyi
  // kullanır).
  const metaLike = {
    clientId: config.meta.appId,
    clientSecret: config.meta.appSecret,
    redirectUri: config.meta.redirectUri,
  };

  if (instagramConfigured(metaLike)) {
    adapters.set(
      "instagram",
      createInstagramAdapter({ now, resolvePath: (key) => store.pathFor(key) }),
    );
    liveAdapters.add("instagram");
    authProviders.set(
      "instagram",
      createInstagramAuth(
        {
          clientId: config.meta.appId as string,
          clientSecret: config.meta.appSecret as string,
          redirectUri: config.meta.redirectUri as string,
        },
        { now },
      ),
    );
  } else {
    adapters.set("instagram", mockAdapter("instagram"));
  }

  // TikTok: `isConfigured` yalnız alanların DOLU OLUĞUNA bakar, `https`
  // kuralını denetlemez. O kural `authorizeUrl`'da uygulanır (ağ çağrısından
  // önce, kalıcı hata) — yayıncı yine de kurulur: kural sağlayıcı tarafında.
  if (tiktokConfigured(config.tiktok)) {
    adapters.set("tiktok", createTikTokAdapter({ now, resolvePath: (key) => store.pathFor(key) }));
    liveAdapters.add("tiktok");
    authProviders.set(
      "tiktok",
      createTikTokAuth(
        {
          clientKey: config.tiktok.clientKey as string,
          clientSecret: config.tiktok.clientSecret as string,
          redirectUri: config.tiktok.redirectUri as string,
        },
        { now },
      ),
    );
  } else {
    adapters.set("tiktok", mockAdapter("tiktok"));
  }

  // ── Ingest ───────────────────────────────────────────────────────────────
  const ingest = new IngestService({
    projects: repos.projects,
    assets: repos.assets,
    contents: repos.contents,
    accounts: repos.accounts,
    jobs: repos.jobs,
    audit: repos.audit,
    store,
    probe: ffmpeg,
    transcoder: ffmpeg,
    getSpec,
    clock: systemClock,
  });

  // ── Yayın motoru + zamanlayıcı ───────────────────────────────────────────
  const publisher = new PublishService({
    jobs: repos.jobs,
    contents: repos.contents,
    assets: repos.assets,
    accounts: repos.accounts,
    credentials: repos.credentials,
    cipher,
    media: new StoreMediaRefResolver(store),
    adapters,
    store,
    audit: repos.audit,
    clock: systemClock,
    leaseOwner: `api-${process.pid}`,
    transcoder: ffmpeg,
  });

  const scheduler = wrapScheduler({
    scheduler: new Scheduler(publisher, {
      tickMs: config.schedulerTickMs,
      limit: config.publishConcurrency * 20,
      onError: (err) => console.error("[scheduler]", err instanceof Error ? err.message : err),
    }),
    tickMs: config.schedulerTickMs,
  });

  // ── Analitik ─────────────────────────────────────────────────────────────
  //
  // Adaptörler YALNIZ `isConfigured` sırasına bağlanır. Sırrı olmayan platforma
  // adaptör BAĞLANMAZ (istek atılmaz): `AnalyticsService.collect` o platformu
  // "atlandı" diye işaretler, panel kartı da "ölçüm kaynağı bağlı değil"
  // gerekçesiyle dürüst kalır. Sahte ölçüm üreten bir adaptör, kullanıcıya
  // olmayan veriyi varmış gibi göstermekten başka bir işe yaramaz.
  const analyticsAdapters: AnalyticsAdapterSet = {};
  const analyticsPlatforms = new Set<Platform>();
  const analyticsNow = (): number => Date.now();

  if (instagramConfigured(metaLike)) {
    analyticsAdapters.instagram = new InstagramAnalyticsAdapter({ now: analyticsNow });
    analyticsPlatforms.add("instagram");
  }
  if (tiktokConfigured(config.tiktok)) {
    analyticsAdapters.tiktok = new TiktokAnalyticsAdapter({ now: analyticsNow });
    analyticsPlatforms.add("tiktok");
  }
  if (youtubeConfigured(config.youtube)) {
    analyticsAdapters.youtube = new YoutubeAnalyticsAdapter({ now: analyticsNow });
    analyticsPlatforms.add("youtube");
  }

  const analytics = new AnalyticsService(repos.metrics, analyticsNow);

  /**
   * Platform başına hesap bağlamı.
   *
   * Belirteç çözüLEMEZSE `null` verilir: adaptör bunu `no_scope` olarak yazar
   * ve panel "ölçüm için gereken izinler eksik" der. Burada fırlatmak,
   * ölçülebilen diğer platformların turunu da düşürürdü.
   */
  const analyticsAccounts = (): Partial<Record<Platform, AnalyticsAccountContext>> => {
    const out: Partial<Record<Platform, AnalyticsAccountContext>> = {};
    for (const platform of analyticsPlatforms) {
      const account = repos.accounts.findActiveByPlatform(platform);
      const credential = account === null ? null : repos.credentials.getByAccountId(account.id);
      let accessToken: string | null = null;
      if (credential !== null && cipher !== null) {
        try {
          accessToken = cipher.open(credential.accessTokenEnc);
        } catch {
          accessToken = null;
        }
      }
      out[platform] = { accessToken, scopes: credential?.scopes ?? [] };
    }
    return out;
  };

  /** Zamanlanmış toplama aralığı. IG insights kotası 6 saatte bir BUC harcar. */
  const ANALYTICS_COLLECT_INTERVAL_MS = 6 * 60 * 60 * 1000;

  // ── HTTP ─────────────────────────────────────────────────────────────────
  const { server } = await buildServer({
    config,
    db,
    repos,
    store,
    probe: ffmpeg,
    ingest,
    publisher,
    scheduler,
    clock: systemClock,
    mediaSecret,
    liveAdapters,
    analytics,
    analyticsPlatforms,
    // Hesap bağlama iki bağımlılığa bağlı:
    //   * `authProviders` — sağlayıcısı olmayan platform 503 döner.
    //   * `cipher` — `SP_MASTER_KEY` yoksa `null`; callback 503 döner ve HESAP
    //     OLUŞTURMAZ (şifrelenemeyen belirteç düz metin saklamakla aynıdır).
    // `repos.credentials` `buildServer` içinde zorunlu alan olarak doldurulur.
    authProviders,
    cipher,
  });

  /**
   * Toplama turu. `scheduler.tick`'in İÇİNDE DEĞİLDİR: tick hızlı olmalı,
   * sağlayıcı çağrısı (IG 25 ardışık istek) bir tick'i saniyelerce bloklar.
   * Hata YUTULMAZ ama süreci düşürmez: bir tur başarısız olursa sonraki tur
   * yine denenir.
   */
  const collectAnalytics = async (): Promise<void> => {
    try {
      await analytics.collect({ adapters: analyticsAdapters, accounts: analyticsAccounts() });
    } catch (err) {
      server.log.warn(
        { err },
        `analitik toplama turu başarısız: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  scheduler.start();

  // Zamanlayıcıdan AYRI bir aralık. `unref()` sürecin açık kalmasını engeller:
  // bu zamanlayıcı olmadan sunucu zaten ayakta tutulur.
  const analyticsTimer = setInterval(() => {
    void collectAnalytics();
  }, ANALYTICS_COLLECT_INTERVAL_MS);
  analyticsTimer.unref();

  // İlk tur hemen çalışır; panel açılışta "ölçüm yok" görmesin.
  void collectAnalytics();

  await server.listen({ host: config.host, port: config.port });

  // Mod, `config.mockMode`'den DEĞİL, **bağlanmış gerçek adaptör sayısından**
  // türetilir. `mockMode` yalnızca `SP_MASTER_KEY` yokluğunu anlatır; anahtar
  // tanımlıyken hiçbir sağlayıcı sırrı girilmemiş olabilir ve konsol "canlı"
  // derken uygulama hiçbir yere gerçek içerik göndermiyordur.
  //
  // Bu, `/api/health`'in döndürdüğü `mode` ile **aynı kural** olmalı
  // (`src/http/server.ts:444`). İki yer farklı kural kullanırsa kullanıcı
  // konsola bakıp "canlı" görür, panele bakıp "sahte" görür ve hangisinin
  // doğru olduğunu bilemez.
  const isLive = liveAdapters.size > 0;
  const mode = isLive ? "canlı" : "MOCK (sahte adaptörler)";
  server.log.info(
    {
      host: config.host,
      port: config.port,
      mode: isLive ? "live" : "mock",
      liveAdapters: [...liveAdapters],
      masterKeyConfigured: config.masterKey !== null,
    },
    isLive
      ? `social-publish API hazır — CANLI (${liveAdapters.size} platform bağlı)`
      : "social-publish API hazır — SAHTE YAYIN MODU (hiçbir içerik gerçekten yayınlanmıyor)",
  );
  if (!isLive) {
    server.log.warn(
      { platforms: [...liveAdapters] },
      "Gerçek adaptör yok; tüm yayınlar sahte adaptöre gidiyor. Kimlik kurulumu için: npm run sp -- setup check",
    );
  }

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    server.log.info({ signal }, "kapatılıyor");
    scheduler.stop();
    // Analitik turu da durur: kapanma sırasında yeni sağlayıcı isteği başlatılmaz.
    clearInterval(analyticsTimer);
    void (async () => {
      try {
        await server.close();
        db.close();
        process.exit(0);
      } catch (err) {
        server.log.error({ err }, "kapanış hatası");
        process.exit(1);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // Başlangıç hatası: tek satır neden + çıkış kodu. Stack trace basılmaz —
  // kullanıcıya ne yapması gerektiğini söyleyen bir mesaj vardır.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Uygulama başlatılamadı: ${message}`);
  process.exit(1);
});