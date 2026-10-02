# Araştırma Kaynakları

Bu dosya **yalnız resmî kaynakların listesidir.** Her bağlantı
`developers.facebook.com`, `developers.tiktok.com`, `developers.google.com`,
`support.google.com` veya `transparency.meta.com` alan adlarındandır.

**Kural:** Bu dosyada olmayan bir bağlantı uydurulmamıştır. Doğrulanamayan
konular **yalnız** §5'te listelenmiştir; onlar için bağlantı **yoktur**,
çünkü kaynak yoktur.

**Ne okudum** başlıkları, o sayfanın hangi soruya cevap verdiğini gösterir.

---

## 1. Instagram / Meta

### Ne okudum — yayın rehberi

| Sayfa | Ne cevapladı |
| --- | --- |
| [Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing) | İki giriş yolu karşılaştırması, izinler, resumable upload protokolü, container durumları, `is_ai_generated`, `media_product_type`, AI Content bölümü |
| [IG User Content Publishing Limit](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit) | `quota_total: 50`, `quota_duration: 86400`, `since` parametresi, `quota_usage` |
| [Error Codes](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes) | `2207042` (kota), `2207004` (dosya çok büyük) |
| [Overview](https://developers.facebook.com/documentation/instagram-platform/overview) | Page bağlantısı, ön koşullar, "**Page Publishing Authorization** (PPA)" kavramı, Rate Limiting (`4800 × Impressions`), messaging limitleri |

### Ne okudum — erişim ve politika

| Sayfa | Ne cevapladı |
| --- | --- |
| [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels/) | Standard vs Advanced Access, "Business, Consumer, and Gaming apps are automatically approved for Standard Access", Data Use Checkup |
| [App Review — Introduction](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction/) | "If your app will only be used by app users who have a role on the app itself, **App Review is not required**", ekran kaydı zorunluluğu, "If we are unable to access your app to test it, your entire submission will be rejected" |
| [App Review — Tutorial](https://developers.facebook.com/docs/resp-plat-initiatives/appreview/tutorial/) | "Make at least 1 successful API call using each permission... **within 30 days** of submitting" |
| [Business Verification](https://developers.facebook.com/docs/development/release/business-verification/) | "As of February 1, 2023", Advanced Access için zorunluluk |
| [Access Verification](https://developers.facebook.com/docs/development/release/access-verification/) | Tech Provider doğrulaması; `instagram_content_publish`, `pages_read_engagement`, `pages_show_list` bu listede |
| [Permissions Reference](https://developers.facebook.com/docs/permissions) | Gerçek izin adları ve bağımlılıkları |

### Ne okudum — sürüm ve hız sınırı

| Sayfa | Ne cevapladı |
| --- | --- |
| [Versioning](https://developers.facebook.com/docs/graph-api/guides/versioning/) | "The latest Graph API version is `v26.0`", "at least two years" yaşam süresi, sürümsüz çağrı uyarısı |
| [Introducing Graph API v26.0](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/) | v26.0 yayın tarihi (29 Temmuz 2026), **v20.0 kaldırma 24 Eylül 2026**, **v21.0 kaldırma 21 Ocak 2027** |
| [Rate Limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/) | Platform vs BUC hız sınırı ayrımı, `80002` hata kodu |
| [Changelog for Instagram Platform](https://developers.facebook.com/documentation/instagram-platform/changelog) | Sürüm bazlı kaldırmalar |

### Meta doküman indeksleri

| Bağlantı | Ne işe yarar |
| --- | --- |
| [Instagram Platform — llms.txt](https://developers.facebook.com/documentation/instagram-platform/llms.txt) | Tüm Instagram Platform dokümanlarının makine-okunur dizini |
| [Error Codes (markdown)](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes.md) | Aynı hata sayfasının markdown sürümü |

> **Not:** Meta doküman ağacında `/docs/instagram-platform/...` ve
> `/documentation/instagram-platform/...` adresleri ikisi de çalışıyor.
> Bu dosyada okunduğu doğrulanan `/documentation/` biçimi kullanıldı; her
> iki biçim de aynı içeriğe gider.

---

## 2. TikTok

### Ne okudum — akış

| Sayfa | Ne cevapladı |
| --- | --- |
| [Get Started — Direct Post](https://developers.tiktok.com/doc/content-posting-api-get-started) | Ön koşullar, `creator_info/query` cevabı (`max_video_post_duration_sec`), iki transfer yöntemi, fotoğraf (`/v2/post/publish/content/init/`), "Your app must be approved for the `video.publish` scope" |
| [Direct Post (API Reference)](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) | `/v2/post/publish/video/init/` şeması, `post_info` alanları (`is_aigc`, `video_cover_timestamp_ms`, `disable_*`), `source_info`, `upload_url` 1 saat kuralı, hata kodları tablosu, chunk `PUT` başlıkları |
| [Upload Video (API Reference)](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video) | Inbox modu `/v2/post/publish/inbox/video/init/`, `video.upload` scope, "at most 5 pending shares within any 24-hour period" |
| [Get Post Status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status) | Durum kodları, `fail_reason` tablosu, `publicaly_available_post_id` koşulu, **webhook olayları**, 30/dk hız sınırı, moderasyon süreleri, işlem süreleri tablosu |
| [Media Transfer Guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide) | **Video restrictions tablosu** (format, kodek, 23–60 fps, 360–4096, 3/10 dakika, 4 GB), chunk kuralları (5–64 MB, son parça 128 MB, 1–1000, sıralı, `total_chunk_count` formülü, 5 MB altı kenardurum) |

### Ne okudum — politika ve erişim

| Sayfa | Ne cevapladı |
| --- | --- |
| [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) | "Apps must not be for private or personal use", "utility tool to help upload contents to the account(s) you or your team manages" ❌, denetim kısıtları (5 kullanıcı/24 saat, `SELF_ONLY`, hesap `private`), "do not use FILE_UPLOAD; use PULL_FROM_URL instead", `max_video_post_duration_sec` kontrolü zorunluluğu, alan adı doğrulama |
| [Content Posting API erişim talebi](https://developers.tiktok.com/apps/publishers/content-posting/) | Content Posting API erişim başvurusu (KIMLIK-KURULUMU adım 2.4) |
| [Developer Portal — Apps](https://developers.tiktok.com/apps) | App oluşturma, ürün ekleme, Client Key/Secret, redirect URI, sandbox |

> **Bu iki bağlantı giriş gerektirir (HTTP 401).** Bunlar hata değil, portal
> sayfalarıdır: TikTok Developer Portal'a oturum açmadan erişilemezler.
> `curl` ile kontrol edilip "bozuk" sanılabilir. Doğrulama yöntemi: tarayıcıda
> açın, giriş yapın. Aynı sebeple bu iki URL "Ne okudum" listesinin kaynak
> kanıtı değildir — oradaki bilgiler diğer herkese açık dokümanlardan alındı.

---

## 3. YouTube

### Ne okudum — referans

| Sayfa | Ne cevapladı |
| --- | --- |
| [Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert) | **"Quota impact: 100 calls per day. A call to this method has a quota cost of 1 unit in the Video Uploads quota bucket."**, 28 Temmuz 2020 sonrası doğrulanmamış proje = `private` kilidi, `https://www.googleapis.com/upload/youtube/v3/videos`, scope listesi, **settable properties** (→ `targetContentCategory` yok, `containsSyntheticMedia` `status` altında), hata kodları tablosu, 256 GB üst sınır |
| [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost) | "100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints", "`search.list` and `videos.insert` methods have their **own quota buckets**", metot bazlı birim tablosu, "Daily quotas reset at midnight Pacific Time", "All API requests, including invalid requests, incur at least a one-point quota cost" |
| [Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) | Varsayılan kota, kotayı aşmak için audit zorunluluğu, Developer Policies bağlantısı |
| [API Reference](https://developers.google.com/youtube/v3/docs) | `part`/`fields` yarı kaynak kavramı, URI haritası |
| [Errors](https://developers.google.com/youtube/v3/docs/errors) | `quotaExceeded (403)`, `forbidden (403)` |

> ⚠️ **Bu sayfada bir tuzak var ve kaydedilmelidir.** Quota Calculator'ın bir
> paragrafı hâlâ "methods like `videos.insert` have the highest cost of **1600
> points**" diyor. Aynı sayfanın tablosu "insert | 100 quota per day. Each
> call costs 1 quota." diyor ve `videos.insert` referansı da 1 birim diyor.
> **1600 güncellenmemiş bir artık metindir; güncel değer 1'dir.**

### Ne okudum — rehberler

| Sayfa | Ne cevapladı |
| --- | --- |
| [YouTube Data API Overview](https://developers.google.com/youtube/v3/getting-started) | Proje oluşturma, API etkinleştirme, "A video upload costs 1 unit", varsayılan kota dağılımı, `part`/`fields` ayrımı, ETag ve gzip |
| [YouTube Data API Services (başvuru formu)](https://support.google.com/youtube/contact/yt_api_form) | Compliance audit başvurusu, "significant independent value" kriteri, quota artış isteği, re-audit ifadesi |

> **Doğrulanmayan URL:** `https://developers.google.com/youtube/v3/determine_quota`
> ve `https://developers.google.com/youtube/v3/quota` adresleri **404** döndü.
> Doğru adres `determine_quota_cost`'tur. Yazmadan önce doğrulandı.

### YouTube sayfalarındaki kalıcı uyarı

Her YouTube Data API sayfasının üstünde şu banner vardır:

> "Important: YouTube is updating its policy for how it counts views for all
> video formats."

Bu, 27 Ağustos 2026 view sayımı değişikliğine işaret eder. Politikanın **tam
metni** sayfalarda bulunmuyor — bu yüzden §5'e alındı.

---

## 4. Ölçek ve sürüm notu

| Konu | Değer | Nereden |
| --- | --- | --- |
| Graph API en son sürüm | `v26.0` | Versioning |
| `v20.0` kaldırıldı | 24 Eylül 2026 | v26.0 blog duyurusu |
| `v21.0` kaldırılacak | 21 Ocak 2027 | v26.0 blog duyurusu |
| Meta doküman ağacı | `/documentation/...` ve `/docs/...` ikisi de geçerli | Doğrulama sırasında görüldü |
| YouTube `videos.insert` | 1 birim, günde 100 (ayrı kova) | Videos: insert + Quota Calculator |
| YouTube `videos.update` | 50 birim (genel kova) | Quota Calculator |

---

## 5. DOĞRULANMADI — tek liste

Aşağıdakiler için **resmî kaynak bulunamadı.** Bu listedeki hiçbir madde için
bağlantı verilmemiştir, çünkü dayanak yoktur. Tahmin edilmediler.

### Instagram

| Konu | Neden bulunamadı |
| --- | --- |
| Meta localhost / tünel / IP adresini kabul ediyor mu | Hiçbir yerde ifade geçmiyor |
| HTTPS zorunlu mu | Doküman yalnız "public server" diyor |
| `is_ai_generated` cezasının niteliği | Ceza metni belgede yok |
| `is_ai_generated` zorunluluğunun başlangıç tarihi | Content Publishing sayfasında tarih yok |
| Meta App Review gerçek süresi | Resmî sayı yok; "1 haftadan az, genelde 2–3 gün" ifadesi bulunamadı |
| `quota_total` 50 iken rehberdeki 100'in kaynağı | Aynı rehber içinde iki sayı, açıklama yok |
| `4800 × Impressions` sayacının pratik tabanı | Yeni hesapta kaç çağrıya izin verildiği yazmıyor |
| `pages_show_list` publish için gerekli mi | Content Publishing izin tablosunda yok |
| `rupload` yüklemesinde HTTP durum kodu | Örnekler HTTP kodu vermeden verilmiş |
| `rupload` devam protokolü (hangi offset'ten) | Cevap biçimi belgelenmemiş |
| Container oluşturma limiti | Okunan belgelerde bu sayı geçmiyor |

### TikTok

| Konu | Neden bulunamadı |
| --- | --- |
| `Retry-After` header davranışı | 429 açıklamasında header'dan hiç söz edilmiyor |
| Denetim (audit) başvuru süresi | Resmî sayı yok |
| Denetim reddi sonrası itiraz yolu | Belgede yok |
| `is_aigc` topluluk standardı karşılığı | Etiket metni var, zorunluluk/ceza yok |
| Sandbox → production geçiş adımları | Limitler ve yasak var, geçiş süreci yok |
| `FILE_UPLOAD` ihlalinin yaptırımı | "do not use FILE_UPLOAD" kuralı var, cezası yok |
| `/v2/video/query/` cevap şeması ve hız sınırı | Sayfa okunmadı |
| `brand_content_toggle` / `brand_organic_toggle` birlikte kullanımı | Alan tanımları var, etkileşim kuralı yok |
| Webhook güvenlik (secret, imza) yöntemi | Olaylar listelenmiş, doğrulama anlatımı yok |
| `upload_url` dolunca aynı `publish_id` kullanılabilir mi | Yazmıyor |
| `http://127.0.0.1` redirect URI kabul ediliyor mu | Resmî olarak belirtilmemiş |

### YouTube

| Konu | Neden bulunamadı |
| --- | --- |
| Shorts'e özel analitik API filtresi | Belgelenmemiş |
| 27 Ağustos 2026 view politikasının tam metni | Sadece uyarı banner'ı var, politika sayfası bağlantısı yok |
| `videos.update` için asgari scope tam listesi | Sayfa dört scope listeliyor, hangisinin yeterli olduğunu söylemiyor |
| Compliance audit gerçek süresi | Resmî sayı yok |
| Compliance audit reddi sonrası yol | Belgede yok |
| Workspace/Cloud Identity "Internal" consent'in kişisel projede kullanımı | Yazmıyor |
| Content ID global blok kuralının kesin eşiği | "3 dakikayı aşan" deniyor, istisnalar yazmıyor |
| `publishAt` dolunca kullanıcıya bildirim veriliyor mu | Belgede yok |
| `googleusercontent` değişikliğinde `videos.update` gerekiyor mu | Belgede yok |
| "Significant independent value" kriterinin ölçütü | Form ister, tanım vermez |

---

## 6. Bu listeye ekleme kuralı

Yeni bir kaynak eklerken:

1. **Önce adresi aç.** 404 dönüyorsa ekleme. (Bu kontrol, iki YouTube ve bir
   TikTok adresinin listeden düşmesini sağladı.)
2. **Hangi soruya cevap verdiğini yaz.** "Ne okudum" sütunu boşsa kaynak
   işe yaramıyor.
3. **Doğrulanamayanı §5'e ekle, §1–3'e değil.** Doğrulanmamış bir şeyi
   kaynak listesine koymak, onu doğrulanmış gibi sunmak demektir — bu, bu
   depodaki en pahalı hatadır.
4. **Alan adı kuralına uy.** Yalnız `developers.facebook.com`,
   `developers.tiktok.com`, `developers.google.com`, `support.google.com`,
   `transparency.meta.com`.
