/**
 * Analitik için GEREKEN KAPSAMLAR.
 *
 * YAYIN KAPSAMLARINDAN AYRIDIR. Bu ayrım kritiktir: Instagram yayın için
 * `instagram_content_publish` ister, insights için ise
 * `instagram_manage_insights` — biri olmadan diğeri çalışmaz. Tek listeye
 * ikisini de yazıp "yetkilendirme tamam" demek, yayın yapılan ama ölçülemeyen
 * bir hesap bırakır ve kullanıcı nedenini haftalarca arar.
 *
 * AYRI DOSYA/AYRI SABİT: `src/adapters/<platform>/auth.ts` içindeki yayın
 * scope listeleri DEĞİŞTİRİLMEZ; yetkilendirme akışı başka iş paketinin
 * yüzeyi.
 * Buradaki liste yalnız "ölçüm için ne gerekir" sorusunu yanıtlar ve panelde
 * gösterilir.
 */
import type { Platform } from "../contract/index.js";

/**
 * Instagram insights için gereken izinler.
 *
 * `instagram_manage_insights` — insights endpoint'inin kendisi.
 * `instagram_basic`            — IG nesnesinin kimliği/alanları.
 * `pages_read_engagement`      — `/{ig-media-id}/insights` çağrısının
 *                                bağlı olduğu sayfa/işletme hesabı erişimi.
 */
export const INSTAGRAM_INSIGHT_SCOPES: readonly string[] = [
  "instagram_manage_insights",
  "instagram_basic",
  "pages_read_engagement",
];

/** TikTok `POST /v2/video/query/` kapsamı: `video.list`. */
export const TIKTOK_LIST_SCOPE = "video.list";

/**
 * YouTube Analytics Reports kapsamları — ÜÇÜ DE talep edilir.
 *
 * 2026 doküman uyarısı bu yöntemin artık `youtube.readonly` istediğini söylüyor;
 * aynı sayfadaki kapsam tablosu ise hâlâ `yt-analytics.readonly` listeliyor.
 * ÇELİŞKİ ÇÖZÜLMEZ, İKİSİ DE (ve parasal olan) istenir:
 *   * eksik kapsam → 403 `insufficientPermissions` → ölçüm HİÇ gelmez,
 *   * fazla kapsam → yalnız bir kapsan fazladan istenir, kullanıcı reddedebilir.
 * Fazladan istenen tek kapsam `yt-analytics-monetary.readonly`'dır ve gelir
 * hesabı için GEREKMEZ; yine de istenir çünkü Google'ın iki farklı yönlendirme
 * arasında bölündüğü doğrulanmış bir belirsizliktir ve bu listeden çıkarmak
 * "bazen 403" demektir.
 */
export const YOUTUBE_ANALYTICS_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

export const REQUIRED_ANALYTICS_SCOPES: Readonly<Record<Platform, readonly string[]>> = {
  instagram: INSTAGRAM_INSIGHT_SCOPES,
  tiktok: [TIKTOK_LIST_SCOPE],
  youtube: YOUTUBE_ANALYTICS_SCOPES,
};

/**
 * Eksik izinleri döndürür. Liste boşsa ölçüm denemesi anlamlıdır.
 *
 * Kısmi eşleşme YETMEZ: izinler tam olarak istenenlerdir, "benzer" bir izin
 * (`instagram_basic` varken `instagram_manage_insights` yok) sayılmaz.
 */
export function missingScopes(
  platform: Platform,
  have: readonly string[] | null | undefined,
): string[] {
  const granted = new Set((have ?? []).map((s) => s.trim()).filter((s) => s !== ""));
  return REQUIRED_ANALYTICS_SCOPES[platform].filter((needed) => !granted.has(needed));
}