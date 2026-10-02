/**
 * YALNIZ VARLIK YÜKLEME — içerik kaydı OLMADAN.
 *
 * `POST /api/v1/assets` panelde "dosyayı yükle, sonra içerik oluştur" akışıdır.
 * `IngestService` her çağrıda bir `contents` kaydı açar; panel önce medyayı
 * yükleyip sonra metin/planlama girmek istediğinde bu YANLIŞ olurdu (yarım
 * taslaklar birikir).
 *
 * ── BELLEK KURALI ───────────────────────────────────────────────────────────
 * Dosya önce GEÇİCİ bir anahtara **akışla** yazılır, sonra içerik özeti bu
 * dosyadan `createReadStream` ile hesaplanır ve kalıcı anahtara kopyalanır.
 * 2 GB'lık bir yükleme `buffer`a alınmaz; `Buffer.concat` bu boyutta süreci
 * öldürür.
 *
 * Aynı içerik adresi (sha256) kullanıldığı için bu yolla yüklenen dosya ile
 * `IngestService` ile gelen aynı dosya TEK varlığı paylaşır.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import type {
  Asset,
  MediaInfo,
  Platform,
  PlatformSpec,
  ValidationFinding,
} from "../contract/index.js";
import type { AssetRepo, AuditRepo } from "../db/index.js";
import { errorsOf, getSpec, validateMedia } from "../media/index.js";
import type { FfmpegProbe, MediaStore, Transcoder } from "../ports/index.js";
import { attachCover } from "./cover.js";
import { MAX_INGEST_BYTES, storageKeyForDigest } from "./ingest.js";

export interface AssetOnlyDeps {
  assets: AssetRepo;
  store: MediaStore;
  probe: FfmpegProbe;
  /**
   * Kapak karesi üretimi. `IngestService` ile AYNI yardımcıyı (`cover.ts`)
   * çağıran bu akış da kapak üretir.
   *
   * **ZORUNLU alan DEĞİL** ama verilmezse varlık yine de oluşur, `coverKey`
   * `null` kalır ve `asset.cover_skipped` denetim kaydı yazılır. Gerekçe:
   * `src/http/server.ts` bu bağımlılığı ZATEN geçmiyor (o dosya bu paketin
   * yazma yüzeyi DIŞINDA); zorunlu yapsaydık `tsc` kırılır ve yükleme
   * uçtan uca çalışamaz olurdu. Alan eklendiğinde bağlanması gereken tek yer
   * `src/http/server.ts:710`'daki `uploadAsset(...)` çağrısıdır.
   */
  transcoder?: Transcoder;
  audit: AuditRepo;
  getSpec: (p: Platform) => PlatformSpec;
}

export interface AssetOnlyResult {
  asset: Asset;
  /** Bu içerik daha önce yüklenmişti; mevcut varlık döndürüldü. */
  reused: boolean;
  findings: ValidationFinding[];
  /** `severity === "error"` bulgular. Panelde kırmızı gösterilir. */
  errors: ValidationFinding[];
}

export class AssetUploadError extends Error {
  constructor(
    message: string,
    readonly code: "empty" | "too_large" | "store_failed" = "store_failed",
  ) {
    super(message);
    this.name = "AssetUploadError";
  }
}

export interface UploadAssetInput {
  fileName: string;
  projectId?: string | null;
  /** Akıştan yükleme (multipart). Tampon değil, DISKE akıtılır. */
  stream?: NodeJS.ReadableStream | Readable;
  /** Tampon yükleme (küçük dosyalar, testler, CLI). */
  body?: Buffer;
  /**
   * HTTP katmanının multipart akışını ZATEN depoya yazdığı durum. Burada
   * ikinci kez yazılmaz; içerik özeti ve kalıcı anahtar üretimi aynı yoldan
   * geçer. `stream`/`body` bu durumda verilmez.
   */
  stagedKey?: string;
}

/**
 * Tek akış: geçici anahtara yaz → özet hesapla → kalıcı anahtara taşı →
 * probe → üç platformda doğrula → varlık kaydı.
 */
export async function uploadAsset(
  deps: AssetOnlyDeps,
  input: UploadAssetInput,
): Promise<AssetOnlyResult> {
  const fileName = basename(String(input.fileName || "dosya.mp4")).slice(0, 255);
  // `stagedKey` verilmişse dosya depoda ZATEN var; yeniden yazılmaz.
  const tmpKey = input.stagedKey ?? `tmp/upload/${randomSegment()}`;
  const ownsTmp = input.stagedKey === undefined;
  if (!ownsTmp) {
    const sources = [input.stream, input.body].filter((s) => s !== undefined);
    if (sources.length > 0) {
      throw new AssetUploadError(
        "stagedKey verilmişken stream/body verilemez.",
        "empty",
      );
    }
  } else {
    const sources = [input.stream, input.body].filter((s) => s !== undefined);
    if (sources.length !== 1) {
      throw new AssetUploadError("Tam olarak bir kaynak verilmeli (stream veya body).", "empty");
    }
    if (input.body !== undefined && input.body.length === 0) {
      throw new AssetUploadError("Yüklenen dosya boş.", "empty");
    }
    if (input.body !== undefined && input.body.length > MAX_INGEST_BYTES) {
      throw new AssetUploadError(
        `Dosya çok büyük: ${input.body.length} bayt > ${MAX_INGEST_BYTES} bayt.`,
        "too_large",
      );
    }
  }

  try {
    let knownBytes: number | null = null;
    if (ownsTmp) {
      const put = await deps.store.put(
        tmpKey,
        (input.stream ?? input.body) as Buffer | NodeJS.ReadableStream,
      );
      if (put.bytes === 0) throw new AssetUploadError("Yüklenen dosya boş.", "empty");
      knownBytes = put.bytes;
    }
    const tmpPath = deps.store.pathFor(tmpKey);

    const digest = await sha256OfFile(tmpPath);
    const key = storageKeyForDigest(digest, fileName);
    const bytes = await stat(tmpPath).then(
      (s) => s.size,
      () => knownBytes ?? 0,
    );
    if (bytes === 0) throw new AssetUploadError("Yüklenen dosya boş.", "empty");

    const existing = deps.assets.getByStorageKey(key);
    if (existing) {
      record(deps, "asset.upload_reused", existing.id, { storageKey: key, bytes });
      // `stagedKey` bize ait DEĞİLSE silinmez: çağıran (HTTP) temizliği kendisi
      // yapar ve silmek onun akışını bozar.
      if (ownsTmp) await deps.store.remove(tmpKey).catch(() => undefined);
      return {
        asset: existing,
        reused: true,
        findings: existing.findings,
        errors: errorsOf(existing.findings),
      };
    }

    await deps.store.put(key, createReadStream(tmpPath));
    const path = deps.store.pathFor(key);
    if (ownsTmp) await deps.store.remove(tmpKey).catch(() => undefined);

    const info = await probeOrEmpty(deps, path, key, bytes);
    // Doğrulama ÜÇ platform için yapılır: yükleyen hangisini hedeflediğini
    // henüz söylememiştir; paneldeki kırmızı liste eksik olmasın.
    const findings: ValidationFinding[] = [];
    for (const platform of ["instagram", "tiktok", "youtube"] as const) {
      findings.push(...validateMedia(info, deps.getSpec(platform)));
    }

    const asset = deps.assets.create({
      projectId: input.projectId ?? null,
      storageKey: key,
      originalName: fileName,
      bytes,
      mimeType: mimeFor(fileName),
      info,
      findings,
    });
    record(deps, "asset.uploaded", asset.id, {
      storageKey: key,
      bytes,
      findings: findings.length,
      errors: errorsOf(findings).length,
    });
    // Kapak üretimi varlık kaydından SONRA yapılır: `attachCover` varlığın
    // `cover_key` sütununu günceller, dolayısıyla varlığın var olmasını gerektirir.
    // Üretilemezse varlık yine de geçerlidir (`coverKey: null`).
    await attachCoverFor(deps, asset.id, path, findings);
    // `AssetRepo.setCoverKey` veritabanını günceller; `create()`'in döndürdüğü
    // nesne bayttan kopyadır ve `coverKey`'yi HÂLÂ `null` gösterir. Çağıranın
    // (HTTP gövdesi) dolu `coverKey` görmesi için kayıt YENİDEN OKUNUR.
    const withCover = deps.assets.getById(asset.id) ?? asset;
    return { asset: withCover, reused: false, findings, errors: errorsOf(findings) };
  } catch (err) {
    if (ownsTmp) await deps.store.remove(tmpKey).catch(() => undefined);
    if (err instanceof AssetUploadError) throw err;
    throw new AssetUploadError(
      `Dosya depolanamadı: ${err instanceof Error ? err.message : String(err)}`,
      "store_failed",
    );
  }
}

async function probeOrEmpty(
  deps: AssetOnlyDeps,
  path: string,
  storageKey: string,
  bytes: number,
): Promise<MediaInfo> {
  try {
    return await deps.probe.probe(path);
  } catch (err) {
    // Probe edilemeyen dosya "kaydedildi ama yayına hazır değil" demektir.
    // Silmek, kullanıcının dosyasını ve nedenini kaybetmektir.
    record(deps, "asset.probe_failed", storageKey, {
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      path: storageKey,
      bytes,
      container: null,
      videoCodec: null,
      audioCodec: null,
      pixelFormat: null,
      width: null,
      height: null,
      fps: null,
      durationSec: null,
      bitrate: null,
      hasAudio: false,
    };
  }
}

function record(
  deps: AssetOnlyDeps,
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
): void {
  try {
    deps.audit.record({ actor: "panel", action, targetType: "asset", targetId, detail });
  } catch {
    /* denetim yazılamazsa yükleme başarısız sayılmaz */
  }
}

/**
 * Kapak üretimini ortak yardımcıya devreder.
 *
 * `transcoder` BAĞLANMAMIŞSA varlık yine de oluşur ve neden denetime yazılır:
 * "kapak üretilmedi" sessizce geçilirse `cover_key` boş bir varlıkla karşılaşıp
 * nedenini bulamayız. Bu dal, `src/http/server.ts`'ın bu bağımlılığı henüz
 * geçmemesinden kaynaklanır (bkz. `AssetOnlyDeps.transcoder`).
 */
async function attachCoverFor(
  deps: AssetOnlyDeps,
  assetId: string,
  path: string,
  findings: readonly ValidationFinding[],
): Promise<void> {
  if (deps.transcoder === undefined) {
    record(deps, "asset.cover_skipped", assetId, {
      message:
        "transcoder bağımlılığı verilmediği için kapak üretilmedi " +
        "(src/http/server.ts `uploadAsset` çağrısına `transcoder` eklenmelidir).",
    });
    return;
  }
  await attachCover({
    assetId,
    path,
    findings,
    actionBase: "asset.cover",
    assets: deps.assets,
    store: deps.store,
    transcoder: deps.transcoder,
    audit: (targetId, action, detail) => record(deps, action, targetId, detail),
  });
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function randomSegment(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function mimeFor(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

/** Testler ve CLI: üç platformun da spec'ini isteyen yardımcı. */
export const defaultGetSpec = getSpec;