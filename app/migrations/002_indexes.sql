-- 002_indexes — sorgu planına özel indeksler.
--
-- Migration'lar bir kez çalışır ve içeriği değişmez; yeni ihtiyaç için yeni
-- dosya açılır. 001'i düzenlemek, yayınlanmış veritabanlarında checksum
-- tutarsızlığı yaratır.

-- Zamanlayıcı tick'i: "kuyruktaki ve zamanı gelen işler" + retry zamanı dolmuş.
-- next_attempt_at NULL olanlar sıralamada öne geçsin diye IFNULL ile indekslenir.
CREATE INDEX IF NOT EXISTS ix_publish_jobs_due
  ON publish_jobs(scheduled_at, IFNULL(next_attempt_at, 0))
  WHERE state = 'queued';

-- Bir hesabın iş geçmişi (arayüzde hesap detayı).
CREATE INDEX IF NOT EXISTS ix_publish_jobs_account
  ON publish_jobs(account_id, created_at DESC);

-- İçeriğin tüm platform durumu (içerik detay ekranı tek sorgudan beslenir).
CREATE INDEX IF NOT EXISTS ix_publish_jobs_content
  ON publish_jobs(content_id, platform);

-- Depolama anahtarına göre varlık arama (medya indirme yolu).
CREATE INDEX IF NOT EXISTS ix_assets_cover ON assets(cover_key);

-- Kimlik denetimi: eyleme göre zaman sırası.
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_events(action, at DESC);

-- Silinmemiş API anahtarları hızlı listeleme.
CREATE INDEX IF NOT EXISTS ix_api_keys_active
  ON api_keys(created_at DESC)
  WHERE revoked_at IS NULL;
