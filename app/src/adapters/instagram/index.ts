/**
 * Instagram adaptörlerinin tek giriş noktası.
 *
 * Bu klasör İKİ ayrı sözleşme doldurur:
 *   - `InstagramPublishAdapter` → `PublishAdapter` (yayın hattı)
 *   - `InstagramAuth`           → `AuthProvider`  (Facebook Login OAuth)
 *
 * `isConfigured` YAPILANDIRMA EKSİKLİĞİNİ sessizce geçmez: eksik alan listesini
 * döndürür. Yarım yapılandırılmış bir OAuth akışı, kullanıcı yetkilendirme
 * adresine gönderilip sonra "invalid_client" alan boş bir hata ekranı görmesinden
 * iyidir.
 */
import type { Platform } from "../../contract/index.js";
import { InstagramAuth, missingOAuthConfig } from "./auth.js";
import type { InstagramAuthOptions, InstagramOAuthConfig } from "./auth.js";
import { InstagramPublishAdapter } from "./publisher.js";
import type { InstagramAdapterOptions } from "./publisher.js";

export * from "./http.js";
export * from "./publisher.js";
export {
  InstagramAuth,
  expiryIso,
  missingOAuthConfig,
  pageIds,
  pickPageWithInstagram,
  requiredScopes,
} from "./auth.js";
export type { InstagramAuthOptions, InstagramOAuthConfig } from "./auth.js";
export type { InstagramAdapterOptions } from "./publisher.js";

export { GRAPH_API_VERSION, RUPLOAD_BASE } from "../../media/specs/instagram.js";

/** `AppConfig.instagram` ile yapısal olarak uyumlu parça. */
export interface InstagramConfigLike {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
}

/** Adaptörün tek platformu. */
export const INSTAGRAM_PLATFORM: Platform = "instagram";

/** Eksik alan listesi boşsa `true`. */
export function isConfigured(config: InstagramConfigLike | null | undefined): boolean {
  if (config === null || config === undefined) return false;
  return missingOAuthConfig({ ...config }).length === 0;
}

/** Eksik alanların ortam değişkeni adları (panel mesajı için). */
export function missingConfigKeys(config: InstagramConfigLike | null | undefined): string[] {
  if (config === null || config === undefined) {
    return ["SP_META_APP_ID", "SP_META_APP_SECRET", "SP_META_REDIRECT_URI"];
  }
  return missingOAuthConfig({ ...config });
}

/**
 * Üretimde tek satır kurulum:
 * ```ts
 * const clock = () => new Date().getTime();
 * const adapter = createInstagramAdapter({
 *   now: clock,
 *   // 300 MB gövde belleğe alınamaz → bayt aralığı okuyucu ZORUNLU:
 *   resolvePath: (key) => store.pathFor(key),
 * });
 * const auth = createInstagramAuth(
 *   { clientId, clientSecret, redirectUri },
 *   { now: clock },
 * );
 * ```
 *
 * `fetch` verilmezse `globalThis.fetch` kullanılır; testler sahte `fetch`
 * enjekte eder ve ağa çıkmaz.
 */
export function createInstagramAdapter(options: InstagramAdapterOptions): InstagramPublishAdapter {
  return new InstagramPublishAdapter(options);
}

export function createInstagramAuth(
  config: InstagramOAuthConfig,
  options: InstagramAuthOptions,
): InstagramAuth {
  return new InstagramAuth(config, options);
}