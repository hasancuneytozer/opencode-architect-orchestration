/**
 * CLI TESTLERİ — `runCli(argv, deps)` DOĞRUDAN çağrılır.
 *
 * Neden süreç açmıyoruz: `runCli` bir SAYI döndürür ve süreç kapatmaz; komutu
 * gerçek dosyayla, gerçek veritabanıyla, gerçek ffmpeg ile çalıştırıp çıktıyı
 * ve çıkış kodunu doğrudan okuyabiliyoruz. `subprocess` kullansaydık her test
 * için node başlatmak, port beklemek ve stdout'u ayrıştırmak gerekirdi; hata
 * ayrıntısı da stack trace olarak kaybolurdu.
 *
 * ── KURULUM ──────────────────────────────────────────────────────────────────
 * İki kurulum vardır ve ikisinin amacı farklı:
 *   * `makeCli()`  → kendi geçici veritabanı. `migrate` (migration UYGULANMAMIŞ
 *     boş şema) ve `db:reset` (dosya silinip YENİDEN kurulur) testleri için
 *     zorunludur; ortak harness'in veritabanını silmek diğer testleri kırar.
 *   * `cliDeps(h)` → `test/http/helpers.ts` harness'inden türetilir. `ingest`
 *     ve `api-key revoke` gerçekten üretimle aynı depoyu/ffmpeg'i kullansın diye.
 *
 * ── NE ÖLÇÜLMEZ ──────────────────────────────────────────────────────────────
 * Argüman ayrıştırma SAF olduğu için `parseArgs`/`parsePlatforms` birim testleri
 * ayrı yazıldı; burada yalnız komutların UÇTAN UCA davranışı ölçülür.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, parseArgs, parsePlatforms, type CliDeps } from "../../src/cli/index.js";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  createRepos,
  openDatabase,
} from "../../src/db/index.js";
import { FsMediaStore, getFfmpegTools } from "../../src/media/index.js";
import {
  MutableClock,
  createHarness,
  makeVideo,
  testConfig,
  type Harness,
  type TestConfigOver,
} from "../http/helpers.js";

// ── 1. Harness tabanlı CLI bağımlılıkları ───────────────────────────────────

let h: Harness;

/** Harness'in gerçek deposundan CLI bağımlılıkları. */
function cliDeps(): CliDeps {
  return {
    config: h.config,
    db: h.db,
    repos: h.repos,
    store: h.store,
    probe: h.ffmpeg,
    transcoder: h.ffmpeg,
    clock: h.clock,
  };
}

/** `--json` çıktısını ayrıştırır. Çıktı JSON değilse test kırılır. */
function jsonOf(out: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`JSON nesnesi bekleniyordu: ${out.slice(0, 200)}`);
  }
  return parsed as Record<string, unknown>;
}

/** Stack izi satırı var mı? (`    at ...`). Kullanıcıya gösterilmemeli. */
function hasStackTrace(text: string): boolean {
  return /^ {2,}at /m.test(text);
}

// ── 2. Bağımsız kurulum (migration / db:reset) ─────────────────────────────

interface Standalone {
  dir: string;
  deps: CliDeps;
  /**
   * `db` bağlantısını kapatır.
   *
   * Neden gerekli: `db:reset` dosyayı `rmSync` ile SİLİYOR. Windows'ta açık
   * bir SQLite bağlantısı silmeyi engellediği için komut gerçekte geçse bile
   * hata döner — yani test "reset çalışmıyor" sanardı. `cmdDbReset` zaten
   * `deps.db`'yi KULLANMAZ (kendi bağlantısını `openDatabase` ile açar), yani
   * bu kapatma üretim davranışını değiştirmez, yalnız dosya kilidini kaldırır.
   */
  releaseDb(): void;
  close(): void;
}

/**
 * Kendi veritabanı olan CLI kurulumu.
 *
 * `migrated` varsayılan `true`: liste/anahtar komutları migration UYGULANMAMIŞ
 * bir şemada (`no such table`) çalışmaz ve test, komutun hatasını değil
 * kurulumun eksikliğini ölçüyor olurdu. `migrate` komutunun testi bunun
 * tersini ister: `migrated: false` ile boş şema açılır.
 */
function makeCli(opts: { migrated?: boolean } & TestConfigOver = {}): Standalone {
  const { migrated = true, ...over } = opts;
  const dir = mkdtempSync(join(tmpdir(), "sp-cli-"));
  const config = testConfig(dir, over);
  const db = openDatabase(config.databaseFile);
  if (migrated) applyMigrations(db, MIGRATIONS_DIR);
  const repos = createRepos(db);
  const store = new FsMediaStore(config.storageDir, {
    publicBaseUrl: config.publicBaseUrl,
    secret: config.masterKey ?? "sp-cli-imza-sirri",
  });
  const ffmpeg = getFfmpegTools();
  return {
    dir,
    deps: {
      config,
      db,
      repos,
      store,
      probe: ffmpeg,
      transcoder: ffmpeg,
      clock: new MutableClock(),
      // `db:reset` varsayılan olarak `process.stdin` okur; testte asla
      // bloklanmamalı. Verilmeyen her onay "hayır" sayılır.
      confirm: async () => "hayir",
    },
    releaseDb() {
      try {
        db.close();
      } catch {
        /* zaten kapalı */
      }
    },
    close() {
      try {
        db.close();
      } catch {
        /* dosya zaten silinmiş olabilir */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows'ta WAL dosyası bir an geç tutulabilir */
      }
    },
  };
}

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

// ── 3. Argüman ayrıştırma (saf) ─────────────────────────────────────────────

describe("parseArgs", () => {
  it("konumsal, --ad=değer ve --ad değer biçimlerini ayırır", () => {
    const args = parseArgs(["api-key", "create", "proje", "--campaign=nisan", "--limit", "5"]);
    expect(args.positional).toEqual(["api-key", "create", "proje"]);
    expect(args.flags["campaign"]).toBe("nisan");
    expect(args.flags["limit"]).toBe("5");
    expect(args.switches.has("limit")).toBe(false);
  });

  it("değersiz bayrak switches'e girer", () => {
    const args = parseArgs(["ingest", "--json", "--no-approval"]);
    expect(args.switches.has("json")).toBe(true);
    expect(args.switches.has("no-approval")).toBe(true);
  });

  it("tekrarlanan bayrak SON değeri korur (sessizce ilki yutulmaz)", () => {
    const args = parseArgs(["ingest", "--platforms", "ig", "--platforms", "tt,yt"]);
    expect(args.flags["platforms"]).toBe("tt,yt");
  });

  it("değer bekleyen bayrağın değeri yoksa anlaşılır hata verir", () => {
    expect(() => parseArgs(["ingest", "--file"])).toThrow(/bir değer istiyor/);
    // Değer yerine başka bayrak geldiyse de "eksik" sayılır.
    expect(() => parseArgs(["ingest", "--file", "--json"])).toThrow(/bir değer istiyor/);
  });
});

describe("parsePlatforms", () => {
  it("virgüllü liste ve kısaltmaları çözer, tekrarları eler", () => {
    expect(parsePlatforms("ig, tt , yt")).toEqual(["instagram", "tiktok", "youtube"]);
    expect(parsePlatforms("instagram,ig")).toEqual(["instagram"]);
    expect(parsePlatforms("youtube, tiktok")).toEqual(["youtube", "tiktok"]);
  });

  it("bayrak yoksa instagram varsayılanı", () => {
    expect(parsePlatforms(undefined)).toEqual(["instagram"]);
  });

  it("geçersiz platformu reddeder ve geçerli olanları listeler", () => {
    expect(() => parsePlatforms("myspace")).toThrow(/Bilinmeyen platform/);
    expect(() => parsePlatforms("ig, myspace")).toThrow(/instagram, tiktok, youtube/);
  });

  it("yalnız virgül/boşluktan oluşan liste reddedilir (sessiz instagram olmaz)", () => {
    expect(() => parsePlatforms(",, ,")).toThrow(/boş kalmış/);
  });
});

// ── 4. Yardım ve kullanım ───────────────────────────────────────────────────

describe("yardım ve kullanım", () => {
  it("--help komut listesini basar ve 0 döner", async () => {
    const r = await runCli(["--help"], cliDeps());
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    for (const komut of ["migrate", "db:reset", "api-key", "ingest", "setup", "scheduler"]) {
      expect(r.out).toContain(komut);
    }
  });

  it("komut verilmeden hile (usage) metni stderr'e gider, 1 döner", async () => {
    const r = await runCli([], cliDeps());
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("--help");
  });

  it("bilinmeyen komut insan diliyle reddedilir", async () => {
    const r = await runCli(["uydurma-komut"], cliDeps());
    expect(r.code).toBe(1);
    expect(r.err).toContain("Bilinmeyen komut");
    expect(r.err).toContain("--help");
    expect(hasStackTrace(r.err)).toBe(false);
  });

  it("geçersiz alt komut seçenekleri listeler", async () => {
    const r = await runCli(["api-key", "yok"], cliDeps());
    expect(r.code).toBe(1);
    expect(r.err).toContain("create | list | revoke");
  });
});

// ── 5. migrate / db:reset ───────────────────────────────────────────────────

describe("migrate", () => {
  it("boş veritabanında hatasız uygular ve 0 döner", async () => {
    const s = makeCli({ migrated: false });
    try {
      const r = await runCli(["migrate", "--json"], s.deps);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      // Boş şemada EN AZ BİR migration uygulanmış olmalı; "Şema güncel"
      // demek burada sessiz bir sahte yeşil olurdu.
      const applied = jsonOf(r.out)["applied"];
      expect(Array.isArray(applied) ? applied.length : 0).toBeGreaterThan(0);
      // İnsan dili karşılığı da Türkçe.
      const human = await runCli(["migrate"], s.deps);
      expect(human.out).toContain("Şema güncel");
    } finally {
      s.close();
    }
  });

  it("İKİNCİ kez çağırmak güvenlidir: hiçbir migration yeniden uygulanmaz", async () => {
    const s = makeCli({ migrated: false });
    try {
      const first = await runCli(["migrate", "--json"], s.deps);
      expect(first.code).toBe(0);

      const second = await runCli(["migrate", "--json"], s.deps);
      expect(second.code).toBe(0);
      expect(second.err).toBe("");
      const applied = jsonOf(second.out)["applied"];
      expect(Array.isArray(applied) ? applied.length : 0).toBe(0);
      // Zaten uygulananlar ATLANMIŞ olarak listelenir: ikinci koşu hiçbir şeyi
      // yeniden yazmadı ama hangi sürümlerin mevcut olduğu da kaybolmaz.
      expect((jsonOf(second.out)["skipped"] as string[]).length).toBeGreaterThan(0);
      expect(await runCli(["migrate"], s.deps)).toMatchObject({ code: 0 });
    } finally {
      s.close();
    }
  });
});

describe("db:reset", () => {
  it("onay istemeden silmez (hayır cevabı → 1, dosya durur)", async () => {
    const s = makeCli();
    try {
      await runCli(["migrate"], s.deps);
      const dbFile = s.deps.config.databaseFile;
      expect(existsSync(dbFile)).toBe(true);

      const r = await runCli(["db:reset"], s.deps); // confirm → "hayir"
      expect(r.code).toBe(1);
      expect(r.err).toContain("Onaylanmadı");
      expect(existsSync(dbFile)).toBe(true);
    } finally {
      s.close();
    }
  });

  it("--yes ile siler ve şemayı yeniden kurar", async () => {
    const s = makeCli();
    try {
      await runCli(["migrate"], s.deps);
      const dbFile = s.deps.config.databaseFile;
      // Dosya kilidini kaldır (bkz. `releaseDb` yorumu): komutun kendisi
      // `deps.db`'yi açmıyor.
      s.releaseDb();

      const r = await runCli(["db:reset", "--yes"], s.deps);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out).toContain("sıfırlandı");
      expect(existsSync(dbFile)).toBe(true);

      // Yeniden kurulan şema BOŞ ama EKSİKSİZ olmalı: `api_keys` tablosu
      // sorgulanabiliyorsa migration'lar gerçekten uygulanmış demektir.
      const check = openDatabase(dbFile);
      try {
        const row = check
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'",
          )
          .get();
        expect(row?.name).toBe("api_keys");
      } finally {
        check.close();
      }
    } finally {
      s.close();
    }
  });
});

// ── 6. api-key ──────────────────────────────────────────────────────────────

describe("api-key", () => {
  it("create → sp_ ile başlayan ham anahtar verir", async () => {
    const r = await runCli(["api-key", "create", "cli-projesi", "--json"], cliDeps());
    expect(r.code).toBe(0);
    const key = String(jsonOf(r.out)["key"] ?? "");
    expect(key.startsWith("sp_")).toBe(true);
    expect(jsonOf(r.out)["id"]).toBeTruthy();
  });

  it("create → ikinci listede ham anahtar YOK, yalnız prefix var", async () => {
    const created = await runCli(["api-key", "create", "sirlar", "--json"], cliDeps());
    const key = String(jsonOf(created.out)["key"] ?? "");
    expect(key).not.toBe("");

    const list = await runCli(["api-key", "list", "--json"], cliDeps());
    expect(list.code).toBe(0);
    expect(list.out).not.toContain(key);
    const keys = jsonOf(list.out)["keys"] as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThan(0);
    const ilk = keys[0] ?? {};
    expect(Object.keys(ilk)).not.toContain("key");
    expect(String(ilk["prefix"] ?? "")).toMatch(/^sp_/);
  });

  it("create → insan dili çıktı 'yalnız bir kez' uyarısını taşır", async () => {
    const r = await runCli(["api-key", "create", "uyari"], cliDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain("Bu anahtar YALNIZCA şimdi gösterilir");
    expect(r.out).toMatch(/^sp_/m);
  });

  it("list → kayıt yokken dürüstçe 'Kayıtlı anahtar yok' der", async () => {
    const s = makeCli();
    try {
      const r = await runCli(["api-key", "list"], s.deps);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Kayıtlı anahtar yok");
    } finally {
      s.close();
    }
  });

  it("revoke → anahtar reddedilir (lookup boş, HTTP 401 unauthorized)", async () => {
    const created = await runCli(["api-key", "create", "iptal", "--json"], cliDeps());
    const key = String(jsonOf(created.out)["key"] ?? "");
    const id = String(jsonOf(created.out)["id"] ?? "");

    // Revoke ÖNCESİ anahtar kabul edilir: aksi halde test "zaten çalışmıyordu"
    // sonucunu kanıtlardı.
    expect(h.repos.apiKeys.lookup(key)).not.toBeNull();

    const r = await runCli(["api-key", "revoke", id], cliDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain("iptal edildi");

    expect(h.repos.apiKeys.lookup(key)).toBeNull();
    expect(h.repos.apiKeys.lookup(key, { allowRevoked: true })).not.toBeNull();

    // Gerçek kapı: ingest ucu 401 döner.
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": key, "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], sourcePath: "a.mp4" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("revoke → bilinmeyen id kullanım hatası verir", async () => {
    const r = await runCli(["api-key", "revoke", "olmayan-id"], cliDeps());
    expect(r.code).toBe(1);
    expect(r.err).toContain("Anahtar bulunamadı");
  });
});

// ── 7. setup check ──────────────────────────────────────────────────────────

describe("setup check", () => {
  it("eksik anahtarları listeler (JSON: envKeys dolu)", async () => {
    const r = await runCli(["setup", "check", "--json"], cliDeps());
    expect(r.code).toBe(0);
    const problems = jsonOf(r.out)["problems"] as Array<Record<string, unknown>>;
    expect(problems.length).toBeGreaterThan(0);
    const envKeys = problems.flatMap((p) => (p["envKeys"] as string[]) ?? []);
    expect(envKeys.length).toBeGreaterThan(0);
    // Sahte anahtar tanıtıcı değil: gerçek ortam değişkeni adı beklenir.
    expect(envKeys.some((k) => k.startsWith("SP_"))).toBe(true);
  });

  it("insan dili çıktı modu ve eksikleri Türkçe gösterir", async () => {
    const r = await runCli(["setup", "check"], cliDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain("Mod:");
    expect(r.out).toContain("SP_");
  });
});

// ── 8. ingest ───────────────────────────────────────────────────────────────

describe("ingest", () => {
  let videoDir: string;
  let video: string;

  beforeEach(() => {
    videoDir = mkdtempSync(join(tmpdir(), "sp-cli-video-"));
    video = makeVideo(videoDir, "cli.mp4");
  });

  afterEach(() => {
    rmSync(videoDir, { recursive: true, force: true });
  });

  it("--file + --json → çıktı JSON.parse ediliyor ve içerik oluşuyor", async () => {
    const r = await runCli(
      ["ingest", "--file", video, "--project", "cli-projesi", "--platforms", "instagram", "--json"],
      cliDeps(),
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const data = jsonOf(r.out);
    expect(data["ok"]).toBe(true);
    expect(data["state"]).toBe("ready");
    expect(data["requiresApproval"]).toBe(true); // --no-approval verilmedi
    const contentId = String(data["contentId"] ?? "");
    expect(h.repos.contents.getById(contentId)).toBeTruthy();
  });

  it("--platforms virgüllü liste: içerik iki platformu da hedefler", async () => {
    const r = await runCli(
      ["ingest", "--file", video, "--project", "coklu", "--platforms=ig,tt", "--json"],
      cliDeps(),
    );
    expect(r.code).toBe(0);
    const content = h.repos.contents.getById(String(jsonOf(r.out)["contentId"] ?? ""));
    expect(Object.keys(content?.copy ?? {})).toEqual(["instagram", "tiktok"]);
  });

  it("--no-approval onay kapısını kapatır (requiresApproval=false)", async () => {
    const r = await runCli(
      ["ingest", "--file", video, "--project", "oto", "--no-approval", "--json"],
      cliDeps(),
    );
    expect(r.code).toBe(0);
    expect(jsonOf(r.out)["requiresApproval"]).toBe(false);
  });

  it("eksik --project → exitCode 1, stack trace YOK", async () => {
    const r = await runCli(["ingest", "--file", video], cliDeps());
    expect(r.code).toBe(1);
    expect(r.err).toContain("--project");
    expect(hasStackTrace(r.err)).toBe(false);
  });

  it("geçersiz platform → 1 ve stack trace yok, Türkçe gerekçe", async () => {
    const r = await runCli(
      ["ingest", "--file", video, "--project", "p", "--platforms", "myspace"],
      cliDeps(),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("Bilinmeyen platform");
    expect(hasStackTrace(r.err)).toBe(false);
  });

  it("olmayan dosya → 1, dosya bulunamadı (IngestSourceError değil, kullanım hatası)", async () => {
    const r = await runCli(
      ["ingest", "--file", join(videoDir, "yok.mp4"), "--project", "p"],
      cliDeps(),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("Dosya bulunamadı");
    expect(hasStackTrace(r.err)).toBe(false);
    expect(h.repos.contents.listFiltered({ limit: 50 })).toEqual([]);
  });

  it("--file ve --url aynı anda reddedilir", async () => {
    const r = await runCli(
      ["ingest", "--file", video, "--url", "https://cdn.example.com/a.mp4", "--project", "p"],
      cliDeps(),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("aynı anda verilemez");
  });

  it("insan dili ingest çıktısı Türkçe alan adları içerir", async () => {
    const r = await runCli(["ingest", "--file", video, "--project", "insan"], cliDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain("varlık");
    expect(r.out).toContain("içerik");
    expect(r.out).toContain("onay gerek");
  });

  it("--json verilirse hata da JSON olarak basılır (makine okuyan ayrıştıramaz)", async () => {
    const r = await runCli(["ingest", "--file", video, "--json"], cliDeps());
    expect(r.code).toBe(1);
    const parsed = jsonOf(r.err);
    expect(parsed["ok"]).toBe(false);
    const error = parsed["error"] as Record<string, unknown>;
    expect(String(error["message"] ?? "")).toContain("--project");
    // İnsan biçimi eklenmez: makine okuyan çağıran metni ayrıştırmak zorunda kalmaz.
    expect(r.err).not.toContain("Hata:");
  });
});

// ── 9. Diğer komutların Türkçe çıktısı ─────────────────────────────────────

describe("liste komutları", () => {
  it("accounts/content/jobs boşken dürüstçe 'yok' der", async () => {
    const s = makeCli();
    try {
      for (const [komut, beklenen] of [
        ["accounts", "Bağlı hesap yok."],
        ["content", "İçerik yok."],
        ["jobs", "İş yok."],
      ] as const) {
        const r = await runCli([komut, "list"], s.deps);
        expect(r.code).toBe(0);
        expect(r.out).toContain(beklenen);
      }
    } finally {
      s.close();
    }
  });

  it("scheduler status hem makine hem insan biçiminde çalışır", async () => {
    const machine = await runCli(["scheduler", "status", "--json"], cliDeps());
    expect(machine.code).toBe(0);
    expect(jsonOf(machine.out)["running"]).toBe(false);
    expect(jsonOf(machine.out)["ticks"]).toBe(0);

    const human = await runCli(["scheduler", "status"], cliDeps());
    expect(human.code).toBe(0);
    expect(human.out).toContain("Çalışıyor");
    expect(human.out).toContain("Tick");
  });
});

