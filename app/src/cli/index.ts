/**
 * KOMUT SATIRI ARAYÜZÜ — `npm run sp -- <komut>`.
 *
 * ── TASARIM KARARI: SAF ÇALIŞTIRMA, SÜREÇ YOK ─────────────────────────────────
 * `runCli(argv, deps)` bir SAYI döndürür ve süreci KENDİSİ kapatmaz. Bu iki
 * şeyi birbirinden ayırmak:
 *   1) Test gerçek komutu, gerçek dosyayla, gerçek veritabanıyla çalıştırabilir
 *      (`subprocess` yerine doğrudan çağrı; hızlı ve stack izlenebilir).
 *   2) `--json` çıktısının arkasına başka bir şey karışmaz; süreç kodu ayrı bir
 *      katmanda (`main()`) belirlenir.
 *
 * ── HATA SÖZLEŞMESİ ──────────────────────────────────────────────────────────
 *   * Başarı → 0, hata → 1. Başka kodlar kullanılmaz (betikler bunu okur).
 *   * Hata mesajı `stderr`'e, TEK satır, insan dili.
 *   * **Stack trace ASLA basılmaz.** Yığın izi kullanıcının düzelteceği bir şeyi
 *     söylemez; gürültüdür. `--verbose` ile ayrıntı açılır.
 *   * `--json` verilmişse hata da JSON olarak basılır: makine okuyan çağıran
 *     metni ayrıştırmak zorunda kalmaz.
 *
 * ── YIKICI KOMUTLAR ─────────────────────────────────────────────────────────
 * `db:reset` onay ister (`--yes` vermedikçe `stdin`'den "evet" bekler). Bu
 * tek istisnadır: geri alınamaz bir işlem sessizce yapılırsa kullanıcı verisini
 * kaybetmiş olur ve bunu fark etmez.
 */
import { createReadStream, existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  PLATFORMS,
  type Account,
  type ContentItem,
  type Platform,
  type PublishJob,
} from "../contract/index.js";
import type { AppConfig } from "../config/index.js";
import { createDatabase, type Db, type Repos } from "../db/index.js";
import { FsMediaStore, getFfmpegTools, getSpec } from "../media/index.js";
import { IngestService, IngestSourceError, IngestValidationError, createApiKey } from "../ingest/index.js";
import type { FfmpegProbe, Transcoder } from "../ports/index.js";
import { PublishService, Scheduler, StoreMediaRefResolver, systemClock } from "../services/index.js";
import type { Clock } from "../services/index.js";
import { buildSetupReport } from "../http/index.js";
import { MIGRATIONS_DIR, applyMigrations, openDatabase } from "../db/index.js";
import { createCipher } from "../security/cipher.js";
import { buildAdapterRegistry } from "./registry.js";
import { runMigrations } from "./migrate.js";

// ── Sözleşme ───────────────────────────────────────────────────────────────

/** CLI'nin ihtiyaç duyduğu bağımlılıklar. Testler sahte olanını verir. */
export interface CliDeps {
  config: AppConfig;
  db: Db;
  repos: Repos;
  store: FsMediaStore;
  probe: FfmpegProbe;
  transcoder: Transcoder;
  clock: Clock;
  /** Testler: log akışı. Varsayılan `console.error`. */
  log?: (line: string) => void;
  /** `db:reset` onayı için stdin okuma. Varsayılan `process.stdin`. */
  confirm?: (question: string) => Promise<string>;
}

export interface CliResult {
  code: 0 | 1;
  /** Kullanıcıya gösterilen metin (stdout). */
  out: string;
  /** Hata/uyarı metni (stderr). */
  err: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

// ── Argüman ayrıştırma ────────────────────────────────────────────────────

export interface ParsedArgs {
  /** Konumsal argümanlar (`api-key create <proje>` → ["create", "x"]). */
  positional: string[];
  /** `--ad=değer` ve `--ad değer`. */
  flags: Record<string, string>;
  /** `--bayrak` (değersiz). */
  switches: Set<string>;
}

const VALUE_FLAGS = new Set([
  "file",
  "project",
  "platforms",
  "caption",
  "hashtags",
  "at",
  "timezone",
  "url",
  "campaign",
  "limit",
  "state",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliUsageError(`--${body} bir değer istiyor.`);
      }
      flags[body] = next;
      i += 1;
      continue;
    }
    switches.add(body);
  }
  return { positional, flags, switches };
}

/**
 * `args.positional[i]` — `noUncheckedIndexedAccess` altında `string | undefined`
 * döner ve çağıranın her seferinde `!` yazması gerekirdi. Burada TEK yerde
 * "yoksa null" kuralı konur; çağıranlar zorunlu argümanı kendileri doğrular.
 */
export function positionalAt(args: ParsedArgs, index: number): string | undefined {
  const value = args.positional[index];
  return value === undefined || value === "" ? undefined : value;
}

/** Zorunlu konumsal argüman. Yoksa anlaşılır bir kullanım hatası verir. */
export function requirePositional(args: ParsedArgs, index: number, usage: string): string {
  const value = positionalAt(args, index);
  if (!value) throw new CliUsageError(`Kullanım: ${usage}`);
  return value;
}

// ── Çıktı biçimi ──────────────────────────────────────────────────────────

/** `--json` varsa makine okunur, yoksa insan okunur tablo. */
interface Output {
  json: boolean;
  verbose: boolean;
  lines: string[];
  errLines: string[];
}

function emit(out: Output, human: string, payload: unknown): void {
  if (out.json) out.lines.push(JSON.stringify(payload, null, 2));
  else out.lines.push(human);
}

/** Tablo başlığı + satırlar. Değer eksikse `-` (alan sayısı kaymasın). */
function table(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "-").length)),
  );
  const line = (cells: Array<string | number | null | undefined>): string =>
    cells
      .map((c, i) => String(c ?? "-").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// ── Komutlar ──────────────────────────────────────────────────────────────

export const HELP = `social-publish CLI — npm run sp -- <komut>

VERİTABANI
  migrate                        Şemayı günceller
  db:reset [--yes]               Veritabanını siler ve yeniden kurar (ONAY ister)
  setup check                    Eksik yapılandırma anahtarlarını listeler

İNGEST ANAHTARLARI
  api-key create <proje>         Yeni anahtar üretir (ham anahtar bir kez gösterilir)
  api-key list                   Anahtarları listeler
  api-key revoke <id>            Anahtarı iptal eder

HESAPLAR / İÇERİK / İŞLER
  accounts list                  Bağlı hesapları listeler
  content list [--state x]      İçerikleri listeler
  content show <id>              Tek içeriği ayrıntılı gösterir
  content approve <id>           Onaylar ve kuyruğa alır
  content publish-now <id>       Kuyruktaki işleri hemen çalıştırır
  jobs list [--state x]          Yayın işlerini listeler

ZAMLAYICI
  scheduler run                  Bir tick çalıştırır
  scheduler status               Zamanlayıcı durumunu gösterir

INGEST
  ingest --file <yol> --project <ad> [seçenekler]
      --platforms=ig,tt,yt       Hedef platformlar (varsayılan: instagram)
      --caption "metin"          Tüm platformlarda altyazı
      --hashtags a,b             Etiketler
      --at "2026-10-02T18:00"    Yayın zamanı (yerel, --timezone ile)
      --timezone=Europe/Istanbul Saat dilimi (varsayılan: config)
      --campaign <ad>            Kampanya etiketi
      --no-approval              Onay kapısını kapatır (autoSchedule=true)
      --url <adres>             --file yerine uzak adresten indirir

GENEL
  --json                         Makine okunur çıktı
  --verbose                      Ayrıntılı hata
  --help                         Bu metin`;

// ── Ana giriş ─────────────────────────────────────────────────────────────

/**
 * Komutu çalıştırır ve çıkış kodunu döndürür. SÜREÇ KAPANMAZ.
 *
 * `argv[0]` komut adı (`migrate`, `ingest`, ...). `--help`/`-h` ve komutsuz
 * çağrı yardım metni basar ve 0 döner: "komut yok" bir hata değil, kullanım
 * hatasıdır ve kullanıcıya ne yapacağını söyleyen metinle 0 dönmek doğrudur.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<CliResult> {
  const out: Output = {
    json: false,
    verbose: false,
    lines: [],
    errLines: [],
  };

  try {
    const parsed = parseArgs(argv);
    out.json = parsed.switches.has("json") || parsed.flags["json"] !== undefined;
    out.verbose = parsed.switches.has("verbose");

    if (parsed.switches.has("help") || parsed.switches.has("h")) {
      out.lines.push(HELP);
      return { code: 0, out: out.lines.join("\n"), err: "" };
    }

    const command = parsed.positional[0];
    if (!command) {
      out.errLines.push(HELP);
      return { code: 1, out: "", err: out.errLines.join("\n") };
    }

    await dispatch(command, parsed, deps, out);
    return { code: 0, out: out.lines.join("\n"), err: out.errLines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (out.json) {
      out.errLines.push(JSON.stringify({ ok: false, error: { message } }, null, 2));
    } else {
      out.errLines.push(`Hata: ${message}`);
      // Ayrıntı yalnız `--verbose` ile: kullanıcının görmesi gereken tek şey
      // "ne oldu"dur, "hangi satırda" değil.
      if (out.verbose && err instanceof Error && err.stack) {
        out.errLines.push(err.stack);
      }
    }
    return { code: 1, out: out.lines.join("\n"), err: out.errLines.join("\n") };
  }
}

async function dispatch(
  command: string,
  args: ParsedArgs,
  deps: CliDeps,
  out: Output,
): Promise<void> {
  const sub = positionalAt(args, 1);

  switch (command) {
    case "migrate":
      cmdMigrate(args, deps, out);
      return;

    case "db:reset":
      await cmdDbReset(args, deps, out);
      return;

    case "setup":
      requireSub(command, sub, ["check"]);
      cmdSetupCheck(args, deps, out);
      return;

    case "api-key":
      // `requireSub` DÜZENLENMİŞ alt komutu döndürür; `sub` hâlâ
      // `string | undefined` olduğu için doğrudan `sub` geçirilemez.
      cmdApiKey(requireSub(command, sub, ["create", "list", "revoke"]), args, deps, out);
      return;

    case "accounts":
      requireSub(command, sub, ["list"]);
      cmdAccountsList(args, deps, out);
      return;

    case "content":
      await cmdContent(requireSub(command, sub, ["list", "show", "approve", "publish-now"]), args, deps, out);
      return;

    case "jobs":
      requireSub(command, sub, ["list"]);
      cmdJobsList(args, deps, out);
      return;

    case "scheduler":
      await cmdScheduler(requireSub(command, sub, ["run", "status"]), args, deps, out);
      return;

    case "ingest":
      await cmdIngest(args, deps, out);
      return;

    default:
      throw new CliUsageError(`Bilinmeyen komut: "${command}". --help ile listeyi görün.`);
  }
}

function requireSub(command: string, sub: string | undefined, allowed: string[]): string {
  if (!sub) {
    throw new CliUsageError(
      `"${command}" için alt komut gerekli: ${allowed.join(" | ")}.`,
    );
  }
  if (!allowed.includes(sub)) {
    throw new CliUsageError(
      `"${command} ${sub}" geçerli değil. Seçenekler: ${allowed.join(" | ")}.`,
    );
  }
  return sub;
}

// ── migrate / db:reset ────────────────────────────────────────────────────

function cmdMigrate(args: ParsedArgs, deps: CliDeps, out: Output): void {
  const result = applyMigrations(deps.db, MIGRATIONS_DIR);
  emit(
    out,
    result.applied.length > 0
      ? `Uygulandı: ${result.applied.join(", ")}`
      : `Şema güncel (${result.skipped.length} migration zaten uygulanmış).`,
    { ok: true, ...result },
  );
}

async function cmdDbReset(args: ParsedArgs, deps: CliDeps, out: Output): Promise<void> {
  const file = deps.config.databaseFile;
  if (!args.switches.has("yes")) {
    const ask =
      deps.confirm ??
      ((q: string) =>
        new Promise<string>((res) => {
          process.stdout.write(`${q} [evet/hayir] `);
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (chunk: string) => res(String(chunk).trim()));
        }));
    const answer = (await ask(
      `TÜM veriler silinecek: ${file}\nBu işlem geri alınamaz. Devam?`,
    )).toLowerCase();
    if (!["evet", "e", "yes", "y"].includes(answer)) {
      throw new CliUsageError("Onaylanmadı; hiçbir şey silinmedi.");
    }
  }

  // WAL yan dosyaları bırakılırsa yeni veritabanı eski günlükten okuyabilir.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${file}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
  const fresh = openDatabase(file);
  const result = applyMigrations(fresh, MIGRATIONS_DIR);
  fresh.close();

  emit(
    out,
    `Veritabanı sıfırlandı ve ${result.applied.length} migration uygulandı: ${file}`,
    { ok: true, file, ...result },
  );
}

// ── setup check ───────────────────────────────────────────────────────────

function cmdSetupCheck(_args: ParsedArgs, deps: CliDeps, out: Output): void {
  const { liveAdapters } = buildAdapterRegistry(deps.config);
  const report = buildSetupReport({
    config: deps.config,
    accounts: deps.repos.accounts,
    liveAdapters,
  });
  const lines: string[] = [`Mod: ${report.mode}`];
  if (report.problems.length === 0) lines.push("Eksik yok.");
  for (const p of report.problems) {
    lines.push(`[${p.severity}] ${p.code}: ${p.message}`);
  }
  emit(out, lines.join("\n"), { ok: true, ...report });
}

// ── api-key ───────────────────────────────────────────────────────────────

function cmdApiKey(sub: string, args: ParsedArgs, deps: CliDeps, out: Output): void {
  const repo = deps.repos.apiKeys;

  if (sub === "create") {
    const project = requirePositional(args, 2, "api-key create <proje>");
    const made = createApiKey(repo, { project });
    // Ham anahtar YALNIZCA burada ve YALNIZCA bir kez basılır. Satır sonundaki
    // uyarı, ikinci kez aranmaya çalışanı durdurur.
    emit(
      out,
      [
        made.key,
        "",
        `id    : ${made.id}`,
        `ön ek : ${made.prefix}`,
        `proje : ${project}`,
        "",
        "Bu anahtar YALNIZCA şimdi gösterilir; veritabanında yalnızca özeti tutulur.",
      ].join("\n"),
      { ok: true, key: made.key, id: made.id, prefix: made.prefix, project },
    );
    return;
  }

  if (sub === "list") {
    const keys = repo.list(200);
    emit(
      out,
      keys.length === 0
        ? "Kayıtlı anahtar yok."
        : table(
            ["id", "ön ek", "proje", "son kullanım", "oluşturma"],
            keys.map((k) => [
              k.id,
              k.prefix,
              k.projectName ?? "-",
              k.lastUsedAt ?? "-",
              k.createdAt,
            ]),
          ),
      { ok: true, keys },
    );
    return;
  }

  // revoke
  const id = args.positional[2];
  if (!id) throw new CliUsageError("Kullanım: api-key revoke <id>");
  const changed = repo.revoke(id);
  if (!changed) {
    const found = repo.getById(id);
    throw new CliUsageError(
      found
        ? `Anahtar zaten iptal edilmiş: ${id}`
        : `Anahtar bulunamadı: ${id}`,
    );
  }
  emit(out, `Anahtar iptal edildi: ${id}`, { ok: true, id, revoked: true });
}

// ── accounts / content / jobs ─────────────────────────────────────────────

function cmdAccountsList(_args: ParsedArgs, deps: CliDeps, out: Output): void {
  const accounts = deps.repos.accounts.listByPlatform(undefined, 500);
  emit(
    out,
    accounts.length === 0
      ? "Bağlı hesap yok."
      : table(
          ["id", "platform", "durum", "görünen ad", "dış kimlik"],
          accounts.map((a: Account) => [a.id, a.platform, a.status, a.displayName, a.externalId]),
        ),
    { ok: true, accounts },
  );
}

function limitOf(args: ParsedArgs, fallback = 100): number {
  const raw = args.flags["limit"];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliUsageError(`--limit pozitif bir sayı olmalı (verilen: "${raw}").`);
  }
  return Math.floor(n);
}

// `publish-now` alt komutu `service.publishNow()` çağırır; bu yüzden `async`.
async function cmdContent(sub: string, args: ParsedArgs, deps: CliDeps, out: Output): Promise<void> {
  const repo = deps.repos.contents;

  if (sub === "list") {
    const state = args.flags["state"];
    const items = repo.listFiltered({
      limit: limitOf(args),
      ...(state === undefined ? {} : { state: state as ContentItem["state"] }),
    });
    emit(
      out,
      items.length === 0
        ? "İçerik yok."
        : table(
            ["id", "durum", "onay", "zaman", "kampanya"],
            items.map((c) => [
              c.id,
              c.state,
              c.approvedAt ? c.approvedAt : c.requiresApproval ? "bekliyor" : "gerekmiyor",
              c.scheduledAt ?? "-",
              c.campaign ?? "-",
            ]),
          ),
      { ok: true, items },
    );
    return;
  }

  const id = args.positional[2];
  if (!id) throw new CliUsageError(`Kullanım: content ${sub} <id>`);

  if (sub === "show") {
    const item = repo.getById(id);
    if (!item) throw new CliUsageError(`İçerik bulunamadı: ${id}`);
    const asset = deps.repos.assets.getById(item.assetId);
    const jobs = deps.repos.jobs.listByContent(id);
    emit(
      out,
      [
        `id            : ${item.id}`,
        `durum         : ${item.state}`,
        `proje         : ${item.projectId}`,
        `varlık        : ${item.assetId}${asset ? ` (${asset.originalName}, ${asset.bytes} bayt)` : ""}`,
        `zaman         : ${item.scheduledAt ?? "-"} (${item.timezone})`,
        `onay gerekli  : ${item.requiresApproval}`,
        `onay          : ${item.approvedAt ?? "-"}`,
        `kampanya      : ${item.campaign ?? "-"}`,
        `etiketler     : ${item.tags.length > 0 ? item.tags.join(", ") : "-"}`,
        `AI bildirimi  : ${JSON.stringify(item.aiDisclosure)}`,
        `işler         : ${jobs.length === 0 ? "-" : jobs.map((j) => `${j.platform}:${j.state}`).join(", ")}`,
        `bulgular      : ${(asset?.findings ?? []).map((f) => `${f.severity}:${f.code}`).join(", ") || "-"}`,
      ].join("\n"),
      { ok: true, content: item, asset, jobs, findings: asset?.findings ?? [] },
    );
    return;
  }

  if (sub === "approve") {
    if (!repo.getById(id)) throw new CliUsageError(`İçerik bulunamadı: ${id}`);
    repo.approve(id, "cli");
    const fresh = repo.getById(id);
    emit(
      out,
      `Onaylandı: ${id} (${fresh?.approvedAt ?? "?"})`,
      { ok: true, id, approvedAt: fresh?.approvedAt ?? null },
    );
    return;
  }

  // publish-now
  if (!repo.getById(id)) throw new CliUsageError(`İçerik bulunamadı: ${id}`);
  const jobs = deps.repos.jobs
    .listByContent(id)
    .filter((j: PublishJob) => j.state === "queued" || j.state === "failed");
  if (jobs.length === 0) {
    emit(out, `Çalıştırılacak iş yok (${id}).`, { ok: true, id, requested: 0, results: [] });
    return;
  }
  const service = buildPublisher(deps);
  const results = [];
  for (const job of jobs) results.push(await service.publishNow(job.id));
  emit(
    out,
    results
      .map((r) => `${r?.jobId ?? "?"}: ${r?.state ?? "?"}${r?.reason ? ` — ${r.reason}` : ""}`)
      .join("\n"),
    { ok: true, id, requested: jobs.length, results },
  );
}

function cmdJobsList(args: ParsedArgs, deps: CliDeps, out: Output): void {
  const state = args.flags["state"];
  const jobs = deps.repos.jobs.listFiltered({
    limit: limitOf(args),
    ...(state === undefined ? {} : { state: state as PublishJob["state"] }),
  });
  emit(
    out,
    jobs.length === 0
      ? "İş yok."
      : table(
          ["id", "platform", "durum", "zaman", "deneme", "permalink"],
          jobs.map((j) => [
            j.id,
            j.platform,
            j.state,
            j.scheduledAt,
            j.attempts,
            j.permalink ?? "-",
          ]),
        ),
    { ok: true, jobs },
  );
}

// ── scheduler ─────────────────────────────────────────────────────────────

async function cmdScheduler(sub: string, args: ParsedArgs, deps: CliDeps, out: Output): Promise<void> {
  const service = buildPublisher(deps);

  if (sub === "status") {
    const scheduler = new Scheduler(service, { tickMs: deps.config.schedulerTickMs });
    const status = { running: scheduler.isRunning, ticks: scheduler.ticks, skipped: scheduler.skipped };
    emit(out, `Çalışıyor: ${status.running}\nTick: ${status.ticks}\nAtlanan: ${status.skipped}`, {
      ok: true,
      ...status,
    });
    return;
  }

  // run
  const scheduler = new Scheduler(service, { tickMs: deps.config.schedulerTickMs });
  const result = await scheduler.runOnce();
  emit(
    out,
    [
      `Sıradaki iş : ${result.claimed}`,
      `Yayınlanan  : ${result.published}`,
      `Zamanlandı : ${result.scheduled}`,
      `Yeniden    : ${result.retried}`,
      `Başarısız  : ${result.failed}`,
      `Atlanan    : ${result.skipped}`,
    ].join("\n"),
    { ok: true, ...result },
  );
}

/** CLI için yayın motoru. Adaptör kaydı `registry.ts` ile AYNI. */
function buildPublisher(deps: CliDeps): PublishService {
  const { adapters } = buildAdapterRegistry(deps.config);
  return new PublishService({
    jobs: deps.repos.jobs,
    contents: deps.repos.contents,
    assets: deps.repos.assets,
    accounts: deps.repos.accounts,
    credentials: deps.repos.credentials,
    cipher: createCipher(deps.config.masterKey),
    media: new StoreMediaRefResolver(deps.store),
    adapters,
    store: deps.store,
    audit: deps.repos.audit,
    clock: deps.clock,
    leaseOwner: `cli-${process.pid}`,
    transcoder: deps.transcoder,
  });
}

// ── ingest ────────────────────────────────────────────────────────────────

async function cmdIngest(args: ParsedArgs, deps: CliDeps, out: Output): Promise<void> {
  const file = args.flags["file"];
  const url = args.flags["url"];
  if (!file && !url) {
    throw new CliUsageError("ingest için --file <yol> veya --url <adres> gerekli.");
  }
  if (file && url) {
    throw new CliUsageError("--file ve --url aynı anda verilemez.");
  }
  const project = args.flags["project"];
  if (!project) throw new CliUsageError("ingest için --project <ad> gerekli.");

  const platforms = parsePlatforms(args.flags["platforms"]);
  const service = new IngestService({
    projects: deps.repos.projects,
    assets: deps.repos.assets,
    contents: deps.repos.contents,
    accounts: deps.repos.accounts,
    jobs: deps.repos.jobs,
    audit: deps.repos.audit,
    store: deps.store,
    probe: deps.probe,
    transcoder: deps.transcoder,
    getSpec,
    clock: deps.clock,
  });

  // `sourcePath` sözleşmesi göreli gezinme reddeder; dosyayı mutlaklaştırıp
  // varlığını ÖNCE denetle ki "kaynak okunamadı" hatası içerik doğrulamasına
  // karışmasın.
  let source: { kind: "path"; path: string } | { kind: "url"; url: string };
  if (url) {
    source = { kind: "url", url };
  } else {
    const path = resolve(file as string);
    if (!existsSync(path)) {
      throw new CliUsageError(`Dosya bulunamadı: ${path}`);
    }
    source = { kind: "path", path };
  }

  const caption = args.flags["caption"];
  const hashtags = (args.flags["hashtags"] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
  const at = args.flags["at"];
  const timezone = args.flags["timezone"] ?? deps.config.timezone;
  const autoSchedule = args.switches.has("no-approval");

  const input = {
    project,
    platforms,
    timezone,
    campaign: args.flags["campaign"],
    tags: hashtags,
    ...(at === undefined ? {} : { scheduledAt: at }),
    ...(caption === undefined && hashtags.length === 0
      ? {}
      : {
          copy: Object.fromEntries(
            platforms.map((p) => [
              p,
              {
                ...(caption === undefined ? {} : { caption }),
                ...(hashtags.length === 0 ? {} : { hashtags }),
              },
            ]),
          ),
        }),
    autoSchedule,
  } as Parameters<IngestService["ingest"]>[0];

  try {
    const result = await service.ingest(input, source);
    emit(
      out,
      [
        `varlık    : ${result.assetId}`,
        `içerik    : ${result.contentId}`,
        `durum     : ${result.state}`,
        `onay gerek: ${result.requiresApproval ? "evet" : "hayır"}`,
        `işler     : ${result.jobIds.length > 0 ? result.jobIds.join(", ") : "-"}`,
        `bulgu     : ${result.findings.length}`,
        ...result.skipped.map((s) => `atlandı (${s.platform}): ${s.reason}`),
      ].join("\n"),
      { ok: true, ...result },
    );
  } catch (err) {
    // Ingest hataları kullanıcının düzeltebileceği hatalardır (dosya yok, geçersiz
    // tarih, doğrulanamayan medya). Bu yüzden mesajı olduğu gibi yukarı çıkarır,
    // ayrıca sarmalamaya gerek yoktur; `runCli` tek satır olarak basar.
    if (err instanceof IngestValidationError) {
      const lines = err.details.map((d) => `  ${d.path}: ${d.message}`);
      throw new CliUsageError(
        lines.length > 0 ? `${err.message}\n${lines.join("\n")}` : err.message,
      );
    }
    if (err instanceof IngestSourceError) throw new CliUsageError(err.message);
    throw err;
  }
}

/** `--platforms=instagram,tiktok` ya da `ig,tt,yt`. Bilinmeyen → hata. */
export function parsePlatforms(raw: string | undefined): Platform[] {
  if (raw === undefined || raw.trim() === "") return ["instagram"];
  const alias: Record<string, Platform> = {
    ig: "instagram",
    instagram: "instagram",
    meta: "instagram",
    tt: "tiktok",
    tiktok: "tiktok",
    yt: "youtube",
    youtube: "youtube",
  };
  const out: Platform[] = [];
  for (const token of raw.split(",")) {
    const key = token.trim().toLowerCase();
    if (key === "") continue;
    const mapped = alias[key];
    if (!mapped) {
      throw new CliUsageError(
        `Bilinmeyen platform: "${token.trim()}". Geçerli: ${PLATFORMS.join(", ")} (ig, tt, yt de olur).`,
      );
    }
    if (!out.includes(mapped)) out.push(mapped);
  }
  if (out.length === 0) throw new CliUsageError("--platforms boş kalmış; en az bir platform seçin.");
  return out;
}

// ── Süreç girişi ──────────────────────────────────────────────────────────

/** Yalnız bu dosya bir giriş noktası olduğunda çalıştırılır. */
export function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return /[\\/]cli[\\/]index\.(ts|js|mjs|cjs)$/.test(entry);
}

/** Gerçek bağımlılıkları kurar ve CLI'yi süreçte çalıştırır. */
async function main(): Promise<void> {
  const { loadConfigFromDisk } = await import("../config/index.js");
  const config = loadConfigFromDisk();
  const { db, repos } = createDatabase(config.databaseFile, { migrationsDir: MIGRATIONS_DIR });
  const ffmpeg = getFfmpegTools();
  const store = new FsMediaStore(config.storageDir, {
    publicBaseUrl: config.publicBaseUrl,
    secret: config.masterKey ?? "sp-gelistirme-imza-sirri",
  });

  const deps: CliDeps = {
    config,
    db,
    repos,
    store,
    probe: ffmpeg,
    transcoder: ffmpeg,
    clock: systemClock,
  };

  const argv = process.argv.slice(2);
  try {
    const result = await runCli(argv, deps);
    if (result.out) process.stdout.write(`${result.out}\n`);
    if (result.err) process.stderr.write(`${result.err}\n`);
    process.exitCode = result.code;
  } finally {
    try {
      db.close();
    } catch {
      // Kapatma başarısızsa komut sonucu yine de döndü; sessizce geç.
    }
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `Hata: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}