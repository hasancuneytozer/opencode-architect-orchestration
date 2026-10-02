/**
 * Yapılandırma yükleyicisi.
 *
 * Tasarım kararı: eksik alanlar ZORUNLU sayılmaz, tek bir Türkçe hata fırlatılır.
 * Dağıtık sistemlerde "yarım yapılandırılmış" sessiz bir hata üretmekten
 * kötüdür; ya doğru çalışır ya da çalışma başlamadan açıkça konuşur.
 *
 * Burada yalnızca veri şekli ve okuma mantığı vardır; dosya yazma yoktur.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { APP_ROOT, resolveDataDir, resolveAppPath } from "./paths.js";

/** `app/` kökü; `.env` ve `.env.example` burada aranır. */
export const APP_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = APP_ROOT;
export const ENV_EXAMPLE_PATH = join(APP_ROOT, ".env.example");

/** Boş string'i undefined yapan yardımcı: `SP_FOO=` ile `SP_FOO` aynıdır. */
const emptyToUndef = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
};

const optionalString = z.preprocess(emptyToUndef, z.string().min(1).optional());
/**
 * `.env.example` sayıları tırnaklı/alt çizgili yazabiliyor:
 * `SP_SCHEDULER_TICK_MS=15_000`. Alt çizgiyi temizliyoruz.
 */
const intFromEnv = (min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.replaceAll("_", "").trim() : v),
    z.coerce.number().int().min(min).max(max),
  );

const boolFromEnv = (def: boolean) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      return s; // geçersizse zod'a düşsün, hata mesajı doğru olsun
    },
    z.boolean(),
  );

const RAW_SCHEMA = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: intFromEnv(1, 65535).default(4317),

  SP_DATA_DIR: optionalString,
  SP_STORAGE_DIR: optionalString,
  SP_DATABASE_FILE: optionalString,

  SP_MASTER_KEY: optionalString,
  SP_ADMIN_PASSWORD: optionalString,
  SP_INGEST_KEYS: optionalString,

  SP_PUBLIC_BASE_URL: optionalString,
  SP_ALLOW_PRIVATE_MEDIA_URL: boolFromEnv(false),

  SP_META_APP_ID: optionalString,
  SP_META_APP_SECRET: optionalString,
  SP_META_REDIRECT_URI: optionalString,
  SP_TIKTOK_CLIENT_KEY: optionalString,
  SP_TIKTOK_CLIENT_SECRET: optionalString,
  SP_TIKTOK_REDIRECT_URI: optionalString,
  SP_GOOGLE_CLIENT_ID: optionalString,
  SP_GOOGLE_CLIENT_SECRET: optionalString,
  SP_GOOGLE_REDIRECT_URI: optionalString,

  SP_PUBLISH_CONCURRENCY: intFromEnv(1, 20).default(1),
  SP_SCHEDULER_TICK_MS: intFromEnv(250, 3_600_000).default(15_000),
  SP_TIMEZONE: optionalString,
  SP_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type RawEnv = z.input<typeof RAW_SCHEMA>;

/** Uygulamanın kullandığı, yolları mutlaklaştırılmış yapılandırma. */
export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  isTest: boolean;
  host: string;
  port: number;

  dataDir: string;
  storageDir: string;
  databaseFile: string;

  /** `SP_PUBLIC_BASE_URL`; verilmediyse null. */
  publicBaseUrl: string | null;
  /** Anahtar yoksa uygulama mock (sahte) modunda çalışır. */
  masterKey: string | null;
  adminPassword: string | null;
  /** Virgülle ayrılmış ham ingest anahtarları; özet karşılaştırması için. */
  ingestKeys: string[];

  publishConcurrency: number;
  schedulerTickMs: number;
  timezone: string;
  allowPrivateMediaUrl: boolean;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

  meta: { appId: string | null; appSecret: string | null; redirectUri: string | null };
  tiktok: { clientKey: string | null; clientSecret: string | null; redirectUri: string | null };
  youtube: { clientId: string | null; clientSecret: string | null; redirectUri: string | null };

  /** masterKey yoksa true: gerçek yayın yapılmaz. */
  mockMode: boolean;
}

/**
 * Zorunlu alanlar.
 *
 * KURAL: zorlama YALNIZCA üretimde (`production`) geçerlidir. Geliştirme ve
 * testte eksik `SP_MASTER_KEY` bir arıza değil, açık bir KÖR MODdur
 * (`AppConfig.mockMode`): gerçek yayın yapılmaz, veri katmanı ve testler
 * `.env` olmadan koşabilir. Aynı sebeple parola da üretimde zorunludur;
 * geliştirmede arayüz oturumu açılmaz.
 *
 * Üretimde "yarım yapılandırılmış" sessiz bir hata üretmekten kötüdür: ya doğru
 * çalışır ya da çalışmadan önce açıkça konuşur.
 */
function requiredKeys(nodeEnv: string): Array<[keyof RawEnv, string, string]> {
  if (nodeEnv !== "production") return [];
  return [
    [
      "SP_MASTER_KEY",
      "32 baytlık base64 anahtar",
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    ],
    ["SP_ADMIN_PASSWORD", "arayüz oturumu için parola", "elle seçin, en az 12 karakter"],
  ];
}

function buildMissingMessage(missing: Array<[string, string, string]>): string {
  const lines = missing.map(([key, desc, how]) => `  • ${key} — ${desc}\n      üretmek için: ${how}`);
  return [
    `Yapılandırma eksik. ${missing.length} zorunlu alan doldurulmamış:`,
    ...lines,
    "",
    "Tam liste ve açıklamalar için .env.example dosyasına bakın.",
    "Dosyayı oluşturmak için:  cp .env.example .env  (Windows: copy .env.example .env)",
  ].join("\n");
}

/** `.env` dosyasını okur; yoksa boş nesne döner. Hata fırlatmaz. */
export function readEnvFile(file = join(APP_ROOT, ".env")): Record<string, string> {
  try {
    return loadDotenv({ path: file, override: false, quiet: true }) as unknown as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

/**
 * Ham ortam değişkenlerinden yapılandırma üretir.
 * `SP_` önekli alanlar zorunlu değildir; eksik olanlar varsayılır.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = RAW_SCHEMA.safeParse(env);
  if (!raw.success) {
    const issues = raw.error.issues
      .map((i) => `  • ${i.path.join(".") || "(kök)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Yapılandırma geçersiz:\n${issues}`);
  }
  const e = raw.data;
  const nodeEnv = e.NODE_ENV;

  const missing = requiredKeys(nodeEnv).filter(([k]) => !e[k]);
  if (missing.length > 0) {
    throw new Error(
      buildMissingMessage(missing.map(([k, d, h]) => [String(k), d, h]) as [string, string, string][]),
    );
  }

  // ── Yollar: hepsi `app/` köküne göre mutlak ──────────────────────────────
  const dataDir = resolveDataDir(e.SP_DATA_DIR ?? "./data", APP_ROOT);
  const storageDir = resolveDataDir(e.SP_STORAGE_DIR ?? "./storage", APP_ROOT);
  const databaseFile = resolveAppPath(e.SP_DATABASE_FILE ?? "./data/publisher.db", APP_ROOT);
  // Veritabanı dosyasının üst klasörü de var olmalı.
  resolveDataDir(dirname(databaseFile), APP_ROOT);

  const masterKey = e.SP_MASTER_KEY ?? null;
  const publicBaseUrl = e.SP_PUBLIC_BASE_URL
    ? e.SP_PUBLIC_BASE_URL.replace(/\/+$/, "")
    : null;

  return {
    nodeEnv,
    isTest: nodeEnv === "test",
    host: e.HOST,
    port: e.PORT,

    dataDir,
    storageDir,
    databaseFile,

    publicBaseUrl,
    masterKey,
    adminPassword: e.SP_ADMIN_PASSWORD ?? null,
    ingestKeys: (e.SP_INGEST_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),

    publishConcurrency: e.SP_PUBLISH_CONCURRENCY,
    schedulerTickMs: e.SP_SCHEDULER_TICK_MS,
    timezone: e.SP_TIMEZONE ?? "Europe/Istanbul",
    allowPrivateMediaUrl: e.SP_ALLOW_PRIVATE_MEDIA_URL,
    logLevel: e.SP_LOG_LEVEL,

    meta: {
      appId: e.SP_META_APP_ID ?? null,
      appSecret: e.SP_META_APP_SECRET ?? null,
      redirectUri: e.SP_META_REDIRECT_URI ?? null,
    },
    tiktok: {
      clientKey: e.SP_TIKTOK_CLIENT_KEY ?? null,
      clientSecret: e.SP_TIKTOK_CLIENT_SECRET ?? null,
      redirectUri: e.SP_TIKTOK_REDIRECT_URI ?? null,
    },
    youtube: {
      clientId: e.SP_GOOGLE_CLIENT_ID ?? null,
      clientSecret: e.SP_GOOGLE_CLIENT_SECRET ?? null,
      redirectUri: e.SP_GOOGLE_REDIRECT_URI ?? null,
    },

    mockMode: masterKey === null,
  };
}

/**
 * Uygulama başlangıcı için tam yükleyici: `.env` dosyasını okur, süreç
 * ortamına dokunmadan yapılandırmayı üretir. `.env` yoksa hata vermez.
 */
export function loadConfigFromDisk(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const merged: Record<string, string> = { ...readEnvFile() };
  // Açık süreç ortamı `.env`'i ezmelidir (container/CI genelde öyle verir).
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v !== "") merged[k] = v;
  return loadConfig(merged);
}

/** `.env.example` içindeki `SP_` anahtarları — kayıp alan tespiti için. */
export function envExampleKeys(): string[] {
  try {
    const text = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const keys = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(SP_[A-Z0-9_]+)\s*=/.exec(line);
      if (m?.[1]) keys.add(m[1]);
    }
    return [...keys];
  } catch {
    return [];
  }
}

export { APP_ROOT, ensureDataDir, resolveAppPath, resolveDataDir } from "./paths.js";
