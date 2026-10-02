-- 003_contract_v2 — sözleşme v2 alanları.
--
-- 001 ve 002'ye DOKUNULMAZ: yayınlanmış veritabanlarında checksum tutarsızlığı
-- oluşturur. Yeni ihtiyaç her zaman yeni dosyadır.
--
-- Bu migration şunu yapar:
--   * assets    → project_id, derived_from_asset_id, derived_for_platform
--   * contents  → quiet_hours_json, ai_disclosure_json, requires_approval,
--                 approved_by, approved_at, batch_id
--   * publish_jobs → idempotency_key (+UNIQUE), idempotency_first_used_at,
--                 upload_url, upload_url_expires_at, uploaded_parts, total_parts,
--                 lease_owner/lease_expires_at (INTEGER'a çevrilir),
--                 error → error_json (PublishFailure NESNESİ)
--   * publish_jobs.state CHECK kısıtı 'published_no_link' değerini kabul eder.
--
-- SQLite'ta CHECK kısıtı doğrudan değiştirilemez; bu yüzden publish_jobs tablosu
-- VERİ KORUYARAK yeniden kurulur (yeni tablo → kopyala → düşür → yeniden adlandır).
--
-- YABANCI ANAHTAR NOTU: SQLite, `PRAGMA foreign_keys = OFF`'ı transaction
-- içinde SESSİZCE yok sayar. Migration çalıştırıcı her migration'ı kendi
-- transaction'ında uygular, dolayısıyla burada `PRAGMA defer_foreign_keys = ON`
-- kullanılır: kısıtlar COMMIT'e kadar ertelenir, tabloyu düşürürken geçici
-- tutarsızlık kabul edilir ve COMMIT'te doğrulanır. Tabloyu hiçbir tablo
-- referans almadığı için (publish_jobs'a FK yok) bu güvenli bir prosedürdür.

-- ── assets ────────────────────────────────────────────────────────────────
-- project_id: varlık hangi AI projesinin çıktısı. Kaynak varlıkta NULL olabilir.
-- ON DELETE SET NULL: proje silinse bile varlık (ve üretilmiş türevleri) yaşar.
ALTER TABLE assets ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
-- derived_from_asset_id: transcoder çıktısının kaynağı. Platform başına kopya.
-- ON DELETE RESTRICT: türevi olan kaynak silinemez, aksi halde kopya havada kalır.
ALTER TABLE assets ADD COLUMN derived_from_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT;
ALTER TABLE assets ADD COLUMN derived_for_platform TEXT
  CHECK (derived_for_platform IS NULL
         OR derived_for_platform IN ('instagram','tiktok','youtube'));

CREATE INDEX IF NOT EXISTS ix_assets_project ON assets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_assets_derived ON assets(derived_from_asset_id);

-- ── contents ──────────────────────────────────────────────────────────────
ALTER TABLE contents ADD COLUMN quiet_hours_json TEXT;
ALTER TABLE contents ADD COLUMN ai_disclosure_json TEXT;
-- Reklam içeriği insan onayı olmadan yayına GİREMEZ; varsayılan 1 (güvenli).
ALTER TABLE contents ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 1
  CHECK (requires_approval IN (0,1));
ALTER TABLE contents ADD COLUMN approved_by TEXT;
ALTER TABLE contents ADD COLUMN approved_at TEXT;
ALTER TABLE contents ADD COLUMN batch_id TEXT;

CREATE INDEX IF NOT EXISTS ix_contents_batch ON contents(batch_id);
CREATE INDEX IF NOT EXISTS ix_contents_approval ON contents(requires_approval, state);

-- ── publish_jobs ───────────────────────────────────────────────────────────
PRAGMA defer_foreign_keys = ON;

CREATE TABLE publish_jobs_v2 (
  id                       TEXT PRIMARY KEY,
  content_id               TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  account_id               TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform                 TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),

  -- 'published_no_link': yayın TAMAM ama kalıcı permalink çözümlenemedi
  -- (TikTok SELF_ONLY). 'published' gibi başarılıdır ama ölçülemez.
  state                    TEXT NOT NULL DEFAULT 'queued'
                             CHECK (state IN ('queued','preparing','uploading','processing',
                                              'published','published_no_link','failed','canceled')),
  scheduled_at             TEXT NOT NULL,
  attempts                 INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- Mükerrer yayının son savunması: "kiralama doldu, işçi yeniden çalıştı"
  -- senaryosunda sunucuya gönderilen ANAHTAR aynı kalır. UNIQUE indeks şarttır.
  idempotency_key          TEXT NOT NULL,
  idempotency_first_used_at TEXT,

  external_id              TEXT,
  -- Meta resumable URI / TikTok upload_url. Sağlayıcı sözlüğünde 1 saat geçerli.
  upload_url               TEXT,
  upload_url_expires_at    TEXT,
  uploaded_parts           INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_parts >= 0),
  total_parts              INTEGER,

  remote_id                TEXT,
  permalink                TEXT,

  -- PublishFailure NESNESİ (JSON). Düz metin hata buraya YAZILMAZ.
  error_json               TEXT,

  -- Yeniden deneme zamanı: epoch ms.
  next_attempt_at          INTEGER,

  -- Kiralama (lease). Kalan süre artık INTEGER epoch ms; eski kayıtlar ISO
  -- metindi, aşağıdaki INSERT bunları sayıya çevirir.
  lease_owner              TEXT,
  lease_expires_at         INTEGER,

  started_at               TEXT,
  finished_at              TEXT,

  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- Eski satırlar: idempotency_key üretilemez (o sürümde alan yoktu), ama NULL
-- bırakılırsa UNIQUE indeks işe yaramaz. 'legacy:<id>' hem benzersiz hem
-- TAHMİN EDİLEBİLİR: bu iş, kimlik anahtarı öncesi tek seferlik bir iş olarak
-- vardı ve tekrar yayınlanmamalıdır.
INSERT INTO publish_jobs_v2 (
  id, content_id, account_id, platform, state, scheduled_at, attempts,
  idempotency_key, idempotency_first_used_at,
  external_id, upload_url, upload_url_expires_at, uploaded_parts, total_parts,
  remote_id, permalink, error_json, next_attempt_at,
  lease_owner, lease_expires_at,
  started_at, finished_at, created_at, updated_at
)
SELECT
  id, content_id, account_id, platform, state, scheduled_at, attempts,
  'legacy:' || id,
  NULL,
  external_id, NULL, NULL, 0, NULL,
  remote_id, permalink,
  -- Eski `error` düz metindi. JSON NESNESİ olmayan her değer, bilgi kaybı
  -- olmaması için `kind='unknown'` sınıfına sarılır. 'unknown' sözleşmede
  -- YENİDEN DENENMEZ (isRetryableKind), dolayısıyla geçmişte yanlış bir
  -- "yeniden dene" kararı üretilmez.
  CASE
    WHEN error IS NULL OR TRIM(error) = '' THEN NULL
    WHEN json_valid(error) AND json_type(error) = 'object' THEN error
    ELSE json_object(
      'kind',        'unknown',
      'message',     error,
      'providerCode', NULL,
      'logId',       NULL,
      'httpStatus',  NULL,
      'retryAfterMs', NULL,
      'retryable',   0,
      'at',          COALESCE(updated_at, created_at)
    )
  END,
  next_attempt_at,
  lease_owner,
  CASE
    WHEN lease_expires_at IS NULL THEN NULL
    WHEN TYPEOF(lease_expires_at) IN ('integer','real') THEN CAST(lease_expires_at AS INTEGER)
    ELSE CAST(strftime('%s', lease_expires_at) AS INTEGER) * 1000
  END,
  started_at, finished_at, created_at, updated_at
FROM publish_jobs;

DROP TABLE publish_jobs;
ALTER TABLE publish_jobs_v2 RENAME TO publish_jobs;

-- DROP TABLE indeksleri de düşürdü; hepsi yeniden kurulur. 002'deki kısmi
-- indeks (WHERE state='queued') BİREBİR aynı tanımlanmalıdır.
CREATE UNIQUE INDEX IF NOT EXISTS ux_publish_jobs_target
  ON publish_jobs(content_id, platform, account_id);

-- Mükerrer yayının son savunması.
CREATE UNIQUE INDEX IF NOT EXISTS ux_publish_jobs_idempotency
  ON publish_jobs(idempotency_key);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_state_scheduled
  ON publish_jobs(state, scheduled_at);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_lease
  ON publish_jobs(state, lease_expires_at);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_poll
  ON publish_jobs(state, updated_at);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_remote
  ON publish_jobs(platform, remote_id);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_due
  ON publish_jobs(scheduled_at, IFNULL(next_attempt_at, 0))
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS ix_publish_jobs_account
  ON publish_jobs(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_publish_jobs_content
  ON publish_jobs(content_id, platform);
