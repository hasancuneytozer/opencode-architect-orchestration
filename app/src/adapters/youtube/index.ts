/**
 * YouTube adaptörlerinin tek giriş noktası.
 *
 * Bu klasör İKİ ayrı sözleşme doldurur:
 *   - `YouTubePublishAdapter` → `PublishAdapter` (yayın hattı)
 *   - `YouTubeAuth`           → `AuthProvider`  (OAuth)
 *
 * `isConfigured` YAPILANDIRMA EKSİKLİĞİNİ sessizce geçmez: eksik alanlar
 * listesini döndürür. Yarım yapılandırılmış bir OAuth akışı, kullanıcı
 * yetkilendirme adresine gönderilip sonra "invalid_client" alan boş bir
 * hata ekranı görmesinden iyidir.
 */
import type { Platform } from "../../contract/index.js";
import { YOUTUBE_API, YOUTUBE_QUOTA_UNITS, YOUTUBE_RESUMABLE_CHUNK_BYTES, YOUTUBE_INSERT_DAILY_CALL_BUCKET } from "../../media/specs/youtube.js";
import { YouTubeAuth, missingOAuthConfig } from "./auth.js";
import type { YouTubeAuthOptions, YouTubeOAuthConfig } from "./auth.js";
import { YouTubePublishAdapter } from "./publisher.js";
import type { YouTubeAdapterOptions } from "./publisher.js";

export * from "./http.js";
export * from "./publisher.js";
export {
  YouTubeAuth,
  generateOAuthState,
  requiredScopes,
  parseScopes,
  stateMatches,
  expiryIso,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from "./auth.js";
export type { YouTubeAuthOptions, YouTubeOAuthConfig } from "./auth.js";
export type { YouTubeAdapterOptions } from "./publisher.js";

export { YOUTUBE_API, YOUTUBE_QUOTA_UNITS, YOUTUBE_RESUMABLE_CHUNK_BYTES, YOUTUBE_INSERT_DAILY_CALL_BUCKET };

/** `AppConfig.youtube` ile yapısal olarak uyumlu parça. */
export interface YouTubeConfigLike {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
}

/** Adaptörün tek platformu. */
export const YOUTUBE_PLATFORM: Platform = "youtube";

/** Eksik alan listesi boşsa `true`. */
export function isConfigured(config: YouTubeConfigLike | null | undefined): boolean {
  if (config === null || config === undefined) return false;
  return missingOAuthConfig({ ...config }).length === 0;
}

/** Eksik alanların ortam değişkeni adları (panel mesajı için). */
export function missingConfigKeys(config: YouTubeConfigLike | null | undefined): string[] {
  if (config === null || config === undefined) return ["SP_GOOGLE_CLIENT_ID", "SP_GOOGLE_CLIENT_SECRET", "SP_GOOGLE_REDIRECT_URI"];
  return missingOAuthConfig({ ...config });
}

/**
 * Üretimde tek satır kurulum:
 * ```ts
 * const clock = () => new Date().getTime();
 * const adapter = new YouTubePublishAdapter({ now: clock });
 * const auth = new YouTubeAuth(
 *   { clientId, clientSecret, redirectUri },
 *   { now: clock },
 * );
 * ```
 *
 * `fetch` verilmezse `globalThis.fetch` kullanılır; testler sahte `fetch`
 * enjekte eder ve ağa çıkmaz.
 */
export function createYouTubeAdapter(options: YouTubeAdapterOptions): YouTubePublishAdapter {
  return new YouTubePublishAdapter(options);
}

export function createYouTubeAuth(
  config: YouTubeOAuthConfig,
  options: YouTubeAuthOptions,
): YouTubeAuth {
  return new YouTubeAuth(config, options);
}
