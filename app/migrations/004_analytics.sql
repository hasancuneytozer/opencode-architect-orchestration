-- 004_analytics — içerik performansı (metrik) deposu.
--
-- 001..003'e DOKUNULMAZ: yayınlanmış veritabanlarında checksum tutarsızlığı
-- oluşturur. Bu dosya YENİDİR ve aynı migration ikinci kez çalıştırılsa da
-- güvenlidir (yalnız `CREATE ... IF NOT EXISTS` ve `ALTER TABLE ADD COLUMN`
-- yok; tek ifade türü `CREATE TABLE/INDEX IF NOT EXISTS`).
--
-- ── NEDEN AYRI TABLO ────────────────────────────────────────────────────────
-- `publish_jobs` bir YAYIN kaydıdır (ne gönderdik, hangi durumda); `metrics_json`
-- oraya sıkıştırılmaz. Yayın durumu ile ölçüm tarihi bağımsız ilerler: bir iş
-- `published` olur ve o gün insights boş döner (IG verisi 48 saat gecikmeli),
-- ertesi gün ölçüm gelir. Tek satırda tutmak "yayınlandı ama henüz veri yok"
-- ile "ölçülemedi" ayrımını birbirine eziyordu.
--
-- ── `UNIQUE (job_id, metric_date)` GEREKÇESİ ────────────────────────────────
-- Metrikler bir (video, gün) çiftine aittir. Aynı gün iki kez yazılırsa:
--   1) günlük satır sayısı şişer (aynı veri iki kere),
--   2) "aralıkta kaç gün ölçüldü" sayımı YANLIŞ olur — bu sayım
--      `missingDataDays`/`DataCompleteness` in temeli,
--   3) panelde aynı gün iki farklı satır görünür.
-- Ve aynı gün yeniden çekim (veri gecikmesi bittikten sonra) GERÇEKTEN olur.
-- Bu yüzden INSERT değil UPSERT: ikinci yazma satırı çoğaltmaz, mevcut günü
-- GÜNCELLER. `(job_id, metric_date)` UNIQUE, `content_metrics(job_id,
-- metric_date DESC)` sorgusunu da indeksle bedava kılar.
--
-- `metric_date` neden `YYYY-MM-DD` ve neden metin: tarih dilimi YERELDİR
-- (Avrupa/İstanbul'da gece yarısı UTC'de 21:00'dir). Gün, içerik saat diliminde
-- hesaplanır (`src/analytics/metrics.ts → metricDate`) ve burada SADE CEVİZ
-- biçimde saklanır; leksikografik sıralama `YYYY-MM-DD` üzerinde tarih
-- sıralamasıdır, ayrı bir parse katmanı gerekmez.
--
-- GLOB deseniyle şekil doğrulanır: yanlış biçim (`2026-1-1`, boş metin)
-- sessizce "tarih sıralaması bozuk" bir satır olurdu.

CREATE TABLE IF NOT EXISTS content_metrics (
  id            TEXT PRIMARY KEY,

  -- Yayın işi. İş silinince ölçüm de silinir: ölçüm, var olmayan bir yayının
  -- metriği değildir. `publish_jobs` satırı yeniden oluşturulursa ölçüm
  -- geçmişi de yeni işe bağlanmaz — yeni iş, yeni ölçüm.
  job_id        TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,

  -- Panele "bu içeriğin performansı" diye sorgulanabilmesi için denormalize
  -- edilmiş kenar. `publish_jobs`'tan alınabilirdi ama
  -- "tüm içeriklerin toplam metriği" sorgusu her zaman JOIN'siz çalışmalıdır.
  content_id    TEXT NOT NULL REFERENCES contents(id)    ON DELETE CASCADE,

  platform      TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  -- Uzaktaki kalıcı kimlik. Boş olamaz: ölçülebilir içerik zaten yayınlanmış
  -- olmalıdır; `''` geçen bir CHECK olmasaydı "kimliği olmayan yayın" ölçülebilir
  -- görünürdü.
  remote_id     TEXT NOT NULL CHECK (remote_id <> ''),

  -- `YYYY-MM-DD`, YEREL gün.
  metric_date   TEXT NOT NULL
                CHECK (metric_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- Normalleştirilmiş zarf: { metrics, unknown, deprecated }.
  --   * `metrics`    → kanonik ad → sayı|null. `null` = yok, `0` = SIFIR.
  --   * `unknown`    → sağlayıcının verdiği ama karşılığı olmayan adlar.
  --   * `deprecated` → kaldırılmış metrikler (IG `plays`, `impressions`).
  -- JSON1 doğrulaması burada: bozuk metin veritabanına giremez.
  metrics_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),

  -- "NEDEN ölçülemedi." Boşsa ölçüm anlamlıdır.
  unavailable_reason TEXT
    CHECK (unavailable_reason IS NULL
           OR unavailable_reason IN ('not_public','not_found','no_scope',
                                     'provider_error','deleted')),
  unavailable_message TEXT CHECK (unavailable_message IS NOT NULL AND TRIM(unavailable_message) <> ''),

  -- Destek kanıtı. TikTok `log_id` ZORUNLUDUR: destek talebinde tek ipucu budur.
  -- Diğer platformlarda null olur; `unavailable` yine de yazılır.
  log_id        TEXT,

  -- Bu satırın ÜRETİLDİĞİ an (UTC ISO) — `fetched_at`.
  fetched_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  -- Bkz. yukarıdaki gerekçe: aynı gün iki satır YAZILMAZ, güncellenir.
  UNIQUE (job_id, metric_date),

  -- `reason` ve `message` BİRLİKTE anlamlıdır: panelde tek cümle gösterilir,
  -- destek talebinde ikisi birlikte kopyalanır. Aşağıdaki iki CHECK ÇİFT YÖNLÜ
  -- bir kural koyar ve tam olarak şunu yasaklar:
  --     reason var + message yok   → yasak (uygulama eksik mesaj yazmış)
  --     message var + reason yok   → yasak (sebebi olmayan uyarı)
  --     ikisi de var / ikisi de yok → serbest
  --
  -- metrics_json'un kendisi kısıtlanMAZ: `unavailable_reason` doluyken de boş
  -- olabilir (sağlayıcı kısmi veri döndü), `unavailable_reason` boşken de
  -- dolu olabilir (kapsam sonradan daraldı ama geçmiş ölçümler duruyor).
  -- Bu iki CHECK "ikisinin de doluyken mantıksız durum" kuralının
  -- uygulanabilir hâlidir.
  CHECK (unavailable_reason IS NOT NULL OR unavailable_message IS NULL),
  CHECK (unavailable_message   IS NOT NULL OR unavailable_reason IS NULL)
);

-- Tarih aralığı sorgusu: "geçen 7 günün metrikleri".
CREATE INDEX IF NOT EXISTS ix_content_metrics_date
  ON content_metrics(metric_date);

-- Platform + aralık: `listByPlatform`. Aralık indeksinin önünde `platform`
-- olmalı; aksi halde filtre olamaz ve tüm tarih tablosu taranır.
CREATE INDEX IF NOT EXISTS ix_content_metrics_platform_date
  ON content_metrics(platform, metric_date);

-- İçerik bazlı panel sorgusu (tüm platformlar, en yeni gün önce).
CREATE INDEX IF NOT EXISTS ix_content_metrics_content_date
  ON content_metrics(content_id, metric_date DESC);