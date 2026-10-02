/**
 * Migration testleri — GERÇEK dosya üzerinde.
 * Burada `migrations/*.sql` dosyaları sqlite'a fiilen uygulanır.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, applyMigrations, appliedVersions, loadMigrations, openDatabase } from "../../src/db/index.js";
import { openRawDb, openTempDb, seed, type TempDb } from "./helpers.js";

let tmp: TempDb | null = null;
let scratch: string | null = null;

afterEach(() => {
  tmp?.cleanup();
  tmp = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function scratchDir(): string {
  scratch = mkdtempSync(join(tmpdir(), "sp-mig-"));
  return scratch;
}

describe("migration", () => {
  it("uygulanmamış boş veritabanına tüm migration'ları sırayla uygular", () => {
    tmp = openRawDb();
    const result = applyMigrations(tmp.db, MIGRATIONS_DIR);

    expect(result.applied).toEqual(["001", "002", "003", "004", "005"]);
    expect(result.skipped).toEqual([]);
    expect(appliedVersions(tmp.db)).toEqual(["001", "002", "003", "004", "005"]);

    const tables = tmp.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    for (const t of [
      "accounts",
      "api_keys",
      "assets",
      "audit_events",
      "contents",
      "credentials",
      "projects",
      "publish_jobs",
      "schema_migrations",
      "settings",
    ]) {
      expect(tables, `tablo ${t} oluşmalıydı`).toContain(t);
    }
  });

  it("İKİ KEZ çalıştırmak güvenlidir (idempotent) — ikinci tur hiçbir şey uygulamaz", () => {
    tmp = openRawDb();
    const first = applyMigrations(tmp.db, MIGRATIONS_DIR);
    const second = applyMigrations(tmp.db, MIGRATIONS_DIR);
    const third = applyMigrations(tmp.db, MIGRATIONS_DIR);

    expect(first.applied).toEqual(["001", "002", "003", "004", "005"]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001", "002", "003", "004", "005"]);
    expect(third.skipped).toEqual(["001", "002", "003", "004", "005"]);

    // Ledger'da tek kayıt var; veri bozulmadı.
    const n = tmp.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM schema_migrations")
      .get();
    expect(n?.n).toBe(5);
  });

  it("Uygulanmış migration içeriği değişirse checksum tutarsızlığını bildirir", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "001_deneme.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);", "utf8");

    tmp = openRawDb();
    const db = tmp.db;
    expect(applyMigrations(db, dir).applied).toEqual(["001"]);

    // Aynı sıra numarası, farklı içerik: sessizce yutmak yerine hata.
    writeFileSync(join(dir, "001_deneme.sql"), "CREATE TABLE t2 (id TEXT PRIMARY KEY);", "utf8");
    expect(() => applyMigrations(db, dir)).toThrow(/checksum|değiştirme/i);
  });

  it("Hatalı migration'da transaction ROLLBACK olur, ledger'a yazılmaz", () => {
    const dir = scratchDir();
    writeFileSync(
      join(dir, "001_ilk.sql"),
      `CREATE TABLE gecerli (id TEXT PRIMARY KEY);
       CREATE TABLE bozuk_syntax (id TEXT NOT NULL, ((();`,
      "utf8",
    );

    tmp = openRawDb();
    const db = tmp.db;
    expect(() => applyMigrations(db, dir)).toThrow();

    // İlk tablo da geri alındı: transaction bütünüyle iptal.
    // SQL'de placeholder YOK; sabit `name='gecerli'` zaten sorgunun içinde.
    const exists = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='gecerli'",
      )
      .get();
    expect(exists?.n ?? 0).toBe(0);
    expect(appliedVersions(db)).toEqual([]);
  });

  it("Kısmi başarısızlıktan sonra düzeltilen migration yeniden çalışır", () => {
    const dir = scratchDir();
    const bad = join(dir, "001_ilk.sql");
    writeFileSync(bad, "CREATE TABLE yarim (id TEXT PRIMARY KEY, ((();", "utf8");

    tmp = openRawDb();
    const db = tmp.db;
    expect(() => applyMigrations(db, dir)).toThrow();
    expect(appliedVersions(db)).toEqual([]);

    // Hatayı düzelt: aynı sürüm numarası bu kez uygulanabilir.
    writeFileSync(bad, "CREATE TABLE yarim (id TEXT PRIMARY KEY);", "utf8");
    expect(applyMigrations(db, dir).applied).toEqual(["001"]);
  });

  it("Geçersiz dosya adını baştan reddeder (sessizce atlamak yanıltıcıdır)", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "deneme.sql"), "SELECT 1;", "utf8");
    expect(() => loadMigrations(dir)).toThrow(/geçersiz/i);
  });

  it("Aynı sıra numarasını iki dosya kullanırsa hata verir", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "001_bir.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dir, "001_iki.sql"), "SELECT 1;", "utf8");
    expect(() => loadMigrations(dir)).toThrow(/sıra numarası/i);
  });

  it("Migration'lar sıra numarasına göre sıralanır", () => {
    const files = loadMigrations(MIGRATIONS_DIR);
    expect(files.map((f) => f.version)).toEqual(["001", "002", "003", "004", "005"]);
    expect(files[0]?.name).toBe("001_init.sql");
    for (const f of files) expect(f.checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  it("PRAGMA'lar her bağlantıda uygulanır: WAL açık, yabancı anahtar zorunlu", () => {
    tmp = openTempDb();

    expect(String(tmp.db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(Number(tmp.db.pragma("foreign_keys", { simple: true }))).toBe(1);
  });

  it("`PRAGMA foreign_keys = OFF` ile açılan bağlantı bozulmaz (bağlantı başına uygulanır)", () => {
    tmp = openTempDb();
    // WAL veritabanı seviyesinde kalıcıdır; foreign_keys bağlantı seviyesindedir.
    tmp.db.pragma("foreign_keys = OFF");
    expect(Number(tmp.db.pragma("foreign_keys", { simple: true }))).toBe(0);
    // openDatabase her çağrıda PRAGMA'ları yeniden uygular.
    const db2 = openDatabase(tmp.file);
    expect(Number(db2.pragma("foreign_keys", { simple: true }))).toBe(1);
    db2.close();
  });

  it("migration dizini gerçekten SQL dosyaları içeriyor (boş şema değil)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      expect(sql.trim().length).toBeGreaterThan(0);
      // 002_indexes yalnız indeks kurar; tablo kuran migration da bu desene
      // uyar. `CREATE` ile yetmek yanlış olur: `CREATE INDEX` de `CREATE`'tır.
      expect(sql, `${f}: şema üreten bir ifade yok`).toMatch(/CREATE\s+(TABLE|INDEX)/i);
    }
  });

  it("003 sözleşme v2 kolonlarını gerçekten getirir (yeni alanlar + error→error_json)", () => {
    tmp = openTempDb();
    const cols = (table: string): string[] =>
      tmp!.db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((r) => r.name);

    // assets: proje bağı + türev kutusu
    expect(cols("assets")).toEqual(
      expect.arrayContaining(["project_id", "derived_from_asset_id", "derived_for_platform"]),
    );

    // contents: insan onayı + toplu üretim + susturma/AI beyanı
    const contentCols = cols("contents");
    expect(contentCols).toEqual(
      expect.arrayContaining([
        "quiet_hours_json",
        "ai_disclosure_json",
        "requires_approval",
        "approved_by",
        "approved_at",
        "batch_id",
      ]),
    );

    // publish_jobs: idempotency + yüklenen parça + JSON hata
    const jobCols = cols("publish_jobs");
    expect(jobCols).toEqual(
      expect.arrayContaining([
        "idempotency_key",
        "idempotency_first_used_at",
        "upload_url",
        "upload_url_expires_at",
        "uploaded_parts",
        "total_parts",
        "error_json",
      ]),
    );
    // 001'deki düz metin `error` KALICI olarak gitti: hata artık nesne.
    expect(jobCols).not.toContain("error");

    // lease_expires_at 001'de ISO TEXT, 003'te INTEGER epoch ms.
    const leaseType = tmp.db
      .prepare<[], { type: string }>(
        "SELECT type FROM pragma_table_info('publish_jobs') WHERE name = 'lease_expires_at'",
      )
      .get();
    expect(leaseType?.type).toBe("INTEGER");
  });

  it("003 CHECK'leri: published_no_link geçer, requires_approval yalnız 0/1", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });

    // 'published_no_link' 003 ile CHECK listesine GİRDİ.
    expect(() =>
      tmp!.db.prepare("UPDATE publish_jobs SET state = ? WHERE id = ?").run("published_no_link", job.id),
    ).not.toThrow();
    expect(() =>
      tmp!.db.prepare("UPDATE publish_jobs SET state = ? WHERE id = ?").run("published_no_linkk", job.id),
    ).toThrow(/CHECK constraint failed/i);

    // requires_approval güvenli varsayılan 1; yalnız 0/1 kabul ediliyor.
    const def = tmp.db
      .prepare<[], { dflt_value: string | null }>(
        "SELECT dflt_value FROM pragma_table_info('contents') WHERE name = 'requires_approval'",
      )
      .get();
    expect(def?.dflt_value).toBe("1");
    expect(() =>
      tmp!.db.prepare("UPDATE contents SET requires_approval = 0 WHERE id = ?").run(content.id),
    ).not.toThrow();
    expect(() =>
      tmp!.db.prepare("UPDATE contents SET requires_approval = 2 WHERE id = ?").run(content.id),
    ).toThrow(/CHECK constraint failed/i);
  });
});
