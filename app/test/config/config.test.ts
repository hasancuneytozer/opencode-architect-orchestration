/**
 * Yapılandırma testleri.
 *
 * Kural: testler yapılandırma dosyasına BAĞLI OLMAMALI. `NODE_ENV=test`'te
 * eksik zorunlu alan hata vermez, böylece veri katmanı ve alttaki testler
 * `.env` olmadan da koşar.
 */
import { isAbsolute, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_ROOT,
  envExampleKeys,
  loadConfig,
  resolveAppPath,
  resolveDataDir,
} from "../../src/config/index.js";

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function tempDir(): string {
  scratch = mkdtempSync(join(tmpdir(), "sp-cfg-"));
  return scratch;
}

describe("loadConfig — zorunlu alanlar", () => {
  it("NODE_ENV=test'te eksik SP_MASTER_KEY ÇALIŞTIRMAYI ENGELLEMEZ (mock modu)", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });

    expect(cfg.masterKey).toBeNull();
    expect(cfg.mockMode).toBe(true);
    expect(cfg.isTest).toBe(true);
    expect(cfg.nodeEnv).toBe("test");
  });

  it("SP_MASTER_KEY yoksa mock modunda çalışır, hata fırlatmaz", () => {
    const dir = tempDir();
    const cfg = loadConfig({
      NODE_ENV: "development",
      SP_MASTER_KEY: "",
      SP_ADMIN_PASSWORD: "gizli-parola-1234",
      SP_DATA_DIR: dir,
      SP_STORAGE_DIR: join(dir, "storage"),
      SP_DATABASE_FILE: join(dir, "p.db"),
    });

    expect(cfg.mockMode).toBe(true);
    expect(cfg.masterKey).toBeNull();
    expect(cfg.adminPassword).toBe("gizli-parola-1234");
  });

  it("NODE_ENV=test'te HİÇBİR zorunlu alan gerekmez — config'siz de yüklenir", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).not.toThrow();
    expect(loadConfig({}).nodeEnv).toBe("development"); // varsayılan
  });

  it("Üretimde eksik zorunlu alan TEK bir Türkçe hata fırlatır, anahtarı ve çözümü söyler", () => {
    let hata: Error | null = null;
    try {
      loadConfig({ NODE_ENV: "production" });
    } catch (e) {
      hata = e as Error;
    }

    expect(hata).not.toBeNull();
    const msg = hata!.message;
    expect(msg).toMatch(/Yapılandırma eksik/);
    expect(msg).toContain("SP_MASTER_KEY");
    expect(msg).toContain("SP_ADMIN_PASSWORD");
    // Hangi anahtarın eksik olduğunu VE nasıl üretileceğini söylüyor.
    expect(msg).toContain(".env.example");
    expect(msg).toContain("randomBytes(32)");
    // Tek hata: birden çok hata fırlatmıyor.
    expect(msg.split("Yapılandırma eksik")).toHaveLength(2);
  });

  it("Eksik alan listesinde yalnızca GERÇEKTEN eksik olanlar sayılır", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", SP_MASTER_KEY: "abc" }),
    ).toThrow(/SP_ADMIN_PASSWORD/);
    expect(() => loadConfig({ NODE_ENV: "production", SP_MASTER_KEY: "abc" })).not.toThrow(/SP_MASTER_KEY/);
  });

  it("Geçersiz tip/geçersiz aralık ayrı bir doğrulama hatası verir", () => {
    expect(() => loadConfig({ NODE_ENV: "test", PORT: "70000" })).toThrow(/Yapılandırma geçersiz/);
    expect(() => loadConfig({ NODE_ENV: "test", SP_PUBLISH_CONCURRENCY: "0" })).toThrow(
      /Yapılandırma geçersiz/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", NODE_ENV_X: "1" })).not.toThrow();
  });
});

describe("loadConfig — yol mutlaklaştırma", () => {
  it("Göreli yollar `app/` köküne göre MUTLAK döner", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });

    for (const p of [cfg.dataDir, cfg.storageDir, cfg.databaseFile]) {
      expect(isAbsolute(p), `${p} mutlak olmalı`).toBe(true);
    }
    expect(cfg.dataDir.startsWith(APP_ROOT)).toBe(true);
    expect(cfg.storageDir.startsWith(APP_ROOT)).toBe(true);
    expect(cfg.databaseFile.startsWith(APP_ROOT)).toBe(true);
    expect(cfg.databaseFile).toBe(join(cfg.dataDir, "publisher.db"));
  });

  it("resolveDataDir dizini yoksa oluşturur ve mutlak döner", () => {
    const dir = tempDir();
    const hedef = join(dir, "yeni", "ic", "veri");

    expect(existsSync(hedef)).toBe(false);
    const sonuc = resolveDataDir(hedef);

    expect(sonuc).toBe(hedef);
    expect(existsSync(hedef)).toBe(true);
    expect(isAbsolute(sonuc)).toBe(true);
  });

  it("resolveAppPath göreli girdiyi app/ köküne göre mutlaklaştırır, dosya oluşturmaz", () => {
    expect(resolveAppPath("./data/x")).toBe(join(APP_ROOT, "data", "x"));
    expect(resolveAppPath("storage")).toBe(join(APP_ROOT, "storage"));
    // Mutlak girdi olduğu gibi kalır.
    const abs = join(tmpdir(), "mutlak");
    expect(resolveAppPath(abs)).toBe(abs);
  });

  it("Test verisi için geçici dizin verildiğinde yollar oraya çözülür", () => {
    const dir = tempDir();
    const cfg = loadConfig({
      NODE_ENV: "test",
      SP_DATA_DIR: dir,
      SP_STORAGE_DIR: join(dir, "media"),
      SP_DATABASE_FILE: join(dir, "media", "app.db"),
    });

    expect(cfg.dataDir).toBe(dir);
    expect(cfg.storageDir).toBe(join(dir, "media"));
    expect(cfg.databaseFile).toBe(join(dir, "media", "app.db"));
    expect(existsSync(cfg.storageDir)).toBe(true);
  });
});

describe("loadConfig — tip dönüşümleri ve varsayılanlar", () => {
  it("`.env.example` biçimindeki sayıları okur: 15_000 → 15000", () => {
    const cfg = loadConfig({ NODE_ENV: "test", SP_SCHEDULER_TICK_MS: "15_000" });
    expect(cfg.schedulerTickMs).toBe(15_000);
  });

  it("Varsayılanlar `.env.example` ile uyumludur", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });
    expect(cfg.port).toBe(4317);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.publishConcurrency).toBe(1);
    expect(cfg.schedulerTickMs).toBe(15_000);
    expect(cfg.timezone).toBe("Europe/Istanbul");
    expect(cfg.allowPrivateMediaUrl).toBe(false);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.publicBaseUrl).toBeNull();
    expect(cfg.ingestKeys).toEqual([]);
  });

  it("Boolean ve liste alanları çevrilir; boş string `undefined` sayılır", () => {
    const cfg = loadConfig({
      NODE_ENV: "test",
      SP_ALLOW_PRIVATE_MEDIA_URL: "true",
      SP_PUBLIC_BASE_URL: "https://tunel.example.com/",
      SP_INGEST_KEYS: "sp_aaa, sp_bbb ,, sp_ccc",
      SP_MASTER_KEY: "",
    });

    expect(cfg.allowPrivateMediaUrl).toBe(true);
    // Sondaki eğik çizgi atılır: adres birleştirilirken çift eğik çizgi olmasın.
    expect(cfg.publicBaseUrl).toBe("https://tunel.example.com");
    expect(cfg.ingestKeys).toEqual(["sp_aaa", "sp_bbb", "sp_ccc"]);
    expect(cfg.masterKey).toBeNull();
  });

  it("Sağlayıcı kimlikleri okunur; boşsa null döner (mock çalışır)", () => {
    const bos = loadConfig({ NODE_ENV: "test" });
    expect(bos.meta.appId).toBeNull();
    expect(bos.tiktok.clientKey).toBeNull();
    expect(bos.youtube.clientId).toBeNull();

    const dolu = loadConfig({
      NODE_ENV: "test",
      SP_META_APP_ID: "123",
      SP_META_APP_SECRET: "s",
      SP_TIKTOK_CLIENT_KEY: "tk",
      SP_GOOGLE_CLIENT_ID: "gy",
    });
    expect(dolu.meta.appId).toBe("123");
    expect(dolu.tiktok.clientKey).toBe("tk");
    expect(dolu.youtube.clientId).toBe("gy");
  });
});

describe(".env.example kapsamı", () => {
  it("Şemadaki zorunlu alanların tümü `.env.example`da tanımlı", () => {
    const keys = new Set(envExampleKeys());
    expect(keys.size).toBeGreaterThan(10);
    for (const gerekli of [
      "SP_DATA_DIR",
      "SP_STORAGE_DIR",
      "SP_DATABASE_FILE",
      "SP_MASTER_KEY",
      "SP_ADMIN_PASSWORD",
      "SP_INGEST_KEYS",
      "SP_PUBLIC_BASE_URL",
      "SP_ALLOW_PRIVATE_MEDIA_URL",
      "SP_PUBLISH_CONCURRENCY",
      "SP_SCHEDULER_TICK_MS",
      "SP_TIMEZONE",
    ]) {
      expect(keys.has(gerekli), `.env.example içinde ${gerekli} yok`).toBe(true);
    }
  });

  it("`.env.example` gerçekten okunabilir (yol doğru)", () => {
    const text = readFileSync(join(APP_ROOT, ".env.example"), "utf8");
    expect(text).toContain("SP_MASTER_KEY=");
    expect(text).toContain("SP_SCHEDULER_TICK_MS=");
  });
});
