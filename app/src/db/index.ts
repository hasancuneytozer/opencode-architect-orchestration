/**
 * Veri katmanının giriş noktası.
 *
 * `createDatabase` tek giriştir: bağlantıyı açar, PRAGMA'ları uygular,
 * migration'ları çalıştırır ve tüm repository'leri hazırlar.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, openDatabase } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import { AccountRepo } from "./repos/accounts.js";
import { ApiKeyRepo } from "./repos/apiKeys.js";
import { AssetRepo } from "./repos/assets.js";
import { AuditRepo } from "./repos/audit.js";
import { ContentRepo } from "./repos/contents.js";
import { CredentialRepo } from "./repos/credentials.js";
import { MetricsRepo } from "./repos/metrics.js";
import { ProjectRepo } from "./repos/projects.js";
import { PublishJobRepo } from "./repos/publishJobs.js";
import { SettingsRepo } from "./repos/settings.js";

/** `migrations/` dizini. `src/db/index.ts`ten iki seviye yukarı: `app/migrations`. */
export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

export interface Repos {
  projects: ProjectRepo;
  assets: AssetRepo;
  contents: ContentRepo;
  accounts: AccountRepo;
  credentials: CredentialRepo;
  jobs: PublishJobRepo;
  metrics: MetricsRepo;
  audit: AuditRepo;
  apiKeys: ApiKeyRepo;
  settings: SettingsRepo;
}

export function createRepos(db: Db): Repos {
  return {
    projects: new ProjectRepo(db),
    assets: new AssetRepo(db),
    contents: new ContentRepo(db),
    accounts: new AccountRepo(db),
    credentials: new CredentialRepo(db),
    jobs: new PublishJobRepo(db),
    metrics: new MetricsRepo(db),
    audit: new AuditRepo(db),
    apiKeys: new ApiKeyRepo(db),
    settings: new SettingsRepo(db),
  };
}

export interface CreateDatabaseOptions {
  migrationsDir?: string;
  /** false ise migration çalıştırılmaz (salt-okunur testler). */
  migrate?: boolean;
}

/** Bağlantı + migration + repository'ler. */
export function createDatabase(file: string, opts: CreateDatabaseOptions = {}): {
  db: Db;
  repos: Repos;
} {
  const db = openDatabase(file);
  if (opts.migrate !== false) {
    applyMigrations(db, opts.migrationsDir ?? MIGRATIONS_DIR);
  }
  return { db, repos: createRepos(db) };
}

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageOffset, pageSize } from "./paging.js";

export { openDatabase, applyPragmas, PRAGMAS } from "./connection.js";
export type { Db } from "./connection.js";
export {
  applyMigrations,
  appliedVersions,
  checksumOf,
  loadMigrations,
} from "./migrate.js";
export type { MigrationFile, ApplyResult } from "./migrate.js";

export { ProjectRepo } from "./repos/projects.js";
export { AssetRepo } from "./repos/assets.js";
export { ContentRepo, DEFAULT_AI_DISCLOSURE } from "./repos/contents.js";
export { AccountRepo } from "./repos/accounts.js";
export { CredentialRepo } from "./repos/credentials.js";
export { PublishJobRepo, LEASED_STATES } from "./repos/publishJobs.js";
export { MetricsRepo } from "./repos/metrics.js";
export { AuditRepo } from "./repos/audit.js";
export { ApiKeyRepo, digestKey, keyPrefix } from "./repos/apiKeys.js";
export { SettingsRepo } from "./repos/settings.js";

export type { CreateJobInput, JobPatch, ClaimOptions, JobListFilter } from "./repos/publishJobs.js";
export type {
  ContentMetricRecord,
  MeasurableJob,
  MetricListFilter,
  UpsertMetricInput,
} from "./repos/metrics.js";
export type { ContentListFilter } from "./repos/contents.js";
export type { AssetListFilter } from "./repos/assets.js";

export type { Project } from "../contract/index.js";
export type { Asset } from "../contract/index.js";
export type { ContentItem } from "../contract/index.js";
export type { Account } from "../contract/index.js";
export type { PublishJob, PublishFailure, JobState } from "../contract/index.js";
