/**
 * ADAPTÖR KAYDI — uygulama birleştirme (composition) kökü.
 *
 * Neden `src/cli/` altında: uygulamayı kuran iki giriş noktası var
 * (`src/main.ts` ve `src/cli/index.ts`) ve ikisi de AYNI adaptör haritasını
 * görmek zorunda. Bu karar `main.ts` içinde kalsaydı, CLI onu içe aktarırken
 * `main()`'ı da çalıştırırdı; burada olmasaydı da ikinci bir kopya doğardı.
 * Kimlik anahtarı eksik olan platform SAHTE adaptöre düşer ve `liveAdapters`
 * kümesine girmez — panelde "mock" rozeti görünür, kullanıcı sahte yayın yaptığını
 * bilir.
 */
import { mockAdapter } from "../adapters/mock/index.js";
import { createYouTubeAdapter, isConfigured as youtubeConfigured } from "../adapters/youtube/index.js";
import type { AppConfig } from "../config/index.js";
import type { Platform } from "../contract/index.js";
import type { PublishAdapter } from "../ports/index.js";

export interface AdapterRegistry {
  /** `PublishService`'in beklediği harita. */
  adapters: ReadonlyMap<Platform, PublishAdapter>;
  /** Gerçek (sahte olmayan) adaptörü olan platformlar. */
  liveAdapters: ReadonlySet<Platform>;
}

/**
 * Yapılandırmaya göre adaptör haritası üretir.
 *
 * Meta ve TikTok'ın gerçek adaptörü bu pakette yok (`src/adapters/youtube/NOTES.md`
 * ve klasör düzeni); onlar daima sahte kalır ve `liveAdapters` içinde görünmez.
 */
export function buildAdapterRegistry(config: AppConfig): AdapterRegistry {
  const adapters = new Map<Platform, PublishAdapter>();
  const liveAdapters = new Set<Platform>();

  if (youtubeConfigured(config.youtube)) {
    adapters.set("youtube", createYouTubeAdapter({ now: () => Date.now() }));
    liveAdapters.add("youtube");
  } else {
    adapters.set("youtube", mockAdapter("youtube"));
  }
  adapters.set("instagram", mockAdapter("instagram"));
  adapters.set("tiktok", mockAdapter("tiktok"));

  return { adapters, liveAdapters };
}