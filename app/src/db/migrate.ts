/**
 * Migration çalıştırıcı.
 *
 * Sözleşmeler:
 *   * Sıra numarasına göre sırayla uygular (001, 002, ...).
 *   * Her migration kendi transaction'ında çalışır; hata olursa ROLLBACK ve
 *     `schema_migrations`'a yazılmaz, yani yeniden denemede tekrar çalışır.
 *   * İdempotenttir: aynı migration ikinci kez uygulanmaz.
 *   * Daha önce uygulanmış bir dosya DEĞİŞTİRİLMİŞSE hata fırlatır (checksum).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./connection.js";

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

const NAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/i;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex").slice(0, 32);
}

/** Migration dosyalarını sırayla okur. Geçersiz ad varsa hata fırlatır. */
export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort();

  const out: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const m = NAME_RE.exec(f);
    if (!m?.[1]) {
      throw new Error(
        `Migration dosya adı geçersiz: "${f}". Biçim zorunlu: 001_ aciklama.sql (üç haneli sıra, küçük harf).`,
      );
    }
    const version = m[1];
    if (seen.has(version)) {
      throw new Error(`Migration sıra numarası iki kez kullanılmış: ${version} (${f})`);
    }
    seen.add(version);
    const sql = readFileSync(join(dir, f), "utf8");
    out.push({ version, name: f, file: join(dir, f), sql, checksum: checksumOf(sql) });
  }
  return out;
}

function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function readLedger(db: Db): Map<string, string> {
  const rows = db
    .prepare<[], { version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    )
    .all();
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

/** Migration'ları sırayla uygular. Aynı çağrıyı tekrar etmek güvenlidir. */
export function applyMigrations(db: Db, dir: string, now: Date = new Date()): ApplyResult {
  ensureLedger(db);
  const migrations = loadMigrations(dir);
  const ledger = readLedger(db);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of migrations) {
    const known = ledger.get(m.version);
    if (known !== undefined) {
      if (known !== m.checksum) {
        throw new Error(
          `Migration ${m.version} (${m.name}) daha önce FARKLI içerikle uygulanmış. ` +
            `Uygulanmış bir migration'ı değiştirme; yeni dosya aç. ` +
            `(beklenen ${m.checksum}, kayıtlı ${known})`,
        );
      }
      skipped.push(m.version);
      continue;
    }

    // better-sqlite3'ün transaction() sarmalayıcısı BEGIN/COMMIT/ROLLBACK'i yapar.
    const run = db.transaction((mm: MigrationFile) => {
      db.exec(mm.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
      ).run(mm.version, mm.checksum, now.toISOString());
    });
    run(m); // hata olursa burada ROLLBACK ve istisna yükselir
    applied.push(m.version);
  }

  return { applied, skipped };
}

/** Hangi migration'ların uygulandığını sırayla döndürür. */
export function appliedVersions(db: Db): string[] {
  ensureLedger(db);
  return db
    .prepare<[], { version: string }>("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((r) => r.version);
}
