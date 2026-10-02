/**
 * Platform sabitleri — BİLEREK zod'dan bağımsız.
 *
 * Neden ayrı dosya: `contract/index.ts` zod içe aktarır (`import { z } from "zod"`).
 * Bir modül buradan bir **değer** import ettiğinde (ör. `PLATFORMS`), derleyici
 * o modülün tamamını paketler ve zod da istemcinin/JavaScript paketine gider.
 * `src/media/safeArea.ts` tarayıcıdan kullanıldığı için bu zincir zod'u
 * pakete sokuyordu (ölçüldü: 445 KB bundle).
 *
 * Kural: **çalışma zamanı sabiti gereken yerler bu dosyayı import eder.**
 * Sadece tip gereken yerler `contract/index.js`'den `import type` kullanır —
 * `verbatimModuleSyntax` bunu tamamen siler, paketlenmez.
 */
export const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
};
