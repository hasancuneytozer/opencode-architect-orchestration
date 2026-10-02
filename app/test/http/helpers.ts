/**
 * HTTP / ingest / CLI testleri için ORTAK KURULUM.
 *
 * Bu dosya test değildir (`vitest` yalnızca `*.test.ts` toplar).
 *
 * ── KURALLAR (neden böyle) ──────────────────────────────────────────────────
 *   1. **Port açılmaz.** Sunucu `buildServer()` ile kurulur ve istekler
 *      `server.inject()` ile gider. Gerçek dinleyici açmak testleri yavaşlatır
 *      ve port çakışmasına açıktır; rotanın davranışı değişmez.
 *   2. **Her test kendi geçici dizinini açar ve siler.** Paylaşılan
 *      `publisher.db` testleri sıraya duyarlı hale getirirdi.
 *   3. **Depo ve ffmpeg GERÇEK.** `FsMediaStore` gerçek diske yazar, probe/
 *      kapak `ffmpeg-static` ikilisiyle çalışır. "Doğrulama 9:16'yı gerçekten
 *      ölçtü mü" sorusu sahte `MediaInfo` ile yanıtlanamaz.
 *   4. **Saat enjekte edilir (`MutableClock`).** Oturum sonu, hız sınırı ve
 *      zamanlayıcı "5 dakika sonra" diye test edilemez.
 *   5. **Adaptör SAHTEDİR (`MockPublishAdapter`).** Testler dışarıya çıkmasın.
 *
 * ── VİDEO ÜRETİM KALIBI ─────────────────────────────────────────────────────
 * `test/media/fixtures.ts`ten alındı ve DEĞİŞTİRİLMEDİ:
 *   `testsrc=size=WxH:rate=FPS:duration=S` + `sine=...:duration=S`
 * TUZAK: lavfi kaynakları **SONSUZDUR**. Yalnız `-shortest` yazılırsa ffmpeg
 * hiç bitmez. Süre KAYNAKLARA verilir; `-t` ayrıca da verilir.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Writable } from "node:stream";

import { loadConfig, type AppConfig } from "../../src/config/index.js";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  createRepos,
  openDatabase,
  type Db,
  type Repos,
} from "../../src/db/index.js";
import { buildServer, wrapScheduler, type BuiltServer, type HttpMediaStore, type SchedulerHandle } from "../../src/http/index.js";
import { IngestService, createApiKey } from "../../src/ingest/index.js";
import { FsMediaStore, getFfmpegTools, getSpec } from "../../src/media/index.js";
import { AesGcmCipher } from "../../src/security/cipher.js";
import {
  PublishService,
  Scheduler,
  StoreMediaRefResolver,
  type Clock,
} from "../../src/services/index.js";
import { MockPublishAdapter } from "../../src/adapters/mock/publisher.js";
import type { Account, Platform } from "../../src/contract/index.js";
import type { PublishAdapter } from "../../src/ports/index.js";
import { encodeTestVideo } from "../media/fixtures.js";

// ── Kimlik çözücü (tüm testlerin ORTAK anahtarı) ────────────────────────────

/**
 * Test `SP_MASTER_KEY` değeri: TAM 32 baytın base64 hâli.
 *
 * Neden 32 bayt: `normalizeMasterKey` 32 bayttan kısa/uzun malzemeyi
 * `sha256` ile türetir. Doğrudan 32 bayt verirsek "türetme gerçekten
 * deterministik mi" sorusu bu testlerde hiç gündeme gelmez.
 */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * `TEST_MASTER_KEY`'ten üretilmiş, TEK örnek (singleton) çözücü.
 *
 * Neden tek örnek: `seedAccount()` yalnızca `Repos` alır, `createHarness`'ın
 * içindeki `cipher` değişkenine erişemez. Belirteci `cipher.seal(...)` ile
 * mühürlemek zorunda olduğu için çözücüyü buradan dışa açmak zorunlu.
 * `createHarness` da `config.masterKey` aynı değer olduğu için aynı anahtar
 * malzemesinden üretir → `seedAccount`'ın mühürlediği kutu motorca açılabilir.
 */
export const TEST_CIPHER = new AesGcmCipher(TEST_MASTER_KEY);

// ── Saat ───────────────────────────────────────────────────────────────────

/** Test saati. `advance()` YALNIZ ileri sarar (bkz. `test/services/helpers.ts`). */
export class MutableClock implements Clock {
  private t: number;
  constructor(start: number = Date.now()) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t);
  }
  get ms(): number {
    return this.t;
  }
  setMs(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ── Yapılandırma ───────────────────────────────────────────────────────────

/** Test yapılandırması. Varsayılan: parola + master key YOK (kör mod). */
export interface TestConfigOver {
  adminPassword?: string | null;
  masterKey?: string | null;
  publicBaseUrl?: string | null;
  ingestKeys?: string[];
  timezone?: string;
  logLevel?: AppConfig["logLevel"];
}

/**
 * Yapılandırmayı `loadConfig` ÜZERİNDEN üretir: elle `AppConfig` yazmak
 * alan listesini kopyalamak demek ve yeni bir alan eklendiğinde testin
 * sessizce eski kalmasına yol açar.
 */
export function testConfig(dir: string, over: TestConfigOver = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    SP_DATA_DIR: dir,
    SP_STORAGE_DIR: join(dir, "storage"),
    SP_DATABASE_FILE: join(dir, "data", "publisher.db"),
    SP_TIMEZONE: over.timezone ?? "Europe/Istanbul",
    SP_SCHEDULER_TICK_MS: "15000",
    // Log seviyesi `info`: sır sızıntısı testleri pino çıktısını AKTİF
    // akıştan okumak zorunda. `logsEnabled:false` yalnız gürültüyü keser,
    // bu yüzden ikisi de aynı anda kullanılmamalıdır.
    SP_LOG_LEVEL: over.logLevel ?? "info",
    ...(over.adminPassword === null ? {} : { SP_ADMIN_PASSWORD: over.adminPassword ?? "test-parola-1234" }),
    ...(over.masterKey === null ? {} : { SP_MASTER_KEY: over.masterKey ?? TEST_MASTER_KEY }),
    ...(over.publicBaseUrl === undefined ? {} : { SP_PUBLIC_BASE_URL: over.publicBaseUrl ?? "" }),
    ...(over.ingestKeys ? { SP_INGEST_KEYS: over.ingestKeys.join(",") } : {}),
  });
}

// ── Kurulum ────────────────────────────────────────────────────────────────

export interface HarnessOptions extends TestConfigOver {
  /** Adaptör verilmeyen platformlar: gerçek `MockPublishAdapter` takılmaz. */
  withoutAdapter?: Platform[];
  /** Yayın motoru kurulmasın mı? (`publish-now` "not_configured" senaryosu). */
  withoutPublisher?: boolean;
  /** Zamanlayıcı döngüsü KAPALI kalsın (test kendi tick'ini sürer). */
  startScheduler?: boolean;
  /** Adaptör senaryosu (ör. `{ fail: 2 }`). */
  mockScript?: ConstructorParameters<typeof MockPublishAdapter>[1];
}

export interface Harness {
  dir: string;
  config: AppConfig;
  db: Db;
  repos: Repos;
  store: FsMediaStore;
  clock: MutableClock;
  ffmpeg: ReturnType<typeof getFfmpegTools>;
  ingest: IngestService;
  adapters: Map<Platform, MockPublishAdapter>;
  publisher: PublishService | null;
  /**
   * Yayın motorunun kullandığı çözücü. `masterKey: null` koşumunda `null`.
   * `seedAccount`'ın mühürlediği belirteçler `TEST_CIPHER` ile üretildiği
   * için `config.masterKey` özelleştirilmediyse bu ikisi aynı anahtardır.
   */
  cipher: AesGcmCipher | null;
  schedulerCore: Scheduler | null;
  scheduler: SchedulerHandle | null;
  server: FastifyInstance;
  built: BuiltServer;
  /** İngest anahtarı (yoksa `null`). `X-Api-Key` testleri bunu kullanır. */
  apiKey: string | null;
  mediaSecret: string;
  /** pino çıktısını yakalamak için yazılabilir akış (sır sızıntısı testi). */
  logStream: PassThrough;
  /** Yakalanan log metni (`logStream` çıktısı biriktirilir). */
  logText(): string;
  /** `storage/` altına yazılabilir, güvenli anahtar. */
  putFile(key: string, body: Buffer): Promise<string>;
  /** Depoya dosya yazar, varlık kaydı açar (ingest'SİZ çıktı üretmek için). */
  seedAssetWithFile(key: string, body: Buffer, info: Parameters<Repos["assets"]["create"]>[0]["info"]): Promise<string>;
  /** Test sonunda sunucuyu/veritabanını/dizini kapatır ve siler. */
  close(): Promise<void>;
}

let harnessSeq = 0;

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  harnessSeq += 1;
  const dir = mkdtempSync(join(tmpdir(), `sp-http-${harnessSeq}-`));
  const config = testConfig(dir, opts);
  const db = openDatabase(config.databaseFile);
  applyMigrations(db, MIGRATIONS_DIR);
  const repos = buildRepos(db);

  const mediaSecret = config.masterKey ?? "sp-test-imza-sirri";
  const store = new FsMediaStore(config.storageDir, {
    publicBaseUrl: config.publicBaseUrl,
    secret: mediaSecret,
  });
  const ffmpeg = getFfmpegTools();
  const clock = new MutableClock();

  const adapters = new Map<Platform, MockPublishAdapter>();
  for (const platform of ["instagram", "tiktok", "youtube"] as Platform[]) {
    if (opts.withoutAdapter?.includes(platform)) continue;
    adapters.set(
      platform,
      new MockPublishAdapter(platform, opts.mockScript ?? {}, { now: () => clock.now().getTime() }),
    );
  }

  const ingest = new IngestService({
    projects: repos.projects,
    assets: repos.assets,
    contents: repos.contents,
    accounts: repos.accounts,
    jobs: repos.jobs,
    audit: repos.audit,
    store,
    probe: ffmpeg,
    transcoder: ffmpeg,
    getSpec,
    clock,
  });

  const cipher: AesGcmCipher | null = config.masterKey ? new AesGcmCipher(config.masterKey) : null;

  const publisher = opts.withoutPublisher
    ? null
    : new PublishService({
        jobs: repos.jobs,
        contents: repos.contents,
        assets: repos.assets,
        accounts: repos.accounts,
        credentials: repos.credentials,
        cipher,
        media: new StoreMediaRefResolver(store),
        adapters: adapters as ReadonlyMap<Platform, PublishAdapter>,
        store,
        audit: repos.audit,
        clock,
        leaseOwner: "test-http",
        transcoder: ffmpeg,
      });

  const schedulerCore = publisher
    ? new Scheduler(publisher, { tickMs: config.schedulerTickMs, limit: 20 })
    : null;
  const scheduler = schedulerCore
    ? wrapScheduler({ scheduler: schedulerCore, tickMs: config.schedulerTickMs })
    : null;

  const logStream = new PassThrough();
  const chunks: string[] = [];
  logStream.on("data", (c: Buffer | string) => {
    chunks.push(typeof c === "string" ? c : c.toString("utf8"));
  });

  const built = await buildServer({
    config,
    db,
    repos,
    store: store as HttpMediaStore,
    probe: ffmpeg,
    ingest,
    publisher,
    scheduler,
    clock,
    mediaSecret,
    logStream: logStream as unknown as Writable,
    logsEnabled: true,
    liveAdapters: new Set<Platform>(),
  });

  if (opts.startScheduler) scheduler?.start();

  const harness: Harness = {
    dir,
    config,
    db,
    repos,
    store,
    clock,
    ffmpeg,
    ingest,
    adapters,
    publisher,
    cipher,
    schedulerCore,
    scheduler,
    server: built.server,
    built,
    apiKey: null,
    mediaSecret,
    logStream,
    logText: () => chunks.join(""),
    async putFile(key, body) {
      const put = await store.put(key, body);
      return put.key;
    },
    async seedAssetWithFile(key, body, info) {
      await store.put(key, body);
      const asset = repos.assets.create({
        storageKey: key,
        originalName: "klip.mp4",
        bytes: body.length,
        mimeType: "video/mp4",
        info,
      });
      return asset.id;
    },
    async close() {
      scheduler?.stop();
      try {
        await built.server.close();
      } catch {
        /* zaten kapalı */
      }
      try {
        db.close();
      } catch {
        /* zaten kapalı */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };

  if (config.adminPassword) {
    const made = createApiKey(repos.apiKeys, { project: "test-projesi" });
    harness.apiKey = made.key;
  }
  return harness;
}

/** `Repos` üretir. `createDatabase` kullanılmaz: `openDatabase` + `applyMigrations`
 * ayrı ayrı çağrılır ki "migration uygulanmamış sunucu" senaryosu kurulabilsin. */
function buildRepos(db: Db): Repos {
  return createRepos(db);
}

// ── Yardımcılar ────────────────────────────────────────────────────────────

export interface SeedAccountOptions {
  /** Hesap durumu (`needs_reauth` / `disabled` senaryoları). */
  status?: "active" | "needs_reauth" | "disabled";
  /**
   * `credentials` kaydı açılsın mı? Varsayılan **true**.
   *
   * Neden varsayılan true: yayın motoru (`src/services/publisher.ts`) ön koşul
   * olarak `credentials.getByAccountId(account.id)` arar ve kayıt yoksa işi
   * `credential_missing` gerekçesiyle `defer()` eder — yani iş `queued`
   * kalır ve test "publish-now yayınlamıyor" diye kırılır. Hatanın gerçek
   * sebebi o an gerekçe satırında görünmez; bu yüzden kimlik kaydı zorunlu
   * tutulur ve `false` yalnızca O GEREKÇEYİ test etmek için verilir.
   */
  withCredential?: boolean;
  /** Düz metin belirteç (kutu `TEST_CIPHER` ile mühürlenir). */
  token?: string;
}

export interface SeededAccount {
  account: Account;
  /** Kimlik kaydının `account_id` değeri (yoksa `null`). */
  credentialId: string | null;
}

/**
 * **Yayına hazır** hesap açar: hesap kaydı + `credentials` kimlik kaydı.
 *
 * Yalnızca hesap açmak yetmez (yukarıdaki tuzak). Belirteç `TEST_CIPHER` ile
 * mühürlenir ki motorun `cipher.open(credential.accessTokenEnc)` çağrısı
 * `CredentialCipherError` fırlatıp işi `credential_unreadable` gerekçesine
 * düşürmesin.
 *
 * `tokenExpiresAt` **gelecekte** yazılır; `null` bırakılırsa "belirtecin
 * süresi bilinmiyor" durumu oluşur ve ürün kararı gereği yenileme beklenir.
 */
export function seedAccount(
  repos: Repos,
  platform: Platform,
  externalId = `ext-${platform}-1`,
  opts: SeedAccountOptions = {},
): SeededAccount {
  const account = repos.accounts.create({
    platform,
    externalId,
    displayName: `${platform} hesabı`,
    username: `${platform}-user`,
    status: opts.status ?? "active",
  });
  if (opts.withCredential === false) {
    return { account, credentialId: null };
  }
  const credential = repos.credentials.save({
    accountId: account.id,
    platform,
    accessTokenEnc: TEST_CIPHER.seal(opts.token ?? "test-token"),
    refreshTokenEnc: null,
    // Gelecek: `needsRefresh` yalnızca geçmişte kalan kayıtta true döner.
    tokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    scopes: ["publish"],
    providerUserId: account.externalId,
  });
  return { account, credentialId: credential.accountId };
}

/**
 * Test videosu üretir (kalıp `test/media/fixtures.ts`ten).
 *
 * Varsayılanlar üç doğrulanmış platform kuralını birden sağlar. Bunlardan biri
 * ihlal edilirse doğrulayıcı içeriği "geçersiz medya" sayar, içerik `draft`
 * kalır ve kuyruk hiç oluşmaz — yani test, niyetinden çok daha önce sessizce
 * yanlış yere düşer ve hata mesajı gerçek nedeni maskeler:
 *
 *   • `fps: 30`       → Instagram 23–60 fps ister. 15 fps reddedilir.
 *   • `seconds: 4`    → Instagram alt sınırı **3 saniye**. 1 sn reddedilir
 *                       (`duration_min: Süre 1 sn çok kısa`).
 *   • 1080×1920        → dikey 9:16; 1920×1080 yatay reddedilir.
 *
 * Bunlardan birini düşürmek isteyen test, `opts` ile **bilerek** geçmeli ve
 * `expect`'inde reddedilmeyi doğrulamalı.
 */
export function makeVideo(
  dir: string,
  name: string,
  opts: { width?: number; height?: number; seconds?: number; audio?: boolean } = {},
): string {
  const path = join(dir, name);
  encodeTestVideo(path, {
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
    seconds: opts.seconds ?? 4,
    withAudio: opts.audio ?? true,
    fps: 30,
    preset: "ultrafast",
  });
  return path;
}

/**
 * Multipart gövde. Fastify `inject()` içinde `FormData` kullanılabilir ama
 * `undici`'nin `FormData`'sı gövdeyi `Blob`a çevirirken dosyayı belleğe alır.
 * Testler küçük dosyalarda sorun yok; yine de elle kurmak, "hangi alanlar
 * gidiyor" sorusunu gizlemiyor.
 */
export function multipartBody(fields: Record<string, string>, filePath?: string): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----spTest${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  if (filePath) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${basename(filePath)}"\r\nContent-Type: video/mp4\r\n\r\n`,
        "utf8",
      ),
      readFileSync(filePath),
      Buffer.from("\r\n", "utf8"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

// ── Zarf okuma ─────────────────────────────────────────────────────────────

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/** Ham zarf. Yapı denetimi için; `data`/`error` opsiyoneldir. */
export function bodyOf<T = unknown>(raw: string): Envelope<T> {
  return JSON.parse(raw) as Envelope<T>;
}

/**
 * Başarılı yanıtın `data` alanını döndürür.
 *
 * Zarf `ok:true` değilse HATA FIRLATIR: test "200 döndü ama gövde bozuk"
 * durumunda `data?.x` yazıp sessizce geçmemelidir; zarf ihlali bir test
 * hatasıdır, yoksa konuşmazsak.
 */
export function dataOf<T>(raw: string): T {
  const body = bodyOf<T>(raw);
  if (body.ok !== true || body.data === undefined) {
    throw new Error(
      `başarılı zarf bekleniyordu, gelen: ${raw.slice(0, 300)}`,
    );
  }
  return body.data;
}

/** Hatalı yanıtın `error` alanını döndürür; `ok:true` ise hata fırlatır. */
export function errorOf(raw: string): { code: string; message: string; details?: unknown } {
  const body = bodyOf(raw);
  if (body.ok !== false || !body.error) {
    throw new Error(`hata zarfı bekleniyordu, gelen: ${raw.slice(0, 300)}`);
  }
  return body.error;
}