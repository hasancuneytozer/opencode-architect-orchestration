/**
 * Test yardımcıları: GEÇİCİ dosya üzerinde çalışan veritabanı.
 *
 * Kural: her test kendi `fs.mkdtemp` dizinini açar ve `finally` ile SİLER.
 * Paylaşılan bir `publisher.db` üzerinde çalışmak testleri birbirine bağlar
 * ve sıralamaya duyarlı hale getirir; bu kabul edilmez.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  type Repos,
  MIGRATIONS_DIR,
  applyMigrations,
  createDatabase,
  openDatabase,
} from "../../src/db/index.js";
import type {
  ContentItem,
  MediaInfo,
  Platform,
  PublishFailure,
  ValidationFinding,
} from "../../src/contract/index.js";
import { isRetryableKind } from "../../src/contract/index.js";

export interface TempDb {
  dir: string;
  file: string;
  db: Db;
  repos: Repos;
  cleanup: () => void;
}

/** Migration'ları uygulanmış geçici veritabanı açar. */
export function openTempDb(migrationsDir: string = MIGRATIONS_DIR): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "sp-db-"));
  const file = join(dir, "publisher.db");
  const { db, repos } = createDatabase(file, { migrationsDir });
  return {
    dir,
    file,
    db,
    repos,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* zaten kapalı */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Migration uygulanmamış boş bağlantı (migration testleri için). */
export function openRawDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "sp-db-raw-"));
  const file = join(dir, "publisher.db");
  const db = openDatabase(file);
  return {
    dir,
    file,
    db,
    repos: undefined as unknown as Repos,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* zaten kapalı */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { applyMigrations, MIGRATIONS_DIR };

// ── Örnek veri ────────────────────────────────────────────────────────────

export function sampleInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "storage/abc/clip.mp4",
    bytes: 12_345_678,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 14.5,
    bitrate: 4_200_000,
    hasAudio: true,
    ...over,
  };
}

/**
 * Şema testleri için ASGARİ ama GEÇERLİ `MediaInfo`.
 *
 * `AssetRepo.create` `info: MediaInfo` alanını zorunlu ister; bu testlerde medya
 * içeriği konu DEĞİL, kısıtlar konu. `sampleInfo`dan farkı: ölçüler kısıt
 * testlerini ilgilendirmeyecek kadar küçük seçilir, ama tip düzeyinde eksiksiz
 * bir `MediaInfo` üretir — yarım doldurulmuş bir nesne sessizce `null`a
 * normalleşir ve test, kastettiği CHECK'e düşmeden geçebilirdi.
 */
export function emptyInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "storage/yok/klip.mp4",
    bytes: 1024,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 3,
    bitrate: 1_200_000,
    hasAudio: true,
    ...over,
  };
}

export function sampleFindings(): ValidationFinding[] {
  return [
    { code: "aspect_ratio", severity: "error", message: "9:16 değil", limit: "9:16", observed: "1:1" },
    { code: "watermark", severity: "warning", message: "filigran var" },
  ];
}

/** Tam bağımlılık zinciri: proje → varlık → içerik → hesap. */
export function seed(repos: Repos, platform: Platform = "instagram") {
  const project = repos.projects.create({ name: "test-proje", notes: "not" });
  const asset = repos.assets.create({
    storageKey: "klasor/klip.mp4",
    originalName: "klip.mp4",
    bytes: 1000,
    mimeType: "video/mp4",
    info: sampleInfo(),
    findings: sampleFindings(),
    coverKey: "klasor/kapak.jpg",
  });
  const content = repos.contents.create({
    projectId: project.id,
    assetId: asset.id,
    state: "ready",
    campaign: "kampanya-1",
    tags: ["a", "b"],
    copy: { instagram: { caption: "merhaba", hashtags: ["x"] } },
    scheduledAt: new Date().toISOString(),
    timezone: "Europe/Istanbul",
    metadata: { source: "ai", nested: { ok: true } },
  });
  const account = repos.accounts.create({
    platform,
    externalId: `ext-${platform}-1`,
    displayName: "Hesap",
    username: "hesap",
  });
  return { project, asset, content, account };
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * `seed` bir kez çalışır: `assets.storage_key` UNIQUE ve
 * `accounts(platform, external_id)` UNIQUE. Aynı hesapla birden çok iş kurmak
 * isteyen testler AYRI içerik üretmek ZORUNDADIR — yoksa şema hata verir ve
 * test, kuyruk mantığıyla ilgisi olmayan bir UNIQUE ihlaline düşer.
 */
export function newContent(repos: Repos, projectId: string, key: string): ContentItem {
  const asset = repos.assets.create({
    storageKey: key,
    originalName: key,
    bytes: 1,
    mimeType: "video/mp4",
    info: sampleInfo({ path: key, bytes: 1 }),
  });
  return repos.contents.create({ projectId, assetId: asset.id });
}

/** `seed` ile aynı hesap zincirine yeni bir hesap ekler (external_id benzersiz). */
export function newAccount(repos: Repos, platform: Platform, key: string) {
  return repos.accounts.create({
    platform,
    externalId: `ext-${platform}-${key}`,
    displayName: `Hesap ${key}`,
    username: key,
  });
}

/** Hata nesnesi test verisi: destek kanıtı alanları boş gelmez. */
export function sampleFailure(over: Partial<PublishFailure> = {}): PublishFailure {
  const at = over.at ?? new Date().toISOString();
  const kind = over.kind ?? "ratelimit";
  return {
    kind,
    message: over.message ?? "429: çok fazla istek",
    providerCode: over.providerCode !== undefined ? over.providerCode : "RATE_LIMIT",
    logId: over.logId !== undefined ? over.logId : "log-abc-123",
    httpStatus: over.httpStatus !== undefined ? over.httpStatus : 429,
    retryAfterMs: over.retryAfterMs !== undefined ? over.retryAfterMs : 30_000,
    // Politika sözleşmede; testte de aynı kaynaktan türetilir.
    retryable: over.retryable ?? isRetryableKind(kind),
    at,
  };
}
