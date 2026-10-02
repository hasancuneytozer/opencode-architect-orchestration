/**
 * Çizim için güvenli alan dikdörtgenleri.
 *
 * Neden kopya? `describeSafeArea` tablo üretiyor ama dikdörtgenin kendisini
 * vermiyor (yalnız alan yüzdesi). React bileşeni CSS yüzdesi gerektiriyor.
 * Kopya `src/media/safeArea.ts` ile eşitlenmek ZORUNDA — `test/web/safeArea.test.ts`
 * bu eşitliği doğrular; kayarsa test kırılır.
 *
 * ⚠️ Bu değerler KURGUSAL YERLEŞİMDİR (bkz. `SAFE_AREA_PROVENANCE`).
 */
import type { Platform } from "../api/types.js";
import type { TextBoxRect } from "../lib/safeAreaUi.js";

export type DrawableRect = TextBoxRect & { kind: string };

/** `SafeAreaOverlay` bu tabloyu çizer; test de aynı tabloyu doğrular. */
export const SAFE_AREA_RECTS: Record<Platform, Record<string, DrawableRect>> = {
  instagram: {
    "instagram.actions": { x: 82, y: 58, w: 18, h: 28, kind: "actions" },
    "instagram.caption": { x: 0, y: 72, w: 82, h: 28, kind: "caption" },
    "instagram.audio": { x: 0, y: 0, w: 100, h: 12, kind: "audio" },
  },
  tiktok: {
    "tiktok.actions": { x: 82, y: 55, w: 18, h: 30, kind: "actions" },
    "tiktok.interactions": { x: 84, y: 40, w: 16, h: 15, kind: "actions" },
    "tiktok.caption": { x: 0, y: 76, w: 82, h: 24, kind: "caption" },
    "tiktok.disc": { x: 0, y: 74, w: 22, h: 20, kind: "bottom" },
  },
  youtube: {
    "youtube.actions": { x: 82, y: 52, w: 18, h: 32, kind: "actions" },
    "youtube.title": { x: 0, y: 0, w: 82, h: 14, kind: "title" },
    "youtube.channel": { x: 0, y: 86, w: 82, h: 14, kind: "bottom" },
  },
};