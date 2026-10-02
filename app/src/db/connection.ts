/**
 * better-sqlite3 bağlantı kurulumu.
 *
 * Sorumluluk sınırı: burada yalnızca bağlantı açılır ve PRAGMA'lar uygulanır.
 * Tablo oluşturma `migrate.ts`'in işidir; sorgu yazan `repos/*.ts`.
 */
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Db = Database.Database;

/** Her bağlantıda uygulanması zorunlu PRAGMA'lar. */
export const PRAGMAS = [
  "journal_mode = WAL",
  "foreign_keys = ON",
  "synchronous = NORMAL",
  "busy_timeout = 5000",
] as const;

export interface OpenOptions {
  /** Dosya yolunun bulunduğu dizini otomatik oluştur. Varsayılan true. */
  createDirs?: boolean;
  readonly?: boolean;
}

/** Bağlantı açar ve PRAGMA'ları uygular. */
export function openDatabase(file: string, opts: OpenOptions = {}): Db {
  if (opts.createDirs !== false) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { readonly: opts.readonly ?? false });
  applyPragmas(db);
  return db;
}

/** Var olan bağlantıya PRAGMA'ları uygular (bağlantı havuzu için). */
export function applyPragmas(db: Db): void {
  for (const p of PRAGMAS) db.pragma(p);
}
