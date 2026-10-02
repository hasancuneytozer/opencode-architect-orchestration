-- 001_init — çekirdek şema.
--
-- Kurallar:
--   * Tarihler ISO-8601 TEXT (UTC). SQLite'ta tarih tipi yok; karşılaştırma
--     leksikografik ve UTC olduğu için doğru çalışır.
--   * JSON sütunları TEXT. Okuma tarafı `src/db/json.ts` yardımcılarıyla parse eder.
--   * CHECK kısıtları uygulama katmanının hatasını veritabanı katmanında yakalar.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  storage_key    TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes >= 0),
  mime_type      TEXT NOT NULL,
  info_json      TEXT NOT NULL DEFAULT '{}',
  findings_json  TEXT NOT NULL DEFAULT '[]',
  cover_key      TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id      TEXT NOT NULL REFERENCES assets(id)    ON DELETE RESTRICT,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','validating','ready','scheduled','published','partial','failed','canceled')),
  campaign      TEXT,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  copy_json     TEXT NOT NULL DEFAULT '{}',
  scheduled_at  TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contents_project   ON contents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_contents_state     ON contents(state);
CREATE INDEX IF NOT EXISTS ix_contents_scheduled ON contents(scheduled_at);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  external_id   TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  username      TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','needs_reauth','disabled')),
  label         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS ix_accounts_platform ON accounts(platform, status);

-- NOT: Bu tabloda düz metin token SAKLANMAZ. `*_enc` sütunları şifreli
-- metindir (base64); çözme/şifreleme `src/security` katmanındadır, bu pakette
-- değildir. Repository şemayı hazır eder, kriptografiye karışmaz.
CREATE TABLE IF NOT EXISTS credentials (
  account_id         TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  token_expires_at   TEXT,
  scopes_json        TEXT NOT NULL DEFAULT '[]',
  provider_user_id   TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id                TEXT PRIMARY KEY,
  content_id        TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),

  state             TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','preparing','uploading','processing','published','failed','canceled')),
  scheduled_at      TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  external_id       TEXT,
  remote_id         TEXT,
  permalink         TEXT,
  error             TEXT,

  -- Yeniden deneme zamanı epoch ms; zamanlayıcı bunu da sıraya katar.
  next_attempt_at   INTEGER,

  started_at        TEXT,
  finished_at       TEXT,

  -- Kuyruk kiralama (lease). Tek düğümde bile gerekli: süreç çöküp yeniden
  -- başladığında `lease_expires_at` geçmiş işler yeniden alınabilmeli.
  lease_owner       TEXT,
  lease_expires_at  TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Aynı içerik aynı hesaba iki kez kuyruğa giremez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_publish_jobs_target
  ON publish_jobs(content_id, platform, account_id);

-- Zamanlayıcının "sırası gelen işler" sorgusu için ZORUNLU birleşik indeks.
-- (state, scheduled_at) olmadan bu sorgu her tick'te tam tarama yapar.
CREATE INDEX IF NOT EXISTS ix_publish_jobs_state_scheduled
  ON publish_jobs(state, scheduled_at);

-- Süresi dolmuş kiralamaları bulmak için (crash recovery).
CREATE INDEX IF NOT EXISTS ix_publish_jobs_lease
  ON publish_jobs(state, lease_expires_at);

-- Uzaktan durum yoklaması (uploading/processing) için.
CREATE INDEX IF NOT EXISTS ix_publish_jobs_poll
  ON publish_jobs(state, updated_at);

-- Yayınlananları listelemek için.
CREATE INDEX IF NOT EXISTS ix_publish_jobs_remote
  ON publish_jobs(platform, remote_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_events(target_type, target_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_at     ON audit_events(at DESC);

-- Ham anahtar ASLA saklanmaz: yalnızca sha256 özeti ve gösterilebilir ön ek.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  digest        TEXT NOT NULL UNIQUE,
  scopes_json   TEXT NOT NULL DEFAULT '[]',
  project_name  TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_api_keys_prefix ON api_keys(prefix);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
