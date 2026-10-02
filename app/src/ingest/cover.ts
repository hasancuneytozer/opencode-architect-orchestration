/**
 * KAPAK ÜRETİMİ — ORTAK YARDIMCI.
 *
 * ── NEDEN AYRI DOSYA ────────────────────────────────────────────────────────
 * Kapak üretimi iki giriş noktasında gerekir:
 *   - `IngestService.ingest`      (içerik + varlık, tek akış)
 *   - `uploadAsset` (`POST /api/v1/assets`, YALNIZ varlık)
 * Mantık ikisinde de **birebir aynıdır**: yüzde konumdan `grabCover` → özetle
 * `covers/<sha256>.jpg` → `store.put` → `assets.setCoverKey`.
 *
 * Bu ikinci giriş noktası bir zamanlar `IngestService`'i çağırmıyordu ve
 * `transcoder` bağımlılığı `AssetOnlyDeps`'te hiç bulunmadığı için kapak
 * ÜRETİLMİYORDU: `coverKey: null` + `GET /assets/:id/cover` → 404. Panelin
 * kütüphane ızgarası ve platform kapak seçimi bu görüntüyü kullandığı için
 * yükleme sonrası her varlık kapaksız görünüyordu.
 *
 * Mantık KOPYALANIRSA iki yol ayrışır: birinde `coverAtPercent` değişirse
 * diğeri eski kalır ve aynı dosya iki farklı anahtarla iki kapak üretir
 * (içerik adresi mantığı `storageKey`'de olduğu gibi kapakta da içerikten
 * türetilir; sapma iki kapak, ıslak disk ve yanlış `coverKey` demektir).
 * Bu yüzden tek doğrudur.
 *
 * ── KAPAK ZORUNLU DEĞİLDİR ─────────────────────────────────────────────────
 * Üretim BAŞARISIZ olursa varlık YİNE DE oluşur, `coverKey: null` kalır ve hata
 * `audit`'e yazılır. Gerekçe: kapak bir **türetilmiş** görseldir; dosyanın
 * kendisi kaybolmamalıdır. Sessizce yutulan hata ise "kapak neden yok?"
 * sorusunu yanıtlanamaz hale getirir — bu yüzden `cover_failed` denetim kaydı
 * ZORUNLUDUR.
 */
import { createHash } from "node:crypto";

import type { ValidationFinding } from "../contract/index.js";
import type { AssetRepo } from "../db/index.js";
import type { MediaStore, Transcoder } from "../ports/index.js";
import { COVER_AT_PERCENT } from "./ingest.js";

export interface CoverDeps {
  assets: AssetRepo;
  store: MediaStore;
  transcoder: Transcoder;
  /** Denetim yazımı. Hata YUTULMAZ (aşağıdaki gerekçe). */
  audit: (targetId: string, action: string, detail: Record<string, unknown>) => void;
}

export interface CoverResult {
  /** Yazılan kapak anahtarı; üretilemezse `null` (varlık yine de geçerli). */
  coverKey: string | null;
  /** Neden üretilemedi (`null` ise sorun yok). Panelde gösterilebilir. */
  reason: string | null;
}

/**
 * Denetim olayı öneki. Çağıran kendi olay adını (`ingest.cover` /
 * `asset.cover`) `actionBase` ile verir; iki akışın denetim izi AYIRT
 * EDİLEBİLİR olsun diye.
 */
export interface AttachCoverOptions extends CoverDeps {
  assetId: string;
  /** Depodaki kaynak dosyanın YOLU (`transcoder.grabCover` yol ister). */
  path: string;
  /** `unreadable` bulgusu varsa kapak denemesi anlamsızdır. */
  findings: readonly ValidationFinding[];
  /** Denetim olayı öneki. */
  actionBase: string;
  /** Yüzde konum (10-95). Varsayılan sözleşme değeri 35. */
  atPercent?: number;
}

/**
 * `sha256(bytes)` → 64 karakter hex.
 *
 * Aynı kapak iki kez üretilirse AYNI anahtarı alır; `store.put` üzerine yazmak
 * zararsızdır ve ıslak diskte kopya kalmaz. Bu, `storageKey` ile aynı ilkedir.
 */
export function coverKeyFor(bytes: Buffer): string {
  return `covers/${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.jpg`;
}

/**
 * Kapak üretir ve `assets.cover_key` alanına yazar.
 *
 * SIRALAMA:
 *   1. Zaten kapak varsa **hiç dokunmaz** (`setCoverKey` ikinci kez çalıştırılırsa
 *      denetimde "kapak üretildi" görünür ama anahtar değişmiş olur).
 *   2. `unreadable` bulgusu varsa atlar (bozuk dosyada kare çıkarmak anlamsız).
 *   3. `grabCover` → boş bayt gelirse atlar (kapaksız bir "kapak" göstermek,
 *      kapak üretilmiş gibi davranmaktır).
 *   4. `store.put` → `setCoverKey` → `cover` denetimi.
 *
 * **HİÇBİR AŞAMADA HATA `cover_failed` DENETİMİYLE YUTULUR** ve
 * `{ coverKey: null, reason }` döner. Çağıran varlığı OLUŞTURMAYA DEVAM EDER.
 */
export async function attachCover(opts: AttachCoverOptions): Promise<CoverResult> {
  const current = opts.assets.getById(opts.assetId);
  if (current?.coverKey) {
    return { coverKey: current.coverKey, reason: null };
  }
  if (opts.findings.some((f) => f.code === "unreadable")) {
    const reason = "Dosya okunabilir görünmüyor; kapak üretilmedi (unreadable).";
    return { coverKey: null, reason };
  }

  try {
    const bytes = await opts.transcoder.grabCover(opts.path, opts.atPercent ?? COVER_AT_PERCENT);
    if (!bytes || bytes.length === 0) {
      const reason = "grabCover boş bayt döndürdü; kapak üretilmedi.";
      opts.audit(opts.assetId, `${opts.actionBase}.cover_empty`, { reason });
      return { coverKey: null, reason };
    }
    const put = await opts.store.put(coverKeyFor(bytes), bytes);
    opts.assets.setCoverKey(opts.assetId, put.key);
    opts.audit(opts.assetId, opts.actionBase, { coverKey: put.key, bytes: put.bytes });
    return { coverKey: put.key, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.audit(opts.assetId, `${opts.actionBase}.cover_failed`, { message });
    return { coverKey: null, reason: message };
  }
}