/**
 * KİMLİK KURULUM SİHİRBAZI VERİSİ — `/api/v1/setup`.
 *
 * Bu uç "panel ne yapmalı?" sorusunu yanıtlar, "panel neyi denesin?" değil.
 * Kullanıcı üç sağlayıcıya üç ayrı yol izlemek zorunda kalmasın; eksik olan
 * her şey `problems[]` ve `platforms[].missing[]` içinde DÜRÜSTÇE listelenir.
 *
 * ── "EKSİK" NASIL BELİRLENİR ────────────────────────────────────────────────
 *   1. `config` (ortam değişkenleri): `SP_MASTER_KEY`, `SP_META_*`,
 *      `SP_TIKTOK_*`, `SP_GOOGLE_*`.
 *   2. `accounts` tablosu: o platformda `active` durumda hesap var mı.
 *
 * `docAnchor` DEĞERLERİ UYDURULMAZ: `docs/KIMLIK-KURULUMU.md` dosyasındaki
 * GERÇEK başlıklardan türetilir. Başlık değişirse burada da değişmelidir —
 * yanlış çapa, kullanıcıyı olmayan bir bölüme gönderir.
 *
 * `severity`:
 *   * `blocker` — bu eksik olmadan O PLATFORM YAYIN YAPAMAZ.
 *   * `warning` — uygulama çalışır ama eksik (ör. master key yoksa gerçek
 *     yayın yapılmaz; uygulama sahte (mock) modda çalışır).
 */
import {
  PLATFORMS,
  PLATFORM_LABELS,
  type Platform,
} from "../contract/index.js";
import type { AppConfig } from "../config/index.js";
import type { AccountRepo } from "../db/index.js";

export type SetupSeverity = "blocker" | "warning";

export interface SetupProblem {
  severity: SetupSeverity;
  code: string;
  message: string;
  docAnchor: string;
  /** Kullanıcının `.env`'e yazması gereken anahtarlar. */
  envKeys: string[];
}

export interface PlatformSetup {
  platform: Platform;
  configured: boolean;
  /** Eksik ortam anahtarları. */
  missing: string[];
  /** Bu platformda `active` hesap sayısı. */
  hasAccounts: boolean;
  /**
   * `true` = hesap bağlı ama yeniden yetkilendirme bekliyor
   * (`needs_reauth`); `false` = hesap yok ya da devre dışı.
   */
  reviewNeeded: boolean;
  docAnchor: string;
  /** Bu platformda gerçek adaptör kullanılıyor mu. `false` → SAHTE. */
  liveAdapter: boolean;
}

export interface SetupReport {
  mode: "mock" | "partial" | "live";
  problems: SetupProblem[];
  platforms: PlatformSetup[];
}

/**
 * Belgelerde GERÇEKTEN var olan başlıklar (okunarak yazıldı).
 * Değişirse `docs/KIMLIK-KURULUMU.md` ile birlikte güncellenmelidir.
 */
const DOC = {
  masterKey: "KIMLIK-KURULUMU.md#0-önce-env-dosyasını-oluştur",
  instagram: "KIMLIK-KURULUMU.md#1-instagram--meta",
  tiktok: "KIMLIK-KURULUMU.md#2-tiktok",
  youtube: "KIMLIK-KURULUMU.md#3-youtube",
  envDictionary: "KIMLIK-KURULUMU.md#4-ortak-env-anahtar-sözlüğü",
  checklist: "KIMLIK-KURULUMU.md#41-tamamlanma-kontrol-listesi",
  metaAppId: "KIMLIK-KURULUMU.md#adım-15--app-id-ve-secret-al",
  tiktokClient: "KIMLIK-KURULUMU.md#adım-23--client-key-ve-secret-al",
  googleClient: "KIMLIK-KURULUMU.md#adım-34--oauth-client-id-oluştur",
  metaAccounts: "KIMLIK-KURULUMU.md#adım-16--test-kullanıcılarını-ekle",
  tiktokSandbox: "KIMLIK-KURULUMU.md#adım-27--sandbox-kullanıcısı-ekle",
  youtubeChannel: "KIMLIK-KURULUMU.md#adım-37--ilk-yetkilendirme-ve-kanal-onayı",
} as const;

/** Platformun kendi kimlik anahtarları (hepsi zorunludur). */
const PROVIDER_KEYS: Record<Platform, Array<{ key: string; label: string }>> = {
  instagram: [
    { key: "SP_META_APP_ID", label: "Meta App ID" },
    { key: "SP_META_APP_SECRET", label: "Meta App Secret" },
    { key: "SP_META_REDIRECT_URI", label: "Meta yönlendirme adresi" },
  ],
  tiktok: [
    { key: "SP_TIKTOK_CLIENT_KEY", label: "TikTok Client Key" },
    { key: "SP_TIKTOK_CLIENT_SECRET", label: "TikTok Client Secret" },
    { key: "SP_TIKTOK_REDIRECT_URI", label: "TikTok yönlendirme adresi" },
  ],
  youtube: [
    { key: "SP_GOOGLE_CLIENT_ID", label: "Google OAuth Client ID" },
    { key: "SP_GOOGLE_CLIENT_SECRET", label: "Google OAuth Client Secret" },
    { key: "SP_GOOGLE_REDIRECT_URI", label: "Google yönlendirme adresi" },
  ],
};

const PLATFORM_DOC: Record<Platform, { base: string; key: string; account: string }> = {
  instagram: { base: DOC.instagram, key: DOC.metaAppId, account: DOC.metaAccounts },
  tiktok: { base: DOC.tiktok, key: DOC.tiktokClient, account: DOC.tiktokSandbox },
  youtube: { base: DOC.youtube, key: DOC.googleClient, account: DOC.youtubeChannel },
};

export interface BuildSetupOptions {
  config: AppConfig;
  accounts: AccountRepo;
  /** `Platform → gerçek adaptör var mı`. Anahtarda olmayan platform sahtedir. */
  liveAdapters: ReadonlySet<Platform>;
}

export function buildSetupReport(opts: BuildSetupOptions): SetupReport {
  const { config, accounts, liveAdapters } = opts;
  const problems: SetupProblem[] = [];

  // ── Genel eksikler ────────────────────────────────────────────────────────
  if (!config.masterKey) {
    problems.push({
      severity: "blocker",
      code: "master_key_missing",
      message:
        "SP_MASTER_KEY tanımlı değil: hesap belirteçleri şifrelenemez ve uygulama SAHTE (mock) " +
        "modda çalışır. Gerçek yayın için 32 baytlık base64 bir anahtar üretin.",
      docAnchor: DOC.masterKey,
      envKeys: ["SP_MASTER_KEY"],
    });
  }
  if (!config.adminPassword) {
    problems.push({
      severity: "blocker",
      code: "admin_password_missing",
      message:
        "SP_ADMIN_PASSWORD tanımlı değil: panel oturumu AÇILAMAZ. Bu bilinçli bir kör moddur; " +
        "tünelle internete açmadan önce parola tanımlayın.",
      docAnchor: DOC.envDictionary,
      envKeys: ["SP_ADMIN_PASSWORD"],
    });
  }
  if (config.ingestKeys.length === 0) {
    problems.push({
      severity: "warning",
      code: "no_ingest_keys",
      message:
        "SP_INGEST_KEYS boş: AI projeleri ingest kanalına bağlanamaz. " +
        "Anahtar üretin: npm run sp -- api-key create <proje>",
      docAnchor: DOC.envDictionary,
      envKeys: ["SP_INGEST_KEYS"],
    });
  }
  if (!config.publicBaseUrl) {
    problems.push({
      severity: "warning",
      code: "public_base_url_missing",
      message:
        "SP_PUBLIC_BASE_URL tanımlı değil: arayüz yalnız localhost üzerinden erişilebilir ve " +
        "medya adresleri üretilmez.",
      docAnchor: DOC.envDictionary,
      envKeys: ["SP_PUBLIC_BASE_URL"],
    });
  }

  // ── Platformlar ───────────────────────────────────────────────────────────
  const activeCounts = accounts.countActiveByPlatform();
  // `listActive` YALNIZ `active` döndürür; `needs_reauth` uyarısı için TÜM
  // hesaplar okunur (devre dışı olanlar da görülür, yalnız sayılmaz).
  const allAccounts = accounts.listByPlatform(undefined, 500);
  const reviewPlatforms = new Set<Platform>(
    allAccounts.filter((a) => a.status === "needs_reauth").map((a) => a.platform),
  );

  const platforms: PlatformSetup[] = PLATFORMS.map((platform) => {
    const missing = PROVIDER_KEYS[platform]
      .filter(({ key }) => !valueFor(config, key))
      .map(({ key }) => key);
    const hasAccounts = (activeCounts[platform] ?? 0) > 0;
    const reviewNeeded = reviewPlatforms.has(platform);
    const liveAdapter = liveAdapters.has(platform);

    if (missing.length > 0) {
      problems.push({
        severity: "blocker",
        code: `${platform}_credentials_missing`,
        message:
          `${PLATFORM_LABELS[platform]} kimlik anahtarları eksik: ${missing.join(", ")}. ` +
          `Bu platformda gerçek yayın yapılamaz.`,
        docAnchor: PLATFORM_DOC[platform].key,
        envKeys: missing,
      });
    }
    if (missing.length === 0 && !hasAccounts) {
      problems.push({
        severity: "blocker",
        code: `${platform}_account_missing`,
        message:
          `${PLATFORM_LABELS[platform]} için bağlı hesap yok. Anahtarlar tanımlı olsa bile ` +
          "yayın yapılamaz.",
        docAnchor: PLATFORM_DOC[platform].account,
        envKeys: [],
      });
    }
    if (reviewNeeded) {
      problems.push({
        severity: "blocker",
        code: `${platform}_reauth_required`,
        message:
          `${PLATFORM_LABELS[platform]} hesabı yeniden yetkilendirme bekliyor ` +
          "(`needs_reauth`): eski belirteçle denemek kota/hesap riskidir.",
        docAnchor: PLATFORM_DOC[platform].base,
        envKeys: [],
      });
    }
    if (missing.length === 0 && hasAccounts && !liveAdapter) {
      problems.push({
        severity: "warning",
        code: `${platform}_mock_adapter`,
        message:
          `${PLATFORM_LABELS[platform]} için SAHTE adaptör kullanılıyor: yayın yapılmayacak, ` +
          "panelde rozet görünecek.",
        docAnchor: PLATFORM_DOC[platform].base,
        envKeys: [],
      });
    }

    return {
      platform,
      // "Yapılandırılmış" = ortam anahtarları yerinde. Hesap bağlı olup
      // olmamak AYRI bir bilgidir (`hasAccounts`) ve zaten ayrı döndürülür.
      //
      // Burada önce `missing.length === 0 && hasAccounts` yazıyordu; bu bir
      // AÇILIŞ KİLİDİDİR: ilk hesap bağlanana kadar `hasAccounts` false
      // olduğu için `configured` da false dönüyor, paneldeki "Bağlan"
      // düğmesi devre dışı kalıyor ve hesap hiçbir zaman bağlanamıyordu.
      configured: missing.length === 0,
      missing,
      hasAccounts,
      reviewNeeded,
      docAnchor: PLATFORM_DOC[platform].base,
      liveAdapter,
    };
  });

  const ready = platforms.filter((p) => p.configured && p.liveAdapter).length;
  const mode: SetupReport["mode"] =
    ready === PLATFORMS.length ? "live" : ready === 0 ? "mock" : "partial";

  return { mode, problems, platforms };
}

/** `AppConfig` alan adı ↔ ortam anahtarı eşlemesi (TEK yer). */
function valueFor(config: AppConfig, envKey: string): string | null {
  switch (envKey) {
    case "SP_META_APP_ID":
      return config.meta.appId;
    case "SP_META_APP_SECRET":
      return config.meta.appSecret;
    case "SP_META_REDIRECT_URI":
      return config.meta.redirectUri;
    case "SP_TIKTOK_CLIENT_KEY":
      return config.tiktok.clientKey;
    case "SP_TIKTOK_CLIENT_SECRET":
      return config.tiktok.clientSecret;
    case "SP_TIKTOK_REDIRECT_URI":
      return config.tiktok.redirectUri;
    case "SP_GOOGLE_CLIENT_ID":
      return config.youtube.clientId;
    case "SP_GOOGLE_CLIENT_SECRET":
      return config.youtube.clientSecret;
    case "SP_GOOGLE_REDIRECT_URI":
      return config.youtube.redirectUri;
    default:
      return null;
  }
}