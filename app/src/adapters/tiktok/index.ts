/**
 * TikTok adaptörlerinin tek giriş noktası.
 *
 * Bu klasör İKİ ayrı sözleşme doldurur:
 *   - `TikTokPublishAdapter` → `PublishAdapter` (Content Posting API yayın hattı)
 *   - `TikTokAuth`           → `AuthProvider`  (OAuth 2.0)
 *
 * ⚠️ CANLIYA ALINMAZ. TikTok'un App Review politikası "kendi hesaplarına
 * yükleyen araç" tipini kabul etmez; bu kod denetim sürecinden geçmeden
 * canlı bir hesaba bağlanmamalıdır (bkz. `NOTES.md` 1). `src/main.ts` bağlantısı
 * bu pakete dahil DEĞİLDİR.
 *
 * `isConfigured` YAPILANDIRMA EKSİKLİĞİNİ sessizce geçmez: eksik alan listesini
 * döndürür. Yarım yapılandırılmış bir OAuth akışı, kullanıcı yetkilendirme
 * adresine gönderilip sonra "invalid_client" alan boş bir hata ekranı görmesinden
 * iyidir.
 */
import type { Platform } from "../../contract/index.js";
import { TikTokAuth, missingOAuthConfig } from "./auth.js";
import type { TikTokAuthOptions, TikTokOAuthConfig } from "./auth.js";
import { TikTokPublishAdapter } from "./publisher.js";
import type { TikTokAdapterOptions } from "./publisher.js";

export * from "./http.js";
export * from "./publisher.js";
export {
  TikTokAuth,
  expiryIso,
  missingOAuthConfig,
  parseScopes,
  redirectUriProblem,
  requiredScopes,
} from "./auth.js";
export type { TikTokAuthOptions, TikTokOAuthConfig } from "./auth.js";
export type { TikTokAdapterOptions } from "./publisher.js";

export { TIKTOK_UPLOAD_URL_TTL_SEC, TIKTOK_MAX_BYTES, getPreset } from "../../media/index.js";

/** `AppConfig.tiktok` ile yapısal olarak uyumlu parça. */
export interface TikTokConfigLike {
  readonly clientKey: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
}

/** Adaptörün tek platformu. */
export const TIKTOK_PLATFORM: Platform = "tiktok";

/** Eksik alan listesi boşsa `true`. */
export function isConfigured(config: TikTokConfigLike | null | undefined): boolean {
  if (config === null || config === undefined) return false;
  return missingOAuthConfig({ ...config }).length === 0;
}

/** Eksik alanların ortam değişkeni adları (panel mesajı için). */
export function missingConfigKeys(config: TikTokConfigLike | null | undefined): string[] {
  if (config === null || config === undefined) {
    return ["SP_TIKTOK_CLIENT_KEY", "SP_TIKTOK_CLIENT_SECRET", "SP_TIKTOK_REDIRECT_URI"];
  }
  return missingOAuthConfig({ ...config });
}

/**
 * Üretimde tek satır kurulum:
 * ```ts
 * const clock = () => new Date().getTime();
 * const adapter = createTikTokAdapter({
 *   now: clock,
 *   // 128 MB'a kadar gövde belleğe alınamaz → bayt aralığı okuyucu ZORUNLU:
 *   resolvePath: (key) => store.pathFor(key),
 * });
 * const auth = createTikTokAuth(
 *   { clientKey, clientSecret, redirectUri },
 *   { now: clock },
 * );
 * ```
 *
 * `fetch` verilmezse `globalThis.fetch` kullanılır; testler sahte taşıma
 * enjekte eder ve ağa çıkmaz.
 */
export function createTikTokAdapter(options: TikTokAdapterOptions): TikTokPublishAdapter {
  return new TikTokPublishAdapter(options);
}

export function createTikTokAuth(
  config: TikTokOAuthConfig,
  options: TikTokAuthOptions,
): TikTokAuth {
  return new TikTokAuth(config, options);
}
