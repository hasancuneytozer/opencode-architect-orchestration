/**
 * Servis testleri için gerçek dünya kurulumu.
 *
 * KURAL: SAHTE REPOSITORY YAZILMAZ. Kuyruğun gerçekten atomik kiraladığını,
 * `attempts`'in gerçekten arttığını ve `next_attempt_at` ile yeniden denemenin
 * gerçekten çalıştığını kanıtlamak için `better-sqlite3` GERÇEK dosya
 * üzerinde, `FsMediaStore` GERÇEK geçici dizinde çalışır.
 *
 * Zaman `MutableClock` ile enjekte edilir. Depo `created_at`/`updated_at`
 * alanlarını GERÇEK saatle yazar (`nowIso()`); test saati gerçek saatten
 * İLERDE olduğu için `dueForPoll`'un `updated_at <= now` filtresi her zaman
 * doğru çalışır. Bu yüzden saat İLK DEĞERDE `Date.now()`'a sabitlenir ve
 * testlerde YALNIZ İLERİ sarılır.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { MIGRATIONS_DIR, createDatabase, type Db, type Repos } from "../../src/db/index.js";
import { FsMediaStore } from "../../src/media/index.js";
import { AesGcmCipher } from "../../src/security/cipher.js";
import {
  MockPublishAdapter,
  type MockPublishAdapterOptions,
  type MockScript,
} from "../../src/adapters/mock/publisher.js";
import {
  PublishService,
  StoreMediaRefResolver,
  type Clock,
  type PublishServiceOptions,
} from "../../src/services/publisher.js";
import { RetryablePublishError } from "../../src/ports/index.js";
import type {
  Account,
  ContentItem,
  MediaInfo,
  Platform,
  Project,
  PublishJob,
  QuietHours,
} from "../../src/contract/index.js";
import type {
  PollContext,
  PublishAdapter,
  PublishInput,
  TranscodePreset,
  TranscodeResult,
  Transcoder,
  UploadProgress,
  UploadSession,
} from "../../src/ports/index.js";

// ── Saat ───────────────────────────────────────────────────────────────────

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

  setIso(iso: string): void {
    this.t = Date.parse(iso);
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

// ── Adaptör kaydı ──────────────────────────────────────────────────────────

/**
 * Sahte adaptörün kaydı tutan hali. Motorun adaptöre DÜZ METİN belirteci
 * geçirdiğini, kapak baytlarını taşıdığını ve `scheduledAt`'ı ne zaman null
 * yaptığını gözlemlemek için gerekir.
 */
export class RecordingAdapter extends MockPublishAdapter {
  readonly starts: PublishInput[] = [];
  readonly polls: PollContext[] = [];
  readonly prechecks: PublishInput[] = [];

  constructor(platform: Platform, script: MockScript = {}, opts: MockPublishAdapterOptions = {}) {
    super(platform, script, opts);
  }

  override async startPublish(input: PublishInput) {
    this.starts.push(input);
    return super.startPublish(input);
  }

  override async pollPublish(ctx: PollContext) {
    this.polls.push(ctx);
    return super.pollPublish(ctx);
  }

  override async precheck(input: PublishInput) {
    this.prechecks.push(input);
    return super.precheck(input);
  }
}

// ── Parçalı yükleme sahte adaptörü ─────────────────────────────────────────

/**
 * `uploadParts` UYGULAYAN sahte adaptör.
 *
 * NEDEN `MockPublishAdapter` DEĞİL: `src/adapters/mock/**` bu iş paketinin
 * yazma yüzeyi dışında ve sahte adaptör `uploadParts` uygulamıyor. Motorun
 * yükleme döngüsü (oturum → `uploadParts` → kalıcı ilerleme → `processing`)
 * ancak bu sınıfla kanıtlanabilir.
 *
 * `plan` her çağrıda ne döneceğini belirler; `throwOn` hata yollarını, `null`
 * dönen `session` ise "motor oturumu yanlış taşıdı" senaryosunu üretir.
 */
export interface UploadScript {
  /** Her çağrıda kabul edilen parça sayısı. Varsayılan: hepsi (tek çağrıda biter). */
  partsPerCall?: number;
  /** Toplam parça. `null` (tanımı gereği) → motor `totalParts` bilmez. */
  totalParts?: number;
  /** Kaç çağrıdan sonra hata fırlatılsın (zaman aşımı senaryosu). */
  failAfterCalls?: number;
  /** Fırlatılacak hata. Varsayılan: `RetryablePublishError("network")`. */
  failWith?: Error;
  /** `true` ise `uploadParts` HİÇ uygulanmaz (desteklenmeyen adaptör). */
  unsupported?: boolean;
}

export interface RecordedUpload {
  input: PublishInput;
  session: UploadSession;
}

export class UploadingRecordingAdapter extends RecordingAdapter {
  /** Her `uploadParts` çağrısının GİRDİSİ — devam ofsetinin kanıtı. */
  readonly uploads: RecordedUpload[] = [];
  private uploadCalls = 0;

  constructor(
    platform: Platform,
    script: MockScript = {},
    opts: MockPublishAdapterOptions = {},
    private readonly upload: UploadScript = {},
  ) {
    super(platform, script, opts);
  }

  uploadParts(input: PublishInput, session: UploadSession): Promise<UploadProgress> {
    this.uploadCalls += 1;
    this.uploads.push({ input, session });

    if (this.upload.failAfterCalls !== undefined && this.uploadCalls > this.upload.failAfterCalls) {
      throw (
        this.upload.failWith ??
        new RetryablePublishError("Sahte yükleme zaman aşımı (ağ koptu).", "network")
      );
    }

    const total = this.upload.totalParts ?? null;
    const step = this.upload.partsPerCall ?? Number.POSITIVE_INFINITY;
    const uploadedParts = Math.min(
      total ?? Number.MAX_SAFE_INTEGER,
      session.uploadedParts + step,
    );
    const done = total === null ? true : uploadedParts >= total;
    return Promise.resolve({
      uploadedParts: done && total !== null ? total : uploadedParts,
      totalParts: total,
      done,
      nextOffset: done ? null : uploadedParts * 1000,
    });
  }
}

/**
 * `uploadParts` uygulanmayan adaptör. `delete` ile metot prototipinden
 * düşürülür: motor `typeof adapter.uploadParts === "function"` kontrolüyle
 * yeteneği yok sayar. TypeScript `implements` zorunluluğu için sınıf yine de
 * `PublishAdapter` sözlüğüne uyar.
 */
export class UnsupportedUploadAdapter extends RecordingAdapter {
  constructor(platform: Platform, script: MockScript = {}, opts: MockPublishAdapterOptions = {}) {
    super(platform, script, opts);
    delete (this as { uploadParts?: unknown }).uploadParts;
  }
}

// ── Transcoder sahtesi (ffmpeg yok) ────────────────────────────────────────

export interface FakeTranscodeOptions {
  withinLimits?: boolean;
  bytes?: number;
  throwOn?: "toFeedReady" | "grabCover" | null;
}

export class FakeTranscoder implements Transcoder {
  toFeedReadyCalls: Array<{ input: string; output: string }> = [];
  grabCoverCalls: Array<{ input: string; percent: number }> = [];

  constructor(private readonly opts: FakeTranscodeOptions = {}) {}

  async grabCover(input: string, atPercent: number): Promise<Buffer> {
    this.grabCoverCalls.push({ input, percent: atPercent });
    if (this.opts.throwOn === "grabCover") throw new Error("kapak çıkarılamadı");
    return Buffer.from(`kapak-${atPercent}`);
  }

  async toFeedReady(input: string, output: string, preset: TranscodePreset): Promise<TranscodeResult> {
    this.toFeedReadyCalls.push({ input, output });
    if (this.opts.throwOn === "toFeedReady") throw new Error("ffmpeg patladı");
    // Gerçek dosya yazılır: sonraki okumalar (cover, bytes) tutarlı olsun.
    writeFileSync(output, Buffer.alloc(32, 7));
    const bytes = this.opts.bytes ?? 1_024;
    return {
      bytes,
      info: sampleInfo({ path: output, bytes }),
      withinLimits: this.opts.withinLimits ?? true,
    };
  }
}

// ── Armatür ────────────────────────────────────────────────────────────────

export interface FixtureOptions {
  script?: MockScript;
  /** Adaptör verilmeyen platformlar buraya yazılır (null = adaptör yok). */
  withoutAdapter?: Platform[];
  /** cipher: null senaryosu için false. */
  withCipher?: boolean;
  transcoder?: Transcoder | null;
  service?: PublishServiceOptions;
  /**
   * `uploadParts` UYGULAYAN sahte adaptörün davranışı.
   * Verilmezse adaptörler `uploadParts` UYGULAMAZ (mock sözleşmesi) — motorun
   * "bayt gönderen yok" yolunu ölçmek isteyen testler varsayılan olarak tam da
   * bu durumdadır ve `UnsupportedUploadAdapter` kullanırlar.
   */
  upload?: UploadScript;
  /** `uploadParts` uygulanmayan adaptör sınıfı kullanılsın mı. */
  unsupportedUpload?: boolean;
}

export interface Fixture {
  dir: string;
  db: Db;
  repos: Repos;
  store: FsMediaStore;
  cipher: AesGcmCipher | null;
  clock: MutableClock;
  adapters: Map<Platform, RecordingAdapter>;
  service: PublishService;
  /** Aynı bağımlılıklarla yeni servis (seçenek değiştirmek için). */
  withService(opts: PublishServiceOptions): PublishService;
  cleanup(): void;
}

export function createFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "sp-engine-"));
  const { db, repos } = createDatabase(join(dir, "publisher.db"), { migrationsDir: MIGRATIONS_DIR });
  const store = new FsMediaStore(join(dir, "storage"), {
    publicBaseUrl: null,
    secret: "test-imza-sirri-123456",
  });
  const cipher = opts.withCipher === false ? null : new AesGcmCipher(randomBytes(32).toString("base64"));
  const clock = new MutableClock();

  const platforms: Platform[] = ["instagram", "tiktok", "youtube"];
  const adapters = new Map<Platform, RecordingAdapter>();
  const nowMs = (): number => clock.now().getTime();
  for (const platform of platforms) {
    if (opts.withoutAdapter?.includes(platform)) continue;
    if (opts.upload !== undefined) {
      adapters.set(
        platform,
        new UploadingRecordingAdapter(platform, opts.script ?? {}, { now: nowMs }, opts.upload),
      );
      continue;
    }
    if (opts.unsupportedUpload === true) {
      adapters.set(platform, new UnsupportedUploadAdapter(platform, opts.script ?? {}, { now: nowMs }));
      continue;
    }
    adapters.set(platform, new RecordingAdapter(platform, opts.script ?? {}, { now: nowMs }));
  }

  const deps = {
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
    leaseOwner: "test-worker-1",
    transcoder: opts.transcoder ?? null,
  };

  // Testlerde bekleme süreleri kısa ve deterministik: jitter yok, taban 1 sn.
  const serviceOptions: PublishServiceOptions = {
    leaseMs: 60_000,
    pollIntervalMs: 0,
    random: () => 0.5,
    retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 5_000, jitter: 0 },
    ...opts.service,
  };

  return {
    dir,
    db,
    repos,
    store,
    cipher,
    clock,
    adapters,
    service: new PublishService(deps, serviceOptions),
    withService: (extra: PublishServiceOptions) =>
      new PublishService(deps, { ...serviceOptions, ...extra }),
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

// ── Veri üretimi ───────────────────────────────────────────────────────────

export function sampleInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "klasor/klip.mp4",
    bytes: 1_234,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 12,
    bitrate: 4_000_000,
    hasAudio: true,
    ...over,
  };
}

export interface SeedOptions {
  platform?: Platform;
  /** Varsayılan: saatin 1 saniye öncesi (yani "sırası gelmiş" iş). */
  scheduledAt?: string;
  requiresApproval?: boolean;
  approvedAt?: string | null;
  quietHours?: QuietHours | null;
  timezone?: string;
  accountStatus?: Account["status"];
  withCredential?: boolean;
  /** Token düz metni; varsayılan "test-token". */
  token?: string;
  withFile?: boolean;
  withCover?: boolean;
  info?: Partial<MediaInfo>;
  /** Key'i bozuk yaz: şifre çözülemez senaryosu. */
  brokenToken?: boolean;
}

export interface Seeded {
  project: Project;
  asset: AssetRow;
  content: ContentItem;
  account: Account;
  job: PublishJob;
  storageKey: string;
}

type AssetRow = ReturnType<Repos["assets"]["getById"]> extends infer T
  ? NonNullable<T>
  : never;

let seedCounter = 0;

export function seedScenario(fx: Fixture, opts: SeedOptions = {}): Seeded {
  seedCounter += 1;
  const n = seedCounter;
  const platform = opts.platform ?? "instagram";
  const key = `klip/${platform}-${n}.mp4`;
  const scheduledAt = opts.scheduledAt ?? new Date(fx.clock.ms - 1_000).toISOString();

  const bytes = 2_048;
  const info = sampleInfo({ path: key, bytes, ...opts.info });

  if (opts.withFile !== false) {
    writeFileSync(fx.store.pathFor(key), Buffer.alloc(bytes, 3));
  }

  const project = fx.repos.projects.create({ name: `proje-${n}`, notes: null });
  const asset = fx.repos.assets.create({
    projectId: project.id,
    storageKey: key,
    originalName: `klip-${n}.mp4`,
    bytes,
    mimeType: "video/mp4",
    info,
    coverKey: null,
  });

  if (opts.withCover) {
    const coverKey = `kapak/${platform}-${n}.jpg`;
    writeFileSync(fx.store.pathFor(coverKey), Buffer.from("jpeg-icerik"));
    fx.repos.assets.setCoverKey(asset.id, coverKey);
  }

  const content = fx.repos.contents.create({
    projectId: project.id,
    assetId: asset.id,
    state: "ready",
    scheduledAt,
    timezone: opts.timezone ?? "Europe/Istanbul",
    quietHours: opts.quietHours ?? null,
    copy: { [platform]: { caption: "test altyazisi", hashtags: ["test"] } },
    requiresApproval: opts.requiresApproval ?? false,
    approvedAt: opts.approvedAt ?? (opts.requiresApproval ? null : "2030-01-01T00:00:00.000Z"),
    approvedBy: opts.approvedAt ?? (opts.requiresApproval ? null : "tester"),
  });

  const account = fx.repos.accounts.create({
    platform,
    externalId: `${platform}-ext-${n}`,
    displayName: `Hesap ${n}`,
    username: `hesap${n}`,
    status: opts.accountStatus ?? "active",
  });

  if (opts.withCredential !== false) {
    const token = opts.token ?? "test-token";
    fx.repos.credentials.save({
      accountId: account.id,
      platform,
      // Cipher yoksa da kayıt kurulur: motorun "kimlik kaydı yok" ile
      // "şifre çözücü yok" gerekçelerini AYRI test edebilmek için gerekir.
      // Bozuk kutu senaryosu: geçerli biçimde görünür ama açılamaz.
      accessTokenEnc:
        opts.brokenToken || !fx.cipher
          ? "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAA"
          : fx.cipher.seal(token),
      scopes: ["publish"],
      providerUserId: account.externalId,
    });
  }

  const job = fx.repos.jobs.create({
    contentId: content.id,
    platform,
    accountId: account.id,
    scheduledAt,
    idempotencyKey: `job:${platform}:${n}`,
  });

  const freshAsset = fx.repos.assets.getById(asset.id);
  return {
    project,
    asset: freshAsset as AssetRow,
    content: fx.repos.contents.getById(content.id) as ContentItem,
    account,
    job,
    storageKey: key,
  };
}

/** İşin tick sonrası hâli (kısaltmalı okuma). */
export function jobOf(fx: Fixture, id: string): PublishJob {
  const job = fx.repos.jobs.getById(id);
  if (!job) throw new Error(`iş bulunamadı: ${id}`);
  return job;
}

export function adapterOf(fx: Fixture, platform: Platform): RecordingAdapter {
  const adapter = fx.adapters.get(platform);
  if (!adapter) throw new Error(`adaptör yok: ${platform}`);
  return adapter;
}

/** `uploadParts` çağrılarının kaydı; sıralı ve kopyalanmış. */
export function uploadsOf(fx: Fixture, platform: Platform): RecordedUpload[] {
  const adapter = fx.adapters.get(platform);
  const uploads = (adapter as { uploads?: RecordedUpload[] } | undefined)?.uploads;
  if (!uploads) throw new Error(`adaptör uploadParts uygulamıyor: ${platform}`);
  return [...uploads];
}

/** Denetim kayıtlarının eylemleri (yeni→eski DEĞİL, kayıt sırası). */
export function auditActions(fx: Fixture, jobId: string): string[] {
  return fx.repos.audit
    .listForTarget("publish_job", jobId)
    .map((r) => r.action)
    .reverse();
}
