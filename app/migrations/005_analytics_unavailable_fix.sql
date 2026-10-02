-- 005_analytics_unavailable_fix — 004'teki CHECK hatasını düzeltir.
--
-- 001..004'e DOKUNULMAZ: yayınlanmış veritabanlarında checksum tutarsızlığı
-- oluşturur. Bu dosya YENİDİR.
--
-- ── BUG ────────────────────────────────────────────────────────────────────
-- 004'te şu kısıt var:
--     unavailable_message TEXT CHECK (
--       unavailable_message IS NOT NULL AND TRIM(unavailable_message) <> '')
--
-- Bu, `unavailable_message` NULL olan HER satırı reddeder. SQL üç değerli
-- mantığında `NULL IS NOT NULL` sonucu **NULL değil FALSE**'tır; `FALSE AND …`
-- da FALSE'tır ve CHECK reddeder. Yani "ölçüldü" durumu — yani `reason` de
-- `message` de NULL olan, asıl ölçüm satırı — **hiçbir zaman yazılamıyor.**
--
-- Ölçülmüş davranış (4 durumdan yalnız 1'i yazılabiliyordu):
--     reason NULL, message NULL   → REDDEDİLDİ   ← olması gereken
--     reason NULL, message ''     → REDDEDİLDİ   ← olması gereken
--     reason dolu, message dolu   → yazıldı
--     reason dolu, message '   '  → REDDEDİLDİ   ← doğru davranış
--
-- Sonuç: `content_metrics` yalnız "ölçülemedi" satırı saklayabiliyordu. Yani
-- **başarılı hiçbir ölçüm kaydedilemiyordu** ve tüm performans raporu boş
-- kalırdı. Bu hata 004 uygulandıktan sonra hiç yakalanmadı: `content_metrics`'e
-- dokunan tek test, "ölçülemedi" yolunu sınıyordu.
--
-- ── DÜZELTME ───────────────────────────────────────────────────────────────
-- Kısıt ters çevrilir: mesaj ya NULL olmalı ya da boşluktan ibaret olmamalı.
--     CHECK (unavailable_message IS NULL OR TRIM(unavailable_message) <> '')
--
-- SQLite bir CHECK'i `ALTER TABLE` ile değiştiremez; tablo yeniden kurulur.
-- `PRAGMA defer_foreign_keys = ON` ile FK'lar transaction içinde geçici olarak
-- ertelenir — migration çalıştırıcısı her dosyayı transaction içinde uygular ve
-- SQLite `foreign_keys`'i transaction içinde yok sayar.
--
-- Veri KORUNUR: eski tablodaki satırlar yeni tabloya taşınır.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content_metrics_v2 (
  id            TEXT PRIMARY KEY,

  job_id        TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  content_id    TEXT NOT NULL REFERENCES contents(id)    ON DELETE CASCADE,

  platform      TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  remote_id     TEXT NOT NULL CHECK (remote_id <> ''),

  -- `YYYY-MM-DD`, YEREL gün (bkz. 004 gerekçesi).
  metric_date   TEXT NOT NULL
                CHECK (metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- `metrics` → kanonik ad → sayı|null. `null` = yok, `0` = SIFIR.
  metrics_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),

  -- "NEDEN ölçülemedi." Boşsa ölçüm anlamlıdır.
  unavailable_reason TEXT
    CHECK (unavailable_reason IS NULL
           OR unavailable_reason IN ('not_public','not_found','no_scope',
                                     'provider_error','deleted')),

  -- DÜZELTME: NULL SERBEST. Ölçülmüş satırın mesajı yoktur; yalnız var olan
  -- mesajın boşluktan ibaret olmaması gerekir.
  unavailable_message TEXT
    CHECK (unavailable_message IS NULL OR TRIM(unavailable_message) <> ''),

  -- TikTok `log_id` destek talebinde zorunludur; diğerlerinde null.
  log_id        TEXT,

  fetched_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  UNIQUE (job_id, metric_date),

  -- `reason` ve `message` birlikte anlamlıdır (panelde tek cümle, destek
  -- talebinde ikisi birlikte kopyalanır). 004'teki çift yönlü kural korunur:
  --     reason var + message yok   → yasak
  --     message var + reason yok   → yasak
  --     ikisi de var / ikisi de yok → serbest
  CHECK (unavailable_reason IS NOT NULL OR unavailable_message IS NULL),
  CHECK (unavailable_message   IS NOT NULL OR unavailable_reason IS NULL)
);

INSERT INTO content_metrics_v2 (
  id, job_id, content_id, platform, remote_id, metric_date,
  metrics_json, unavailable_reason, unavailable_message, log_id,
  fetched_at, created_at, updated_at
)
SELECT
  id, job_id, content_id, platform, remote_id, metric_date,
  metrics_json, unavailable_reason, unavailable_message, log_id,
  fetched_at, created_at, updated_at
FROM content_metrics;

-- 004'teki tablo adı geçici oluşturucu adını aldı; asıl tabloyu düşürüp
-- yeniden adlandırıyoruz. `sqlite_sequence`/`sqlite_autoindex` yok (PRIMARY KEY
-- metin, `AUTOINCREMENT` kullanılmıyor) — ek bir temizlik gerekmiyor.
DROP TABLE content_metrics;

ALTER TABLE content_metrics_v2 RENAME TO content_metrics;

-- İndeksler 004'te `content_metrics` üzerinde oluşturulmuştu; tablo düşürülünce
-- gittiler. Aynı tanımlarla yeniden kurulur.
CREATE INDEX IF NOT EXISTS ix_content_metrics_date
  ON content_metrics(metric_date);

CREATE INDEX IF NOT EXISTS ix_content_metrics_platform_date
  ON content_metrics(platform, metric_date);

CREATE INDEX IF NOT EXISTS ix_content_metrics_content_date
  ON content_metrics(content_id, metric_date DESC);
