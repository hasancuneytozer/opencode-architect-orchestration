# Mimari — Sistem Tasarımı

Bu belge tasarımı **niçin** böyle olduğunu açıklar. Neyin nerede yaşadığını
`app/src` ve `app/migrations` okunarak yazılmıştır; bu metin kodun yerine
geçmez, kodun mantığını gerekçelendirir.

**Bağlı bulgular:** [ARASTIRMA.md](./ARASTIRMA.md) ·
**Kurulum:** [KIMLIK-KURULUMU.md](./KIMLIK-KURULUMU.md) ·
**Kaynaklar:** [ARASTIRMA-KAYNAKLARI.md](./ARASTIRMA-KAYNAKLARI.md)

---

## 1. Katmanlar

```
contract/   paylaşılan şekiller   ← saf veri tipi, kural yok
ports/      arayüzler             ← dışarıya bağlanma noktaları
domain/     saf kurallar          ← saf fonksiyon, I/O yok
adapters/   gerçek + sahte        ← fetch, better-sqlite3, ffmpeg BURADA
services/   iş akışı             ← portlar üzerinden orkestrasyon
http/       Fastify rotaları      ← sınır
cli/        komut satırı          ← sınır
```

Bağımlılık yönü **her zaman yukarıdır.** Aşağıdan yukarıya bağımlılık yoktur.

### 1.1 `contract/` — ortak dil

Burada yalnızca **veri şekilleri** vardır. İş kuralı, ağ çağrısı, dosya
erişimi veya veritabanı erişimi yoktur. Testi veritabanı gerektirmez.

Bu katmanın kritik sorumluluğu **politika kararlarını tek yerde toplamak**:

| Karar | Nerede | Neden burada |
| --- | --- | --- |
| "Bu hata yeniden denenir mi" | `isRetryableKind()` | Üç adaptör de aynı soruyu sorar. Üç yere yazılırsa biri unutur |
| Hata sınıfları | `PUBLISH_ERROR_KINDS` | Sağlayıcıya özel kodlar **buraya girmez** |
| Durum adları | `ALL_JOB_STATES`, `ALL_CONTENT_STATES` | Enum değerleri DB `CHECK` kısıtlarıyla eşleşir |
| Kutu biçimi | `CredentialCipher` yorumu | İki farklı biçim sessizce okunamayan veri üretir |

**Karar kaydı — sağlayıcı kodları neden çekirdekte değil:**

`TikTok`un `fail_reason` değerleri, `Meta`nın `code/subcode` çiftleri ve
`YouTube`ın `reason` alanları **adaptör içinde** sınıflara eşlenir. Çekirdek bu
dilleri bilmez. Böylece TikTok `fail_reason` tablosu değiştiğinde yalnız TikTok
adaptörü değişir; hiçbir test, hiçbir katman etkilenmez.

**Karar kaydı — `RetryOutcome.refreshToken: null` neden "koru" demek:**

TikTok, yenileme sırasında girdiğinden **farklı** bir `refresh_token`
döndürebilir ve bu durumda eskisi **geçersizleşir**. `null` dönmesi "bu sefer
dönmedi" demektir, "eskini sil" demek değildir. İkisi farklı durumlardır ve tip
sistemi bunu ayırmak zorundadır. Sessizce eski token'ı korumak, refresh
yetenekini kaybetmek demektir.

### 1.2 `ports/` — dış dünyayla konuşma

`ports/index.ts` uygulamanın **ne yapabileceğini** tanımlar, **nasıl**
yapacağını değil.

| Port | Soyutlama | Gerçek implementasyon | Sahte implementasyon |
| --- | --- | --- | --- |
| `FfmpegProbe` | `ffprobe` ile medya bilgisi | `media/ffmpeg.ts` | Sabit `MediaInfo` |
| `Transcoder` | Dönüştürme, kapak karesi | `media/ffmpeg.ts` | Yazma, boyut döndürür |
| `MediaStore` | Dosya deposu + isteğe bağlı public URL | `media/store.ts` | Bellek deposu |
| `PublishAdapter` | Platform yayını | `adapters/publish/*` | `published` döner |
| `AuthProvider` | OAuth akışı | `adapters/auth/*` | Sabit token |
| `CredentialCipher` | Şifreleme | AES-256-GCM | Ters çevir (yalnız test) |
| `AnalyticsAdapter` | Metrik çekme | `adapters/analytics/*` | Sıfır dolu |

**`StartResult` neden dört kollu:**

Yayın akışının dört ayrı *sonuç* şekli vardır ve dördü de gerçektir:

| Kol | Ne zaman | Platform |
| --- | --- | --- |
| `immediate` | İş sunucuda bitti | YouTube `privacyStatus=public` ile |
| `pending` | Uzaktan işleniyor, yoklama gerek | Meta, TikTok |
| `uploadUrl` | İkili yükleme başladı | TikTok (1 saat geçerli) |
| `scheduled` | Sağlayıcıya bırakıldı | YouTube `status.publishAt` |

Bu dördü tek bir `Promise<boolean>`'a indirgenseydi durum makinesi
belirsizleşir ve "yayınlandı mı, yükleniyor mu, mı bekliyor mu" ayrımı kaybolur.

**`PollContext.externalId` neden `AccountRef.externalId` yetmiyor:**

Meta `GET /{ig-user-id}/media?fields=status_code` ister — yani hem IG user id
hem container id gerekir. TikTok `publish_id` + token ister. YouTube yalnız token
ister. Tek bir kimlik alanı bu üçünü karşılayamaz; `PollContext` yedi alan taşır.

### 1.3 `domain/` — saf kurallar

Bu katmanın tek kuralı: **I/O yok.** `fetch`, `fs`, `better-sqlite3`,
`ffmpeg` çağrısı burada bulunamaz.

`contract/index.ts` içindeki saf yardımcılar bu katmanın örneğidir:

| Fonksiyon | Kural |
| --- | --- |
| `isTargetAspect()` | 9:16 toleranslı kontrol (`ASPECT_TOLERANCE = 0.06`) |
| `resolveScheduledAt()` | Ofsetli girdi olduğu gibi, offset'siz girdi `timezone` ile yorumlanır; **daima UTC ISO** döner |
| `isWithinQuietHours()` | Gece yarısını aşan aralıklar (23:00 → 07:00) doğru çalışır |
| `tzOffsetMs()` | IANA diliminin o andaki ofsetini bulur |

**Neden yerel saati saklamıyoruz:** Yıl boyunca kaymaya yol açar. Yaz saati
geçişinde "18:00" iki farklı UTC anına denk gelir. **Depolanan her tarih UTC
ISO'dur.** `timezone` yalnız *girdinin yorumlanması* ve *sessiz saat
hesabı* için saklanır.

**`resolveScheduledAt` tuzağı:** `z.iso.datetime({offset:true})` offset'siz
girdiyi (`2026-09-30T18:00`) reddeder — ama `<input type="datetime-local">`
tam olarak bu biçimi gönderir. `z.iso.datetime({local:true})` ise sahte
tarihleri (`2026-02-31`) geçirir. Bu yüzden ikisini de doğru karşılayan bir
desen + ayrı `Date.parse` doğrulaması kullanılır.

### 1.4 `adapters/` — tek yerde kirlilik

**Bu kuralın kazancı somut:**

`domain` ve `services` hiçbir kütüphaneye dokunmadığı için:

1. **Gerçek yayıncı ile sahte yayıncı aynı testleri geçer.** Sahte adaptör
   `fetch` yapmaz, dosya okumaz, video göndermez; ama `PublishAdapter`
   arayüzünü birebir uygular. Yani iş mantığı testleri sahte adaptörle
   yazılır ve gerçek adaptörle de geçer.
2. **Her adaptör tek başına test edilebilir** — kütüphane kurmadan, ağa
   çıkmadan.
3. **Bir sağlayıcının API'si değişirse yalnız adaptör değişir.** Meta
   `v26.0`'dan `v27.0`'a geçse, tek dosya güncellenir.

**Nerede ne var:**

| Kütüphane | Yalnızca |
| --- | --- |
| `fetch` | `adapters/` |
| `better-sqlite3` | `db/` ve `adapters/` |
| `ffmpeg` / `ffprobe` | `media/` (adaptör konumunda) |

**`readQuota?` neden opsiyonel:** Instagram dışındaki hiçbir platform
yayın öncesi kotayı canlı okumanıza izin vermiyor. Port opsiyoneldir çünkü
Meta `content_publishing_limit` döndürürken TikTok ve YouTube için `null`
döner. Zorunlu olsaydı ya sahte dönüş döndürmek zorunda kalırdı (yanlış
karar) ya da adaptör sözleşmeyi ihlal ederdi.

### 1.5 `services/` — orkestrasyon

Servisler portlar üzerinden konuşur, gerçek implementasyonları bilmez. Bir
servisin `PublishAdapter` alanı `new MetaPublishAdapter(...)` değil, dışarıdan
enjekte edilmiş bir porttur. Bu sayede testte sahte adaptör geçirilir.

### 1.6 `http/` ve `cli/` — sınırlar

- `http/` Fastify rotaları. Zod şemalarıyla gövde doğrular, servise devreder.
- `cli/` komut satırı. Aynı servisleri çağırır, HTTP'den geçmez.

İkisi de aynı iş mantığını kullanır; iki ayrı yayın mantığı olsaydı iki ayrı
hata kaynağı olurdu.

---

## 2. Veri modeli

9 tablo. Şema `migrations/001_init.sql` ve `002_indexes.sql`.

| Tablo | Ne tutar | Öne çıkan kısıt |
| --- | --- | --- |
| `projects` | AI projeleri (hangi ajans/proje) | — |
| `assets` | Videolar + kapak kareleri | `storage_key UNIQUE` |
| `contents` | Yayınlanacak içerik + metin + zaman | `state IN (...)` CHECK |
| `accounts` | Platform hesapları (IG/TikTok/YT) | `UNIQUE (platform, external_id)` |
| `credentials` | Şifreli token'lar | **Düz metin token YOK** |
| `publish_jobs` | İş kuyruğu — kalbin atışı | `UNIQUE (content_id, platform, account_id)` |
| `audit_events` | Kim ne yaptı, ne zaman | — |
| `api_keys` | Ingest istemcilerinin anahtarları | **Ham anahtar YOK**, yalnız `sha256` özeti |
| `settings` | Anahtar/değer ayarlar | — |

### 2.1 `publish_jobs` — neden her alanı ayrı

Bu tablo, üç platformun birbirinden farklı yaşam döngülerini **tek şemada**
taşır. Sütunların her biri bir soruya cevap verir:

| Sütun | Soru |
| --- | --- |
| `state` | Şu an hangi aşamada? |
| `scheduled_at` | Ne zaman yayınlanmalı? (UTC ISO) |
| `attempts` | Kaç kez denendi? |
| `external_id` | Sağlayıcının geçici kimliği ne? (Meta `container_id`, TikTok `publish_id`) |
| `remote_id` | Yayınlanmış içeriğin kalıcı kimliği ne? |
| `permalink` | Kalıcı bağlantı çözümlendi mi? |
| `upload_url` | Meta resumable URI'si / TikTok `upload_url` |
| `uploaded_parts` | Kaldığı parçadan devam için |
| `total_parts` | Toplam parça sayısı |
| `next_attempt_at` | Yeniden denemeye **ne zaman** (epoch ms) |
| `lease_owner` / `lease_expires_at` | Kim işliyor, ne zamana kadar? |
| `idempotency_key` | Bu iş **bir kez** yayınlansın diye ne? |

**`external_id` ile `remote_id` neden ayrı:**

Meta'da `container_id` **geçici**dir (24 saatte ölür), `media_id` **kalıcıdır
(permalink buradan gelir). TikTok'ta `publish_id` geçici, `post_id` kalıcıdır
ama **yalnız herkese açık + moderasyon onaylı** içerik için gelir. Tek bir
"id" sütunu bu ayrımı temsil edemezdi.

**`upload_url` neden ayrı sütunda ve neden ömür kontrolü gerekiyor:**

TikTok `upload_url`'si **1 saat** geçerli. Bu süre dolarsa yükleme başarısız
olur. `TranscodePreset.providerUploadUrlTtlSec` portu bu ömür bilgisini taşır;
`uploadUrlExpiresAt` ile karşılaştırılmadan yeniden kullanılmamalıdır.

**`credentials` tablosunda düz metin token yok:**

`access_token_enc` / `refresh_token_enc` **şifreli** metindir. Şifreleme
`SP_MASTER_KEY` ile AES-256-GCM kullanır. Repository şemayı hazırlar,
kriptografiye karışmaz — kutu biçimi bir **sözleşmedir**:

```
v1:<base64url(nonce)>:<base64url(tag)>:<base64url(ciphertext)>
```

GCM tag'i olmadan şifre çözme **sessizce yanlış sonuç** verir. Bu yüzden `open`
başarısız olursa **eski metne düşülmez, hata fırlatılır.** Sürüm etiketi
(`v1:`) sayesinde ileride algoritma değişse eski kayıtlar okunabilir kalır.

**`api_keys` tablosunda ham anahtar yok:**

Yalnız `digest` (sha256) ve gösterilebilir `prefix` saklanır. Böylece veritabanı
sızsa bile anahtarlar kullanılamaz. Karşılaştırma `digest` üzerinden yapılır.

### 2.2 CHECK kısıtları uygulama hatasını veritabanında yakalar

`state`, `platform`, `status` sütunlarının hepsi `CHECK` kısıtlı. Bu, bir
kod hatasının derlenmiş bir uygulamada yanlış duruma yazılmasını engeller.
Hata, uygulama katmanında değil veritabanı katmanında yükselir.

```sql
CHECK (state IN ('draft','validating','ready','scheduled','published',
                 'partial','failed','canceled'))
```

### 2.3 Tarihler neden TEXT

SQLite'ta tarih tipi yok. ISO-8601 UTC metin olarak saklanır. Karşılaştırma
leksikografik **ve** UTC olduğu için doğru çalışır — `2026-09-30T10:00:00Z`
sözlük olarak küçüktür, kronolojik olarak da küçüktür.

`lease_expires_at` ve `next_attempt_at` **farklı biçimlerdedir** ve bu bilinçlidir:

| Sütun | Biçim | Neden |
| --- | --- | --- |
| `scheduled_at`, `lease_expires_at` | ISO-8601 TEXT | İnsan okunabilir, `ORDER BY` ile sıralanır |
| `next_attempt_at` | **epoch ms INTEGER** | Yeniden deneme hesabı aritmetik; UTC'ye çevirmeye gerek yok |

---

## 3. Kuyruk, kiralama, kurtarma

Bu, uygulamanın en kritik bölümüdür. İki kural burada yaşar.

### 3.1 `claimDue` — atomik kiralama

**Problem:** "Sırası gelen işi al" ile "durumunu güncelle" arasında başka bir
yazma girerse, **aynı iş iki işçiye gider ve aynı video iki kez yayınlanır.**

**Çözüm:** Seçme + güncelleme **tek bir transaction** içindedir
(`BEGIN IMMEDIATE`).

```sql
SELECT * FROM publish_jobs
WHERE scheduled_at <= @now
  AND (
        (state = 'queued')
     OR (lease_expires_at IS NOT NULL
         AND lease_expires_at < @now
         AND state IN ('preparing','uploading','processing'))
     OR (state = 'failed' AND next_attempt_at IS NOT NULL
         AND next_attempt_at <= @nowMs)
  )
ORDER BY scheduled_at ASC, id ASC
LIMIT @limit
```

Seçim koşulu **üç dalı** birleştirir:

| Dal | Ne zaman |
| --- | --- |
| `state = 'queued'` | Yeni planlanmış iş |
| `lease_expires_at < now` **ve** kiralanmış durumlarda | Çöken süreçten kurtarma |
| `state = 'failed'` **ve** `next_attempt_at <= now` | Geçici hatadan yeniden deneme |

Ardından satırlar `id` sırasıyla kilitlenir (`lease_owner`,
`lease_expires_at`). `better-sqlite3` senkron çalıştığı için bu süre içinde
başka bir bağlantı yazamaz: ya COMMIT'li ya ROLLBACK'li olur. **"İki çağrı
aynı işi görmez"** garantisi transaction'dan gelir, uygulama kodundan değil.

**Sıralama `ORDER BY scheduled_at ASC, id ASC`:** `id` ikincil sıralama
anahtarıdır. Aynı anda gelen işlerde sıra **kararlıdır** — test edilebilir
davranış.

**`next_attempt_at` NULL ise koşul dışıdır.** Bu, "yeni planlanmış iş" ile
"yeniden deneme bekleyen iş"i ayırır. `NULL` bir `next_attempt_at` için
`COALESCE` ile `0` yapılsa, yeni işler sürekli yeniden denenirdi.

**Kiralama `leaseOwner` boşsa hata fırlatır.** Tanımlanabilir olmayan bir
işçi kimliği, kurtarma mekanizmasını anlamsız kılar. Sessizce `null` yazmak,
"bu işi kimse tutmuyor" durumu üretir.

### 3.2 `recoverExpiredLeases` — çökme kurtarma

Uygulamada tek düğüm var ama **süreç çökebilir** (güç kesintisi, güncelleme,
çökme). Çöken düğümün `lease_expires_at`'i geçmiş işler yeniden kuyruğa alınır:

```sql
UPDATE publish_jobs
SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
    attempts = attempts + 1,
    error = COALESCE(error, 'lease süresi doldu; düğüm yeniden başlatıldı'),
    updated_at = ?
WHERE id = ?
```

**`attempts` artışı bilinçlidir.** Çöken süreçteki iş kimse bilmeden yarım
kalmış olabilir (dosya yarı yüklenmiş, konteyner açık). Deneme sayacı artmalıdır
ki "her zaman yeniden deneriz" durumu oluşmasın.

**Bu bir "devre" DEĞİLDİR.** Soğuması biten iş tekrar işlenebilir. Kalıcı bir
yasak koymak, tek seferlik bir ağ hatasından sonra işin kalıcı olarak
ölmesine yol açardı.

### 3.3 İndeksler — sorgu planı için

| İndeks | Hangi sorguyu kurtarır |
| --- | --- |
| `ix_publish_jobs_state_scheduled (state, scheduled_at)` | "Sırası gelen kuyruk işleri" — **olmazsa her tick'te tam tarama** |
| `ix_publish_jobs_due (scheduled_at, IFNULL(next_attempt_at,0)) WHERE state='queued'` | Kısmi indeks: yalnız kuyruktakiler |
| `ix_publish_jobs_lease (state, lease_expires_at)` | Süresi dolmuş kiralama bulma |
| `ix_publish_jobs_poll (state, updated_at)` | Uzaktan yoklama (uploading/processing) |
| `ix_publish_jobs_remote (platform, remote_id)` | Yayınlananları listeleme |

`ix_publish_jobs_due` **kısmi indekstir** (`WHERE state = 'queued'`). Yalnız
kuyruktaki satırları indeksler, yazma maliyeti düşer ve indeks küçük kalır.
`IFNULL(next_attempt_at, 0)` sayesinde `NULL` olanlar sıralamada öne geçer.

`EXPLAIN QUERY PLAN` ile doğrulama **testte** yapılır (`explainDueQuery`).
Birim test yazmak yetmez; indeks gerçekten kullanılıyor mu ölçülmelidir.

---

## 4. Durum makineleri

İki ayrı durum makinesi var ve **kasıtlı olarak ayrıdır.**

### 4.1 İçerik durumu — `contents.state`

İçerik, bir *varlığın* yaşam döngüsüdür. Kaç platforma gideceği önceden
bilinmez.

```
draft ──► validating ──► ready ──► scheduled ──► published
  │            │                       │      │
  │            ▼                       ▼      ▼
  │         failed                 canceled  partial
  │            │                                  ▲
  └────────────┴──────────► canceled              │
                                    failed ────────┘
```

| Durum | Anlamı |
| --- | --- |
| `draft` | Yeni, henüz doğrulanmadı |
| `validating` | Teknik kontrol sürüyor |
| `ready` | Yayına hazır |
| `scheduled` | Zamanlandı, kuyrukta |
| `published` | **Bütün** platformlarda yayınlandı |
| `partial` | **Bazı** platformlarda yayınlandı, bazılarında başarısız |
| `failed` | Yayınlanamadı |
| `canceled` | Vazgeçildi |

**Neden `partial` ayrı bir durum:** Bu uygulamanın asıl işlevi **tek bir videoyu
üç platforma birden** göndermek. İki platforma gidip üçüncüsü kotalıysa içerik
ne "published" ne "failed" olmalıdır. `partial`, "işin bir kısmı yapıldı"
gerçeğini temsil eder ve arayüzün hangi platformun başarısız olduğunu
göstermesini sağlar.

**Yasak geçişler:**

| Geçiş | Durum | Neden |
| --- | --- | --- |
| `published` → `draft` | ❌ Yasak | Yayınlanmış içerik geri alınmaz |
| `published` → `failed` | ❌ Yasak | Platformda yayınlanmış bir şey "başarısız" olamaz |
| `canceled` → `scheduled` | ❌ Yasak | Vazgeçilmiş iş yeniden canlandırılmaz; yeni içerik açılır |
| `validating` → `published` | ❌ Yasak | Doğrulamadan yayına geçilemez |
| `failed` → `validating` | ✅ Serbest | Yeniden denemede yeniden doğrulanır |

### 4.2 Yayın işi durumu — `publish_jobs.state`

İş, **tek bir (içerik, platform, hesap) üçlüsünün** yaşam döngüsüdür.

```
queued ──► preparing ──► uploading ──► processing ──► published
  │            │             │              │            │
  │            │             │              │            ▼
  │            │             │              │   published_no_link
  │            ▼             ▼              ▼            │
  └────────► failed ◄────────┴──────────────┘            │
  │            │                                          │
  │            └──► (next_attempt_at dolunca) queued ─────┘
  ▼
canceled
```

| Durum | Anlamı |
| --- | --- |
| `queued` | Sırası bekliyor veya yeniden denemeye sıra bekliyor |
| `preparing` | Transcode, kapak karesi, son doğrulama |
| `uploading` | İkili gövde gönderiliyor |
| `processing` | Uzaktan işleniyor, yoklama gerekiyor |
| `published` | Yayınlandı **ve** kalıcı permalink çözümlendi |
| `published_no_link` | Yayınlandı **ama** permalink alınamadı |
| `failed` | Hata |
| `canceled` | Vazgeçildi |

**`published_no_link` neden ayrı — bu durumun varlık sebebi:**

TikTok `share_url`'ı API'de **döndürmez**. `status/fetch` yalnız herkese açık
**ve moderasyon onaylı** içerik için `post_id` verir. Denetimden geçmemiş bir
istemci `SELF_ONLY` yayın yapar → `post_id` hiç gelmez → kalıcı bağlantı yok.

Bu durumda içerik **başarıyla yayınlanmıştır**, sadece bağlantısı yoktur.
`failed` demek yanlış olur (yeniden denemek mükerrer yayın üretir), `published`
demek de yanlış olur (bağlantı sözü verilmiş olur). `published_no_link`
üçüncü doğru seçenektir.

**Yasak geçişler:**

| Geçiş | Durum | Neden |
| --- | --- | --- |
| `published` → herhangi bir | ❌ Yasak | Bitti. Yeniden yayın mükerrer içerik |
| `published_no_link` → `queued` | ❌ **En kritik yasak** | Yeniden denemek **mükerrer yayın** demek |
| `processing` → `uploading` | ❌ Yasak | Geri dönüş yok; ya ilerle ya geçici hata |
| `uploading` → `queued` | ⚠️ Sadece kurtarma | `recoverExpiredLeases` yapar, normal akışta olmaz |
| `canceled` → `queued` | ❌ Yasak | Vazgeçilmiş iş yeniden başlatılmaz |
| `preparing` → `published` | ❌ Yasak | Yükleme adımı atlanamaz |
| `failed` → `queued` | ✅ **Sadece `next_attempt_at` dolduysa** | Geçici hata politikası |

**`failed` kalıcı mı geçici mi — ayrım `next_attempt_at` ile:**

İki sütun birlikte ayrımı yapar:

| Durum | `nextAttemptAt` | `finishedAt` | Davranış |
| --- | --- | --- | --- |
| Geçici hata | **dolu** | `NULL` | `claimDue` zamanı gelince yeniden alır |
| Kalıcı hata | `NULL` | **dolu** | Kuyruktan çıkar, kullanıcı müdahale etmeli |

`recordFailure(id, error, retryable, nextAttemptAt)` bunu tek yerde yapar.
Ayrım CHECK kısıtıyla değil, bu iki sütunla temsil edilir.

**Hata sınıflandırması tek kaynaktan:** `isRetryableKind()` yalnız dört sınıfı
geçici sayar: `network`, `ratelimit`, `server`, `transient`. Geri kalan tümü
kalıcıdır.

**Sağlayıcı hatalarının eşlenmesi:**

| Sağlayıcı | Ham kod | Sınıf | Dayanak |
| --- | --- | --- | --- |
| TikTok | `internal` | `server` | Doküman: "This is a retryable error." |
| TikTok | `video_pull_failed` | `transient` | Doküman: "a retry is recommended" |
| TikTok | `auth_removed` | `auth` | Doküman: "Retry should not be done." |
| TikTok | `spam_risk*` | `policy` | Doküman: "Retry should not be done." |
| TikTok | `file_format_check_failed` | `media_rejected` | Kalıcı |
| Meta | `9/2207042` | `quota` | "try again the following day" |
| Meta | `4/2207051` | `policy` | Spam koruması |
| Meta | `-2/2207003` | `transient` | İndirme zaman aşımı |
| Meta | `debug_info.retriable: true` | `transient` | Sunucunun retryability bayrağı |
| Meta | `80002` | `ratelimit` | BUC kotaya ulaşıldı |
| YouTube | `quotaExceeded` (403) | `ratelimit` | Günlük kota, "bugün" sınıfı |
| YouTube | `403 forbidden` | `auth` | Scope eksik olabilir |
| YouTube | `400 invalidTitle` vb. | `validation` | Kalıcı |

> **Meta `9/2207042` özel durumu:** Bu hata "bugün" sınıfındadır ama
> `isRetryableKind("quota")` **false** döner. Bu çelişki bilinçlidir: kota
> hatasında iş kuyruktan **çıkmamalı**, `nextAttemptAt` dolduğunda yeniden
> denenmelidir. Kalıcı hata yolu (iş kuyruktan çıkar) kotada yanlıştır —
> kullanıcı ertesi gün yayını unutur.

### 4.3 `TERMINAL_OK_STATES` ve `PUBLISHED_STATES` neden iki liste

```ts
TERMINAL_OK_STATES = ["published"]           // süreç başarıyla tamamlandı
PUBLISHED_STATES  = ["published", "published_no_link"]  // platforma yayınlandı
```

İkisi farklı sorulara cevap verir:

- **"Bu iş bitti mi?"** → `TERMINAL_OK_STATES`
- **"Bu içerik platformda görünüyor mu?"** → `PUBLISHED_STATES`

Analitik toplama ve "başarı oranı" metriği ikinci listeyi kullanır. İlk liste
yoksa, TikTok'ta bağlantısız yayınlar başarısızlık gibi sayılır — bu yanlıştır.

---

## 5. İdempotens stratejisi

**Hedef:** Süreç çöküp yeniden başlasa da **mükerrer yayın olmasın.**

Bu, "yayın" gibi geri alınamaz bir işlemde en kritik gerekliliktir. Bir
zamanlayıcıda bir job'ın iki kez çalışması neredeyse kaçınılmazdır: süreç
kuyruğu okuduktan sonra çöker, yeniden başlar, aynı işi tekrar alır.

### 5.1 Üç katmanlı savunma

```
Katman 1: UNIQUE (content_id, platform, account_id)   → aynı hedefe iki iş olmaz
Katman 2: claimDue tek transaction (lease)            → aynı iş iki işçiye gitmez
Katman 3: idempotencyKey                              → sağlayıcıya gönderilir
```

**Katman 1** `ux_publish_jobs_target` tekil indeksi: aynı içerik aynı hesaba iki
kez kuyruğa giremez. `enqueueUnique()` zaten kuyruktaysa mevcut işi döner.

**Katman 2** `claimDue`'un atomik kiralama transaction'ı (§3.1).

**Katman 3** asıl savunmadır ve aşağıda.

### 5.2 `idempotencyKey` — kalıcı, iş başına

`PublishInput.idempotencyKey` bir **kalıcı** (birim) anahtardır. İş ilk kez
oluşturulduğunda üretilir, veritabanında saklanır, her yeniden denemede **aynı
değer** gönderilir.

| Platform | Anahtar nereye gider | Sunucu ne yapar |
| --- | --- | --- |
| TikTok | `video/init/` isteği | Aynı anahtarla ikinci `publish_id` üretmez |
| YouTube | Resumable oturum başlangıcı | Aynı oturumu döndürür |
| Meta | Container + `media_publish` | Container'ı yeniden kullanır |

**Bu, "kiralama doldu, işçi yeniden çalıştı" senaryosunun tek savunmasıdır.**
Katman 1 ve 2 o işin *iki işçiye gitmesini* engeller; katman 3, *aynı işçinin
ikinci kez denemesinin* zararsız olmasını sağlar. Katman 2 bir hata durumunda
(lease süresi çok kısa ayarlandıysa, ağ kesintisiyle süre dolarsa) tek başına
yetmez.

**`idempotencyKey` + `idempotencyFirstUsedAt` çifti neden var:** Anahtar ne
zaman ilk kez sunucuya gönderildiğini bilmek, "bu iş hiç gönderilmedi mi"
sorusunu yanıtlar. Sunucuya hiç ulaşılmamış bir iş ile, ulaşılmış ama cevabı
alınamamış bir iş farklıdır.

**Neden `crc32`/`md5` gibi kısa bir hash değil:** Anahtar çakışmamalıdır.
İçerik kimliği + platform + hesap kimliğinin birleşimi, platforma özgü bir
önek ve iş kimliğinden türetilir.

### 5.3 Kalıcı olmayan durum: `upload_url`

`upload_url` **idempotent değildir** ve kalıcı bir kaynak değildir. TikTok
verirse 1 saat geçerlidir. Yeniden kullanılabilmesi için:

| Durum | Davranış |
| --- | --- |
| `upload_url` dolu ve süresi dolmamış | Aynı `publish_id` ile kaldığı parçadan devam |
| `upload_url` dolu ve **süresi dolmuş** | Yeni `init` çağrısı → yeni `publish_id`; `uploaded_parts` **sıfırlanır** |
| `upload_url` `NULL` | İlk `init` |

`uploaded_parts` / `total_parts` alanları bu devamı mümkün kılar. TikTok
parçaları **sıralı** gönderim ister; bu yüzden "hangi parçadaydım" bilgisi
şarttır.

> **Doğrulanmamış:** `upload_url` süresi dolduğunda **aynı `publish_id`**
> kullanılabilir mi, yoksa yeni `init` mi gerekir, resmî dokümanda yazmıyor.
> Güvenli varsayım: yeni `init`. ARASTIRMA.md §2.16-Bilinmeyenler.

---

## 6. Neden tünel artık şart değil

**Bu bir mimari rahatlama, kurulum adımı değildir.** Ayrım önemlidir.

### 6.1 Üç platformun da ikili yükleme yolu var

| Platform | Yükleme yöntemi | Herkese açık URL ister mi |
| --- | --- | --- |
| Instagram | `POST /{ig-user-id}/media` (`upload_type=resumable`) → `POST https://rupload.facebook.com/ig-api-upload/vXX/{container_id}` header `offset` + `file_size` | **HAYIR** |
| TikTok | `source_info.source = "FILE_UPLOAD"` → `publish_id` + `upload_url` → sıralı `PUT` | **HAYIR** |
| YouTube | `POST ?uploadType=resumable` → `Location` → `PUT` gövde | **HAYIR** |

**Sonuç: hiçbir platform herkese açık video URL'i istemiyor.**

Instagram için Meta'nın Content Publishing rehberi "media must be hosted on a
publicly accessible server" der; ancak aynı rehberin Resumable Upload bölümü
"**A file located on your computer**" der ve `--data-binary "@my_video.mp4"`
örneği verir. "Public server" cümlesi `video_url` alanını kullanan akış içindir.

### 6.2 Bunun mimari kazancı

| Kazanç | Açıklama |
| --- | --- |
| Medya sunucusu gerekmez | Diskte duran dosya doğrudan `fetch` ile gönderilir |
| Tükettiği bant az | Video yerel diskten okunur, tünele çıkıp geri dönmez |
| `SP_PUBLIC_BASE_URL` opsiyonel | Bu anahtar olmadan uygulama tam çalışır |
| `MediaStore.publicUrl` null dönebilir | Port sözleşmesi bunu zaten kabul eder |
| Tek kural | Üç platformda da aynı güvenlik modeli |

`MediaStore.publicUrl(key, opts)` portu şunu **sözlü olarak** belirtir:

> `publicBaseUrl` tanımlı değilse `null` döner — adaptör bunu "yayınlanamaz"
> olarak ele almalı, **sessizce özel adres üretmemeli.**

Bu, tünelsiz çalışmanın mimaride **izin verilen** bir durum olduğunun kanıtıdır.

### 6.3 `SP_PUBLIC_BASE_URL` hâlâ ne zaman gerekir

| Senaryo | Gerekli mi |
| --- | --- |
| Instagram resumable yükleme | **HAYIR** |
| TikTok `FILE_UPLOAD` | **HAYIR** |
| TikTok `PULL_FROM_URL` | **EVET** — ayrıca alan adı doğrulaması gerekir |
| YouTube resumable yükleme | **HAYIR** |
| Arayüze uzaktan (telefondan) erişim | **EVET** — ama bu bir *kolaylık*, zorunluluk değil |

**TikTok'ta `PULL_FROM_URL` ihtimali ciddi.** TikTok'un ürün rehberi açıkça
diyor: "If video resources are already on API Clients' servers, **do not use
FILE_UPLOAD; use PULL_FROM_URL instead.**" `SP_PUBLIC_BASE_URL` bu yüzden tamamen
gereksiz değildir — platform stratejisi değişirse gerekebilir.

**`SP_ALLOW_PRIVATE_MEDIA_URL` neden varsayılan `false`:** Meta'nın "public
server" kuralını ihlal eden özel adresler (`http://192.168.1.50/...`)
üretmeye izin veren bayrak. Yanlışlıkla `true` yapılırsa sorun Instagram'da
çıkar ve teşhisi zordur. **Varsayılanı değiştirmeyin.**

### 6.4 Bu, meta veriyi yanlış okumak mı

`.env.example` yorumu şunu diyor:

> "Instagram videoyu KENDİ sunucularından çektiği için bu adres herkese açık
> (tünel üzerinden) erişilebilir olmak ZORUNDA."

Bu, araştırmadan **önce** yazılmış ve araştırma sonucuyla **çelişiyor**:
resumable yükleme varken Meta videoyu kendi sunucularından çekmiyor.
`contract/index.ts` ise doğru tarafta:

```ts
requiresPublicMediaUrl: false,   // "2026-09 itibarıyla HİÇBİR platformda true değil"
supportsBinaryUpload: false,     // yorum: "Instagram: resumable upload VAR"
```

> **Tespit:** `.env.example` yorumu güncellenmeli. Bu, doküman iş paketinin
> **yazma yüzeyi dışında** olduğu için burada yapılmamıştır. İlgili işçiye
> bildirilmiştir. Kod davranışı etkilenmez: adaptör `media.publicUrl === null`
> durumunda yalnız resumable yola düşer.

---

## 7. Kimlik saklama

### 7.1 AES-256-GCM, sürüm etiketli kutu

```
v1:<base64url(nonce)>:<base64url(tag)>:<base64url(ciphertext)>
```

| Parça | Boyut | Neden |
| --- | --- | --- |
| `v1` | — | Sürüm etiketi. Algoritma değişse eski kayıtlar okunur |
| `nonce` | 12 bayt | GCM IV'si. Her şifrelemede **benzersiz** olmalı |
| `tag` | 16 bayt | Kimlik doğrulama etiketi |
| `ciphertext` | değişken | Şifreli metin |

**`SP_MASTER_KEY` 32 bayttır.** Üretimi:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Neden GCM ve CBC değil:** GCM hem şifreler hem **kimlik doğrulama** yapar.
CBC'de şifreleme ile bütünlük ayrıdır; şifre çözme başarısı olsa bile veri
bozulmuş olabilir. GCM'de tag uyuşmazsa şifre çözme **başarısız olur**.

**En kritik kural:** GCM tag'i olmadan şifre çözme **sessizce yanlış sonuç**
verir. Bu yüzden:

> `open` başarısız olursa **ESKİ METNE DÜŞME, HATA FIRLAT.**

Bu, token'ın kırık olduğu anı gürültülü ama dürüst bir hataya çevirir.
Sessizce eski metne düşmek, kullanıcının kimlik bilgilerinin yanlış
aktarılmasına ve anlaşılmaz 401'lere yol açar.

**`rotatedAt` neden var:** TikTok yeni bir `refresh_token` döndürdüğünde eskisi
**geçersizleşir**. Bu alan "dönüş yapıldı" bilgisini tutar; yenileme mantığı
hangi token'ın güncel olduğunu bu alandan anlar.

**`boundExternalId` neden var:** Yenilenen token farklı bir hesaba aitse
(`accountChanged: true`) bu bir alarmdır. Token'ın hangi hesaba bağlı olduğu
kayıtta tutulur ve değişirse hesap `needs_reauth` durumuna alınır.

### 7.2 `SP_MASTER_KEY` kaybı

Kayıt token'ları **çözülemez**. Tüm hesaplar yeniden yetkilendirme gerektirir.
Bu kabul edilmiş bir sadeleştirmedir: anahtar yönetimi ( KMS, anahtar
döndürme) bu sürümde yoktur.

**Üretimde mutlaka yedekleyin.** `SP_MASTER_KEY`'i bir parola yöneticisine
kopyalayın; depoya koymayın.

### 7.3 `mockMode` — anahtar yoksa

```ts
mockMode: masterKey === null
```

`SP_MASTER_KEY` boşsa uygulama **mock modunda** çalışır: hiçbir şey gerçekten
yayınlanmaz, sahte adaptörler devreye girer. Bu, kimlik kurulumu tamamlanana
kadar arayüzü gezebilmek için kullanışlıdır.

**Ama tuzaktır:** Kullanıcı "yayınladım" sanabilir. Bu yüzden mock modunda
arayüz **açıkça** bunu göstermelidir.

### 7.4 Ingest anahtarları

`api_keys` tablosunda **ham anahtar saklanmaz.** Yalnız `sha256` özeti ve
gösterilebilir `prefix` tutulur. Karşılaştırma özet üzerinden yapılır.

AI projesi istemcileri `sp_` önekli anahtarlarla `sourcePath` vererek
`sourceUrl` vermek yerine yerel dosya okuması yaptırabilir. Bu, ingest'i SSRF
riskine sokmaz — ağ yolu ayrı ve kısıtlıdır (§8).

---

## 8. Ingest güvenliği

AI proje çıktıları güvenilmeyen girdidir. Kaynak iki yoldan gelir ve ikisi de
saldırı yüzeyidir.

### 8.1 `sourcePath` — dosya sistemi kaçırma

`sourcePath` sunucu tarafında okulan bir yoldur. İstemci kontrolünde olduğu
için saldırgan `.env`, `~/.ssh/id_rsa` veya veritabanı okumayı deneyebilir.

**Reddedilenler:**

| Kural | Örnek |
| --- | --- |
| NUL bayt | `a.txt\0.png` |
| Gezinme (nokta-nokta) | `../../.env` |
| Ev dizini genişletmesi | `~/.ssh/id_rsa` |
| Baştaki nokta | `.env` |
| Mutlak yol | `C:\Windows\System32\...` |
| Uzunluk | 1024 karakter üzeri |

**Ek savunma: depolama anahtarı doğrulaması.** `storageKey` HTTP gövdesinden
geldiği için ayrıca sertleştirilir. Reddedilenler:

| Kural | Gerekçe |
| --- | --- |
| `..`, `.`, boş segment | Gezinme |
| `a:b` | **Sürücü harfi ve NTFS ADS** (`file.txt:hidden`) |
| Ters eğik çizgi `\` | Windows yolları karışıklığı |
| Mutlak yol | `/x`, `\x`, `\\server\share` |
| Ayrılmış cihaz adı | `CON`, `PRN`, `AUX`, `NUL`, `COM1`… |
| NUL bayt | Kesme |
| URL-kodlanmış varyant | `%2e%2e%2fx` — çözülüp **yeniden denetlenir** |

Çözme-sonra-yeniden-denetleme adımı, aynı saldırının farklı kodlamayla
gelmesini engeller. Sessizce geçmez.

**Kök sınır:** Depolama kökü `SP_STORAGE_DIR` ile belirlenir. Anahtar
çözüldükten sonra hedefin **kökün altında** olduğu ayrıca doğrulanır. `..`
reddi tek başına yetmez; mutlak yol çözümlemesi kökü atlayabilirdi.

### 8.2 `sourceUrl` — SSRF

`sourceUrl` sunucunun **kendi** çekeceği bir adrestir. Klasik SSRF:

| Engellenen | Neden |
| --- | --- |
| `file://`, `data:` | Yalnız `http(s)` |
| `localhost`, `127.` | Kendi uygulamamıza erişim |
| `0.`, `10.`, `192.168.` | Özel ağ aralıkları |
| `172.16.` – `172.31.` | Özel ağ aralığı |
| `169.254.` | Link-local |
| `::1` | IPv6 loopback |
| `metadata.google.internal` | Bulut metadata servisi — kimlik bilgisi sızdırır |

**`169.254.169.254` neden özellikle önemli:** Bulut ortamlarında bu adres
instance metadata'sını verir ve oradan IAM kimlik bilgileri okunabilir. Bu,
tek bir `curl` ile bulut hesabına yönelici olmaktır.

**Sınırlama (bilinen):** Bu kontroller **metin tabanlıdır** ve DNS çözümlemesi
yapmaz. `http://attacker.example/` adı `127.0.0.1`'e çözülen bir domain olabilir
(DNS rebinding). Kalıcı çözüm: indirme anında `lookup` sonucunu da doğrulamak
ve yönlendirmeleri kapatmak. Bu, bu sürümde **yapılmamıştır** — bilinen bir
sınırdır ve §10'da listelenmiştir.

**Mutlak konuşma:** İstemci URL'yi doğrudan `fetch`'lemez; yalnız
`sourceUrl` kabul edilir. `sourcePath` ve `sourceUrl` **aynı anda
verilemez** ve **tam olarak biri zorunludur** (Zod `refine`).

### 8.3 `autoSchedule` varsayılanı `false`

```ts
autoSchedule: z.boolean().default(false)
```

**Gerekçe:** Reklam içeriği insan onayı olmadan yayına girmemelidir. Bu alanı
`true` yapan istemci (CLI/otomasyon) riski **bilinçli olarak** alıyor.

AI üretimi içerik yayınlamak, iki farklı riski birleştirir: reklam mevzuatı ve
AI etiketi yükümlülüğü. İkisinin de insancıllı onay gerektirmesi doğrudur.

### 8.4 AI bildirimi onayı

```ts
userConfirmed: z.boolean().default(false)
  .describe("Kullanıcı, içeriğin AI üretimi olduğunu onayladı mı? Onaysız gönderilmez.")
```

`AiDisclosure` üç platformun üç farklı alanına gider:

| Platform | Alan | Ne zaman |
| --- | --- | --- |
| TikTok | `post_info.is_aigc` | `video/init/` gövdesinde |
| YouTube | `status.containsSyntheticMedia` | `videos.insert` — **`status` altında** |
| Instagram | `is_ai_generated` | Container oluştururken |

**Neden tek boolean yetmiyor:** Üç alan üç farklı yerde, üç farklı anda
gönderiliyor ve hepsi zorunlu etiketler. Tek bir `aiGenerated: boolean`
adaptöre kadar taşınır ama **hangi alana** yazılacağı adaptörün sorumluluğundadır.

**YouTube'da `containsSyntheticMedia` `status` altındadır**, `contentDetails`
altında **değildir**. Yanlış yere koymak sessizce yok sayılır — hata çıkmaz,
etiket kaybolur.

**Instagram'da carousel kuralı:** `is_ai_generated` yalnız **carousel
container'ına** konur; çocuk container'a konursa hata döner. Bu uygulama
carousel yayınlamıyor, ama kural bilinmeli.

### 8.5 ⚠️ YouTube `part` tuzağı — AI bildirimini sessizce kaybetmek

`videos.update` semantiği: "hangi `part`'ı gönderiyorsan, o part'ta
belirtmediğin alanlar **SİLİNİR**."

```json
// ❌ YANLIŞ — selfDeclaredMadeForKids, containsSyntheticMedia, license SİLİNİR
{ "part": "status", "status": { "privacyStatus": "public" } }
```

Bu, `containsSyntheticMedia`'ı siler → AI etiketi kaybolur → **hiçbir hata
mesajı çıkmaz.** Sessiz bir politika ihlali.

**Mimari sonuç:** YouTube adaptörü, `videos.insert` sırasında gönderdiği tüm
`status` alanlarını kalıcı saklamalı ve `videos.update`'te **hepsini** geri
göndermelidir. Aynı kural `snippet` için de geçerlidir.

> **Mimari borç (henüz yazılmadı):** `PublishJob` üzerinde ya da
> `contents.metadata_json` içinde "son bilinen YouTube status gövdesi"
> alanı gerekiyor. Bu olmadan zamanlanmış yayın + sonradan `videos.update`
> akışı etiketi sessizce düşürür.

---

## 9. Zamanlama

### 9.1 Zaman damgası politikası

**Depolanan her tarih UTC ISO'dur.** Yerel saat **asla** saklanmaz.

Gerekçe: "18:00" bir zaman diliminde yıl boyunca iki farklı UTC anına denk
gelir (yaz saati geçişi). "2026-10-01T18:00+03:00" saklamak, altı ay sonra
kullanıcıya yanlış bir an gösterir.

| Değer | Saklanan biçim |
| --- | --- |
| `scheduledAt` (içerik) | UTC ISO |
| `contents.timezone` | IANA adı — yalnız girdi yorumlaması + sessiz saat |
| `next_attempt_at` | epoch ms |
| `lease_expires_at` | UTC ISO |

### 9.2 Sessiz saat

```ts
quietHours: { start: "23:00", end: "07:00" }
```

Gece yarısını aşan aralık doğru çalışır:

```ts
const from <= to ? now >= from && now < to : now >= from || now < to
```

`start > end` ise gece yarısını geçer. `23:00 → 07:00` içinde `02:00` doğru
eşleşir.

**Yerel saat diliminde** hesaplanır (`SP_TIMEZONE`), çünkü "gece 2'de
yayınlama" ifadesi kullanıcının kendi saatine göre anlam taşır.

### 9.3 Zamanlayıcı döngüsü

`SP_SCHEDULER_TICK_MS` (varsayılan 15 saniye) ile:

```
her tick:
  1. claimDue(now, limit=SP_PUBLISH_CONCURRENCY, leaseOwner, leaseMs)
  2. işlenen işler için startPublish / pollPublish
  3. bitti olanlar için finalize
```

`SP_PUBLISH_CONCURRENCY=1` varsayılanı **bilinçlidir.** TikTok init'i 6/dk,
status 30/dk sınırındadır. Tek hesapla çalışan bir kurulumda yüksek
eşzamanlılık bu sınırları aşar. Sınır sağlayıcının hız sınırıdır, uygulamanın
değil.

### 9.4 Yayın zamanlaması: iki strateji

| Platform | Strateji | Neden |
| --- | --- | --- |
| **YouTube** | **Sağlayıcıya bırak** (`status.publishAt`) | API destekliyor. `privacyStatus: "private"` + `publishAt` |
| **Instagram** | **Kendi kuyruğumuzda** | Graph API'de yayın anı belirleme yok |
| **TikTok** | **Kendi kuyruğumuzda** | Public API'de zamanlama yok |

`PlatformSpec.supportsNativeSchedule` bu ayrımı taşır. YouTube'da iş
`scheduled` durumuna geçer ve `publishAt` dolduğunda kendiliğinden yayınlanır.
Diğerlerinde iş zamanı geldiğinde uygulama API'yi çağırır.

**YouTube `publishAt` koşulları:** `privacyStatus` **`private`** olmalı ve
video **daha hiç yayınlanmamış** olmalı. Saat gelince video otomatik `public`
olmaz — sonradan `videos.update` ile değiştirilmelidir, ve o update'te
**tüm status alanları** gönderilmelidir (§8.5).

### 9.5 Kuyruk derinliği

`countByState()` arayüzü besler. Aşağıdaki durumlar "meşgul" görünür:
`preparing`, `uploading`, `processing`. Terminal durumlar
(`published`, `published_no_link`, `failed`, `canceled`) kiralama
serbest bırakır — aksi halde kuyruk kalıcı olarak "meşgul" görünürdü.

---

## 10. Bilinen riskler

### 10.1 Riskler

| # | Risk | Etki | Azaltma |
| --- | --- | --- | --- |
| 1 | **TikTok app review politikası** — "Apps must not be for private or personal use"; "yükleyici yardımcı araç" reddedilen örnek olarak listelenmiş | **Yüksek** — haftalar süren başvuru reddedilebilir, denetim gelmez | Aracı "Share to TikTok" deneyimi olarak konumlandırma. Başvuru metninde dahili araç olduğunu açıkça yaz |
| 2 | **Meta kota belirsizliği** — resmî kaynaklar kendi içinde çelişiyor (100 vs 50) | Orta — yanlış kota kararı mükerrer yayın veya gereksiz erteleme | `content_publishing_limit`'i **canlı oku**. Koda sayı yazma |
| 3 | **YouTube 7 günlük token** — External + Testing consent'te refresh token iptal | **Yüksek** — kullanılamaz hale gelir | Workspace projesi + Internal consent, ya da In Production / doğrulama |
| 4 | **TikTok sandbox'ta public yayın yasağı** | Orta — "yayın çalışıyor mu" test edilemez | Entegrasyon beklentisini buna göre yaz. Gerçek hesapla `SELF_ONLY` test |
| 5 | **YouTube `part` sessiz silme** — `containsSyntheticMedia` kaybolur | **Yüksek** — AI etiketi ihlali, hata çıkmaz | Son bilinen status gövdesini sakla (mimari borç, §8.5) |
| 6 | **YouTube doğrulanmamış proje = `private`** | Orta — yükleme 200 döner, video görünmez | Audit başvurusu + her yüklemeden sonra `privacyStatus` kontrolü |
| 7 | **TikTok refresh token rotasyonu** | Orta — sessizce refresh kaybı | `refreshToken: null` ≠ "koru". Yeni token'la değiştir |
| 8 | **`SP_MASTER_KEY` kaybı** | Yüksek — tüm token'lar çözülemez | Yedekle. Anahtar rotasyonu bu sürümde yok |
| 9 | **TikTok `share_url` dönmüyor** | Düşük — bağlantı alınamaz | `published_no_link` durumu ayrı modellenmiş |
| 10 | **SSRF: DNS rebinding** | Düşük–Orta — `sourceUrl` iç IP'ye çözülebilir | Metin kontrolü yeterli değil. Çözümleme sonrası IP kontrolü eksik (§8.2) |
| 11 | **Kiralama ömrü çok kısa** | Orta — iş sürekli kurtarılır, `attempts` şişer | `leaseMs` yüklemeyi (upload_url 1 saat) kapsayacak şekilde ayarlanmalı |
| 12 | **Instagram container 24 saat** | Düşük — gecikme container'ı öldürür | Onay ve yapılandırma değişikliğini container'dan sonra yap |

### 10.2 Risk #11 — kiralama ömrü ve `upload_url` çelişmesi

Bu, mimaride gerçek bir gerilim vardır ve gizlenmemelidir:

| Değer | Süre |
| --- | --- |
| TikTok `upload_url` geçerliliği | **1 saat** |
| Meta container ömrü | **24 saat** |
| Kiralama ömrü (`leaseMs`) | Yapılandırma seçimi |

Kiralama ömrü yükleme süresinden **kısa** olursa, yavaş bir yükleme sırasında
iş "düşen" görünür, `recoverExpiredLeases` kuyruğa geri alır, `attempts` artar
ve yükleme **kaldığı yerden** tekrar başlar (`uploaded_parts` sayesinde).

Bu davranış **kötü değil** — güvenli, çünkü §5.2'deki `idempotencyKey` mükerrer
yayını engeller. Ama `attempts` şişer ve gereksiz yük oluşur. `leaseMs`
yükleme süresini kapsayacak şekilde ayarlanmalıdır.

---

## 11. Test stratejisi

Bu mimarinin doğal sonucu: **testler gerçek API çağırmaz.**

| Test tipi | Ne test eder | Nasıl |
| --- | --- | --- |
| `contract` | Şema doğrulama, saf kural | Veritabanı **gerekmez** |
| `domain` | Zaman, aspect, sessiz saat | I/O yok, anında |
| `db` | Kiralama, kurtarma, idempotens, CHECK kısıtları | Geçici SQLite |
| `media` | Probe, dönüştürme, güvenli anahtar, spec | ffmpeg, fixture dosyalar |
| `config` | Varsayılanlar, eksik alan hatası | `.env` dosyası okunmadan |
| Adaptörler | Hata sınıflandırma eşlemesi | Sahte HTTP cevabı |

**Kritik testler:**

| Test | Neden kilitli |
| --- | --- |
| `claimDue` iki kez çağrılır → iş iki kez dönmez | Mükerrer yayının birinci nedeni |
| `recoverExpiredLeases` → `attempts` artar, `state='queued'` | Çökme kurtarma |
| `enqueueUnique` → ikinci çağrı mevcut işi döner | Katman 1 |
| `ENABLE QUERY PLAN` indeksi kullanıyor | Sorgu planı bozulmasını yakalar |
| `resolveScheduledAt` gece yarısı geçen sessiz saat | Saat dilimi hatası pahalıdır |
| `assertSafeKey` `..`, `C:\`, `%2e%2e%2f`, `a:b` | Yol kaçırma |
| `SourceUrlSchema` `169.254.169.254` reddi | Bulut metadata sızıntısı |
| `isRetryableKind("auth")` false | TikTok `auth_removed` sonsuz döngüsü |
| `isRetryableKind("server")` true | TikTok `internal` yeniden denenmeli |
| Her platforma özel `RETRYABLE` senaryosu kilidi | Politika kararının regresyonu |

**TikTok kilitli senaryo:** "İki model/sağlayıcı arka arda bozulur, üçüncüye
düşülür." Bu, `isRetryableKind` tablosunun yanlışlıkla daraltılmasını yakalar.

**Neden sahte adaptör gerçek olanla aynı testleri geçer:** Sahte adaptör
`PublishAdapter` arayüzünü birebir uygular. Servis katmanı port tipini görür,
somut sınıfı görmez. Bu yüzden servisin testi her iki durumda da geçerler —
"mock ile test ettim, gerçekte çalışmaz" tuzağı yapısal olarak mümkün değildir.

---

## 12. Yapılandırma

`src/config/index.ts` tek noktadan okur. Tasarım kararı: **eksik alanlar
zorunlu sayılmaz, tek bir Türkçe hata mesajı fırlatılır.**

Dağıtık sistemlerde "yarım yapılandırılmış" sessiz bir hatadır. Ya doğru
çalışır ya da çalışma başlamadan açıkça konuşur.

```ts
if (nodeEnv === "test") return [];   // testte hiçbir şey zorunlu değil
// üretimde zorunlu: SP_MASTER_KEY, SP_ADMIN_PASSWORD
```

**`NODE_ENV=test` istisnası neden var:** Testler `.env` olmadan çalışmalıdır.
Bu istisna üretimde devreye girmez.

**`emptyToUndef` ön işlemesi:** `SP_FOO=` (boş) ile `SP_FOO` (yok) aynı
anlama gelir. Aksi halde "anahtarı sildim" sanıp ayarladığınız platform
gizemli şekilde kapalı kalırdı.

**`intFromEnv` alt çizgi temizliği:** `.env.example` sayıları
`SP_SCHEDULER_TICK_MS=15_000` biçiminde yazabiliyor. JavaScript'te `_` geçerli
sayısal ayraç olsa da ortam değişkeni metin olarak geldiği için temizlenir.

**`.env` ezilme sırası:** `loadConfigFromDisk` önce `.env` okur, sonra **açık
süreç ortamı** onu **ezer** (`override: false` dotenv'e, manuel birleştirme
process.env lehine). Container/CI ortamları genelde değişkenleri dışarıdan
geçer; `.env` onları ezmelidir.

**Tespit — `SP_LOG_LEVEL`:** `RAW_SCHEMA`'da var ama `.env.example` dosyasında
**yok**. Varsayılanı `info`. Eksikliği `envExampleKeys()` ile otomatik tespit
edilebilir; bu alan doküman iş paketinin kapsamı dışında olduğu için
`.env.example`'a eklenmemiştir.
