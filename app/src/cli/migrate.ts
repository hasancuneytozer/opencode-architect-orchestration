/**
 * `npm run migrate` — veritabanı şemasını günceller.
 *
 * Neden ayrı dosya: `package.json`'daki `migrate` betiği bir dosyayı çalıştırır
 * ve o dosya bir komut SATIRI değil, doğrudan migration koşucusunu kurar.
 * `src/cli/index.ts` içine bir komut olarak gömülsedi, "npm run migrate" her
 * seferinde tüm CLI'yi ayrıştırmak zorunda kalırdı; iki giriş noktası aynı işi
 * yapardı.
 *
 * Çıkış kodu: 0 başarılı, 1 hata. Hata durumunda stack trace basılmaz; migration
 * ihlali (aynı sürümün farklı içerikle uygulanması) kullanıcının GÖRMESİ
 * gereken bilgidir ve mesajda açıkça yazılır.
 */
import { loadConfigFromDisk } from "../config/index.js";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  appliedVersions,
  loadMigrations,
  openDatabase,
  type Db,
} from "../db/index.js";

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  /** Uygulama sonrasında ledger'da olan tüm sürümler. */
  versions: string[];
}

export interface MigrateOptions {
  dbFile: string;
  migrationsDir?: string;
  /** Yazdırma (testler kapatır). Varsayılan true. */
  log?: (line: string) => void;
}

/** Migration'ları uygular ve bağlantıyı KAPATIR (hata durumunda da). */
export function runMigrations(opts: MigrateOptions): MigrateResult {
  const log = opts.log ?? (() => undefined);
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  let db: Db | null = null;
  try {
    db = openDatabase(opts.dbFile);
    const result = applyMigrations(db, dir);
    const versions = appliedVersions(db);
    if (result.applied.length === 0) {
      log(`Şema güncel (${versions.length} migration uygulanmış).`);
    } else {
      log(`Uygulandı: ${result.applied.join(", ")}`);
      if (result.skipped.length > 0) {
        log(`Dokunulmadı: ${result.skipped.join(", ")}`);
      }
    }
    return { applied: result.applied, skipped: result.skipped, versions };
  } finally {
    try {
      db?.close();
    } catch {
      // Bağlantı zaten kapalıysa kapatma hatası yutulur: migration sonucu
      // verilmiştir, kapatma başarısızlığı sonucu GEÇERSİZ KILMAZ.
    }
  }
}

/**
 * Doğrudan çalıştırıldığında (npm run migrate) gerçek koşuyu yapar.
 *
 * KORUMA: `main()` yalnız bu dosya bir giriş noktası olduğunda çağrılır.
 * Koşulsuz çağırmak, testlerin `runMigrations`'ı içe aktardığında beklenmedik
 * bir migration koşusu tetiklerdi.
 */
export function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return /[\\/]cli[\\/]migrate\.(ts|js|mjs|cjs)$/.test(entry);
}

function main(): void {
  const config = loadConfigFromDisk();
  try {
    const available = loadMigrations(MIGRATIONS_DIR);
    process.stdout.write(`Veritabanı: ${config.databaseFile}\n`);
    process.stdout.write(`Migration dosyası: ${available.length}\n`);
    runMigrations({ dbFile: config.databaseFile, log: (line) => process.stdout.write(`${line}\n`) });
    process.stdout.write("Tamam.\n");
    process.exitCode = 0;
  } catch (err) {
    // Stack trace YOK: migration ihlali kullanıcının düzeltmesi gereken bir
    // durumdur, uygulama hatası değil.
    process.stderr.write(
      `Migration uygulanamadı: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

if (isDirectRun()) main();