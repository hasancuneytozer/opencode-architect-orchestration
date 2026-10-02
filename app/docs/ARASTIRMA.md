# Araştırma — Üç Platformun Doğrulanmış Gerçekleri

**Kapsam:** Instagram (Meta Content Publishing API), TikTok (Content Posting API),
YouTube (Data API v3) üzerinden 9:16 dikey reklam videosu zamanlanmış yayınlama.

**Yöntem:** Her iddia resmî geliştirici dokümanından okunmuştur. Okunan sayfa
tarihi, iddianın yanına yazılmıştır. Resmî dokümanda bulunmayan hiçbir şey
tahmin edilmemiştir; o konular her platformun **Bilinmeyenler** listesindedir.

**Kaynakların tam listesi:** [ARASTIRMA-KAYNAKLARI.md](./ARASTIRMA-KAYNAKLARI.md)

> **Okuma kuralı:** "Resmî doküman" ile "yorum" ayrıdır. Yorumlar
> `**Yorum:**` etiketiyle başlar ve doğrulanmış bir gerçeğe dayanır, ama
> dokümanın kendisinin söylemediği bir çıkarımdır.

---

## 1. Instagram — Meta Content Publishing API

> Bu kısım **30 Eylül 2026** itibarıyla resmî dokümanlardan doğrulanmıştır.
> Okunan sayfalar: Content Publishing rehberi, IG User Content Publishing Limit
> referansı, Error Codes referansı, Access Levels, App Review Introduction,
> Business Verification, Access Verification, Graph API Versioning, v26.0 blog
> duyurusu, Instagram Platform Overview (Rate Limiting).

### 1.1 İki giriş yolu

Meta aynı yayın işini iki ayrı giriş yoluyla yapar. Karar senin.

| | Instagram API with Facebook Login | Instagram API with Instagram Login |
| --- | --- | --- |
| Login tipi | Facebook Login **for Business** | **Business** Login for Instagram |
| Host | `graph.facebook.com` + `rupload.facebook.com` (resumable video için) | `graph.instagram.com` |
| Token | Facebook **Page** access token | Instagram **User** access token |
| Facebook Page | **ZORUNLU** | Gerekmez |
| Resumable upload | **VAR** | **YOK** |
| İzinler | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` | `instagram_business_basic`, `instagram_business_content_publish` |

Bu tablo Content Publishing rehberindeki "Page Publishing Authorization"
başlıklı karşılaştırma tablosundan birebir alınmıştır.

**Ek izin koşulu (Facebook Login yolu):** Uygulama kullanıcısının Page'e rolü
Business Manager üzerinden verilmişse `ads_management` **veya** `ads_read`
eklenir.

**Karar kaydı:** Bu uygulama `rupload.facebook.com` resumable yüklemesini
kullandığı için **Facebook Login for Business** yolunu seçer. Instagram Login
yolunda ikili yükleme olmadığı için video'yu herkese açık bir URL'e koymak
zorunda kalırdı.

Kaynak: `https://developers.facebook.com/documentation/instagram-platform/content-publishing`

### 1.2 Resumable upload — herkese açık URL gerekmiyor

Resumable upload oturumu, container oluştururken `upload_type=resumable` ile açılır.
Dönen `id` bir container ID'dir; yükleme `rupload.facebook.com` üzerinden yapılır.

**Adım 1 — container (resumable oturum):**

```http
POST https://graph.facebook.com/v26.0/<IG_USER_ID>/media
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "upload_type": "resumable",
  "media_type": "REELS",
  "caption": "Reklam metni #hashtag"
}
```

```json
{ "id": "<IG_MEDIA_CONTAINER_ID>" }
```

**Adım 2 — ikili gövdeyi yükle:**

```http
POST https://rupload.facebook.com/ig-api-upload/v26.0/<IG_MEDIA_CONTAINER_ID>
Authorization: OAuth <ACCESS_TOKEN>
offset: 0
file_size: 104857600
Content-Type: video/mp4
```

```bash
curl -X POST "https://rupload.facebook.com/ig-api-upload/v26.0/<IG_MEDIA_CONTAINER_ID>" \
     -H "Authorization: OAuth <ACCESS_TOKEN>" \
     -H "offset: 0" \
     -H "file_size: 104857600" \
     --data-binary "@video.mp4"
```

> **İki tuzak, ikisi de resmî dokümanda yazılı:**
> 1. Header `Authorization: OAuth <TOKEN>` — **`Bearer` değil.** Diğer tüm
>    Instagram çağrıları `Bearer` kullanır; bu tek çağrı `OAuth` ister.
> 2. Host `rupload.facebook.com` — `graph.facebook.com` değil. "Most API calls
>    use the `graph.facebook.com` host however, calls to upload videos for Reels
>    use `rupload.facebook.com`."

**Başarı cevabı:**

```json
{ "success": true, "message": "Upload successful." }
```

**Başarısızlık cevabı — dikkat, bu bir HTTP hatası değil, 200'de gelen JSON:**

```json
{
  "debug_info": {
    "retriable": false,
    "type": "ProcessingFailedError",
    "message": "{\"success\":false,\"error\":{\"message\":\"unauthorized user request\"}}"
  }
}
```

> `debug_info.retriable` alanı, yeniden deneme kararını doğrudan veren resmî bir
> alandır. Uygulamanın `PublishFailure.retryable` alanı buradan türetilmelidir.

Aynı uç nokta ikili gövde yerine `file_url` de kabul eder — yani yükleme
yolu isteğe bağlıdır, ikili gövde zorunlu değildir.

### 1.3 "Public server" uyarısı ne anlama geliyor

Content Publishing rehberinin başında şu cümle var:

> "We cURL media used in publishing attempts, so the media must be hosted on a
> publicly accessible server at the time of the attempt."

Bu cümle `image_url` / `video_url` alanlarını kullanan **akış** için geçerlidir.
Aynı rehberin "Resumable Upload Session" bölümü ise açıkça şunu söyler:

> "The following file sources are supported for uploaded video files:
> * A file located on your computer
> * A file hosted on a public facing server, such as a CDN"

ve yerel dosya örneğini verir:

```bash
--data-binary "@my_video_file.mp4"
```

**Sonuç:** Resumable yolunda herkese açık URL gerekmez. Yerel dosya
doğrudan gönderilebilir. Bu, uygulamanın mimarisini doğrudan etkiler ve
`SP_PUBLIC_BASE_URL` zorunluluğunu düşürme gerekçesidir.

### 1.4 Uçtan uca akış

| # | Çağrı | Ne yapar |
| --- | --- | --- |
| 1 | OAuth | Page access token + `/{page-id}?fields=instagram_business_account` ile IG user id |
| 2 | `GET /me/accounts` | Kullanıcının yönettiği Page'leri listeler |
| 3 | `GET /{page-id}?fields=instagram_business_account` | IG user id'yi bulur |
| 4 | `POST /{ig-user-id}/media` (`upload_type=resumable`, `media_type=REELS`) | Container + yükleme oturumu |
| 5 | `POST https://rupload.facebook.com/ig-api-upload/v26.0/{container_id}` | İkili gövdeyi yükler |
| 6 | `GET /{container_id}?fields=status_code,status` | Hazır olma durumu |
| 7 | `POST /{ig-user-id}/media_publish` | Yayınlar, `media_id` döner |
| 8 | `GET /{ig-media-id}?fields=permalink` | Kalıcı bağlantı |

**Container durumları (`GET /{IG_CONTAINER_ID}?fields=status_code`):**

| Değer | Anlamı |
| --- | --- |
| `IN_PROGRESS` | Container hâlâ hazırlanıyor |
| `FINISHED` | Container ve medya nesnesi yayına hazır |
| `PUBLISHED` | Yayınlanmış |
| `ERROR` | Yayın süreci başarısız |
| `EXPIRED` | 24 saat içinde yayınlanmadı, container öldü |

> Resmî yoklama talimatı: **dakikada bir, en fazla 5 dakika.**

`media_publish` cevabı:

```json
{ "id": "<IG_MEDIA_ID>" }
```

### 1.5 Container ömrü

`EXPIRED` tanımı: "The container was not published within 24 hours and has
expired." → **Container ömrü 24 saat.** Yapılandırma değişikliği, yeniden
bağlantı, onay beklenmesi gibi bir gecikme container'ı öldürür.

### 1.6 Reels teknik şartları

| Özellik | Değer |
| --- | --- |
| Kapsayıcı | MOV, MP4 (`moov` atomu başta olmalı) |
| Video kodek | H.264, HEVC |
| Ses kodek | AAC, 48 kHz, 128 kbps |
| Bit hızı | VBR, en fazla 25 Mbps |
| Kare hızı | **23 – 60 fps** |
| Çözünürlük | Yatayda **en fazla 1920 piksel** |
| Süre | 3 saniye – 15 dakika |
| Dosya boyutu | **300 MB** |
| Caption | 2200 karakter |
| En-boy oranı | API'de zorunluluk yok; 9:16 bu uygulamanın ürün kararı |

### 1.7 ⚠️ Kota çelişkisi — üç farklı sayı

Bu, Instagram tarafındaki en tehlikeli belirsizliktir. **Tek sayı yoktur.**

| Kaynak | Sayı | Kapsam |
| --- | --- | --- |
| Content Publishing rehberi, "Rate Limit" | **100** / 24 saat | "API-published posts", carousel 1 sayılır. `POST /{IG_ID>/media_publish` üzerinde uygulanır |
| Aynı rehber, "Carousel" sınırlamaları | **50** / 24 saat | "Accounts are limited to 50 published posts" |
| `content_publishing_limit` referansı | **`quota_total: 50`**, `quota_duration: 86400` | Endpoint'in canlı cevabında döndürdüğü değer |
| Instagram Platform Overview, "Rate Limiting" | `4800 × Impressions` / 24 saat | Uygulama **çağrı** sayısı (app+appUser çifti başına, hareketli pencere) |

Endpoint referansının `quota_total` tanımı birebir: "The maximum number of IG
Containers the app user can publish within the `quota_duration` time period
(**currently `50`**)."

`POST /v2/post/publish/...` tarafındaki 50/100 farkı tek bir yerde açıklanmıyor.
`quota_total` alanı "currently" diye yazıldığı için **değişebilir** demektir.

**Karar (sabit kod yazma):** Yayından **önce** kotayı canlı oku:

```http
GET https://graph.facebook.com/v26.0/<IG_USER_ID>/content_publishing_limit
    ?fields=quota_usage,config
    &since=<UNIX_TIMESTAMP>
    &access_token=<ACCESS_TOKEN>
```

```json
{
  "data": [
    {
      "quota_usage": 2,
      "config": { "quota_total": 50, "quota_duration": 86400 }
    }
  ]
}
```

`since` parametresi: "A Unix timestamp **no older than 24 hours**." `fields`
verilmezse yalnız `quota_usage` döner.

> **Sonuç:** Koda `50` veya `100` yazma. `QuotaSnapshot` okuyup
> `used / total / windowSec` karşılaştır. Kota yoksa işi ertele.
> Uygulamanın `PublishAdapter.readQuota?` portu tam olarak bu iş için var.

### 1.8 İzinler

| İzin | Publish için | Not |
| --- | --- | --- |
| `instagram_content_publish` | **ZORUNLU** | Facebook Login yolunda |
| `instagram_basic` | **ZORUNLU** | Facebook Login yolunda |
| `pages_read_engagement` | **ZORUNLU** | Facebook Login yolunda |
| `pages_show_list` | Belirsiz | Aşağıya bak → *Bilinmeyenler* |
| `ads_management` / `ads_read` | Koşullu | Page rolü Business Manager'dan verilmişse |
| `business_management` | **GEREKMEZ** | Publish için gerekli değil |
| `instagram_manage_insights` | Hayır | Yalnız Insights/analitik için |
| `instagram_manage_contents` | Hayır | Yalnız `DELETE /{ig_media_id}` silme için |

`business_management` publish için gerekmiyor. Bu, Business Manager'a bağlı
Page'lerde bile `ads_management`'a düşmediğiniz sürece sorun olmadığı anlamına
gelir.

### 1.9 App Review — kendi hesabınıza yayın yapıyorsanız GEREKMEZ

Bu, kurulum süresini en çok kısaltan cümle.

> "If your app will only be used by app users who have a role on the app itself,
> App Review is not required."

> "All Business, Consumer, and Gaming apps are automatically approved for
> **Standard Access** for all permissions and features. Advanced Access,
> however, must be approved on an individual permission and feature basis
> through the App Review process."

**Yorum:** Bu uygulama, kullanıcının **kendi yönettiği** profesyonel
hesaplarına yayın yapıyor. Bu, "role on the app itself" koşuluna girer →
**Standard Access yeterli, App Review gerekmez.** Bu yüzden Meta kurulumu
TikTok'a kıyasla günler değil, dakikalar sürer.

**Advanced Access ne zaman gerekir:** Başkasının profesyonel hesabına
yayın yapacaksan. O zaman Business Verification + App Review gerekir.
Business Verification, "As of February 1, 2023" Advanced Access için
zorunlu hale geldi. Advanced Access alan uygulamalar ayrıca yıllık
**Data Use Checkup** tamamlamak zorundadır.

**Advanced Access istenirse nelere dikkat:**

- Her izin için **ekran kaydı zorunlu.** "Any requested permission or feature
  missing a screen recording will not be approved."
- "Make at least 1 successful API call using each permission for which you are
  requesting advanced access. Calls must be made within **30 days** of
  submitting."
- "If we are unable to access your app to test it, **your entire submission will
  be rejected**." → localhost bir uygulamayı test edemezler. Erişilebilir
  bir demo ortamı gerekir.
- "Make sure your app is in Development mode or is a Business app type."

### 1.10 Ön koşullar

| Koşul | Durum |
| --- | --- |
| IG hesabı Profesyonel (Business veya Creator) | Zorunlu |
| IG hesabı bir Page'e bağlı | Zorunlu (Facebook Login yolu) |
| Kullanıcının Page'te `MANAGE` veya `CREATE_CONTENT` rolü | Zorunlu |
| Page 2FA açıksa kullanıcı da 2FA yapmış olmalı | Zorunlu |
| **Page Publishing Authorization (PPA)** tamamlanmış | **Yeni, zorunlu olabilir** |

**PPA (yeni bulgu, brief'de yoktu):** "An Instagram professional account
connected to a Page that requires **Page Publishing Authorization** cannot be
published to until PPA has been completed." Bir Page önce PPA gerektirmiyor
olabilir ama sonra gerektirebilir; uygulama bunu önceden tespit edemez.
Meta, kullanıcılara PPA'yı önceden tamamlamalarını tavsiye ediyor.

**Ayrıntı:** Kanal grupları gibi başka bir Meta kontrolü bu yolda yok —
Page sayısı sınırı, Page başına kota gibi ek kısıtlar resmî belgede geçmiyor.

### 1.11 AI etiketi

Container oluştururken `is_ai_generated` alanı gönderilir:

```bash
curl -X POST "https://graph.facebook.com/v26.0/<IG_USER_ID>/media" \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -d "image_url=<IMAGE_URL>" \
     -d "caption=<CAPTION>" \
     -d "is_ai_generated=true"
```

- Her iki giriş yolunda da var.
- Carousel'da **yalnız carousel container'ına** konur. Çocuk container'a
  konursa hata döner.
- Bu uygulamanın `AiDisclosure.instagramIsAiGenerated` alanı doğrudan buraya
  gider.

### 1.12 Reels mi, video mu — `media_type` tuzağı

> "If you publish a reel and then request its `media_type` field, the value
> returned is `VIDEO`. To determine if a published video has been designated
> as a reel, request its **`media_product_type`** field instead."

Yani `GET /{ig-media-id}?fields=media_type` sorgusuna `VIDEO` dönmesi hata
değildir. Reels ayrımı için `media_product_type` okunmalıdır.

### 1.13 Silme

```http
DELETE https://graph.facebook.com/v26.0/<IG_MEDIA_ID>
```

Gerekli izin: `instagram_manage_contents`.

### 1.14 ⚠️ Sürüm tuzağı

| Olgu | Tarih |
| --- | --- |
| Yayın **Graph API v26.0** | v26.0 blog duyurusu, 29 Temmuz 2026 |
| **v20.0 kaldırıldı** | **24 Eylül 2026** |
| **v21.0 kaldırılacak** | **21 Ocak 2027** |
| `media_type=VIDEO` desteği | 9 Kasım 2023'ten beri yok |
| Sürüm ömrü | "Each version is guaranteed to operate for at least two years" |

**Karar:** Graph API sürümünü koda sabit yaz (`v26.0`). Sürümsüz çağrı, paneldeki
"Upgrade API Version" ayarına bağlıdır ve sessizce başka bir sürüme düşer.
Ayrıca sürümü tek bir sabitte tut ve kaldırma tarihleri için bir izleme notu bırak.

> **Dikkat:** `v21.0` için kaldırma tarihi **21 Ocak 2027**'dir. Yani
> `v26.0`'ya geçtiğinizde önünüzdeki sürüm emekli olmadan önce bir kez daha
> geçmeniz gerekecek.

### 1.15 Önemli hata kodları

| Kod / alt kod | Anlam | Sınıf |
| --- | --- | --- |
| `9/2207042` | "You reached maximum number of posts that is allowed to be published by Content Publishing API." → ertesi gün tekrar dene | **KALICI (bugün)** |
| `4/2207051` | Spam koruması tetiklendi | **KALICI** |
| `25/2207050` | Hesap kısıtlandı | **KALICI** |
| `-2/2207003` | İndirme zaman aşımı | **GEÇİCİ** |
| `36000` / `2207004` | "The image is too large to download. It should be less than {size}." | KALICI (içerik) |
| `80002` | İş kullanımı (BUC) rate limit | **GEÇİCİ** |
| `80000` / `2446079` | BUC kotaya ulaşıldı | **GEÇİCİ** |
| `debug_info.retriable: true` | Yükleme hatası, tekrar denenebilir | **GEÇİCİ** |

**`9/2207042` neden "kalıcı"?** Meta'nın metni "try again the following day"
diyor. Bugün yeniden denemek anlamsız; işi ertesi güne ertelemek gerekir. Bu,
"kalıcı hata → işi kuyruktan çıkar" kuralıyla çelişir; bu yüzden uygulama
tarafında `quota` sınıfı, `nextAttemptAt` dolduğunda yeniden kuyruğa alınacak
şekilde ele alınmalıdır.

### 1.16 Rate limit (publish dışı, çağrı sayısı)

Instagram Platform endpoint'lerine yapılan çağrılar ayrı bir sayaçla sınırlıdır:

```
Calls within 24 hours = 4800 × Number of Impressions
```

- Uygulama + uygulama kullanıcısı çifti başına ayrı sayılır.
- Hareketli 24 saatlik pencere.
- `Impressions`, uygulama kullanıcısının IG profesyonel hesabından herhangi bir
  içeriğin son 24 saatte bir kişinin ekranına girdiği sayıdır.
- Bu sayaç **publish kotasından farklıdır.** Publish kotası 50/100 iken bu
  çağrı sayacıdır.
- Meta webhook kullanmanın bu yüzden önerdiğini söylüyor: "Using webhooks will
  reduce the number of needed API calls made by your app."

> **Yorum:** Yeni ve düşük etkileşimli bir hesapta "Impressions" düşükse
> çağrı tavanı da düşük olur. Bu, yayın hızını sınırlayan ikinci bir darboğaz
> olabilir. Kesin uygulanabilir sayı yok — *Bilinmeyenler*.

### 1.17 Instagram — Bilinmeyenler

Resmî dokümanda bulunamadı. Tahmin edilmedi.

| # | Doğrulanamayan | Not |
| --- | --- | --- |
| 1 | Meta localhost / tünel / IP adresini kabul ediyor mu | Hiçbir yerde ifade yok. Yalnız App Review için "we need to be able to access your app" deniyor |
| 2 | HTTPS zorunlu mu | Doküman yalnız "public server" diyor; `http://` veya `https://` ayrımı yapmıyor |
| 3 | `is_ai_generated` cezasının niteliği | Aynı belgede "may apply penalties" ifadesi geçmiyor; hangi cezanın uygulanacağı yazılı değil |
| 4 | `is_ai_generated` zorunluluğunun başlangıç tarihi | Brief'te 22 Haziran 2026 deniyor; okuduğum Content Publishing sayfasında **tarih yok**, alan yalnız mevcut |
| 5 | App Review gerçek süresi | Resmî metin yok. "1 haftadan az, genelde 2-3 gün" ifadesi belgede bulunamadı |
| 6 | `quota_total` 50 iken rehberdeki 100'in kaynağı | Aynı rehber içinde iki sayı; hangisinin esas olduğu yazılı değil |
| 7 | `4800 × Impressions` sayacının pratik tabanı | Yeni hesapta kaç çağrıya izin verildiği belirtilmiyor |
| 8 | `pages_show_list` publish için gerekli mi | Content Publishing'in izin tablosunda **yok**. Permissions Reference ve Access Verification listelerinde var → *aşağıdaki not* |
| 9 | Resumable yüklemede HTTP durum kodu | Başarı/başarısızlık örnekleri HTTP kodu vermeden verilmiş; yalnız JSON gövdesi var |
| 10 | `rupload` yüklemesinde maksimum dosya boyutu / offset devamlılığı | `offset` ve `file_size` belirtilmiş ama **devam etme (resume) protokolü** (hangi offset'ten devam edileceği, hata cevabında offset dönüp dönmediği) anlatılmamış |
| 11 | Container oluşturma limiti | Brief'te 400/24 saat deniyor; okuduğum belgelerde bu sayı geçmiyor |

> **`pages_show_list` notu:** Bu izin gerçek bir Meta iznidir
> (Permissions Reference'ta `leads_retrieval` bağımlılığı olarak, Access
> Verification listesinde de görünüyor). Ama Content Publishing rehberinin
> izin tablosunda yer almıyor. `GET /me/accounts` çağrısı için gerekli
> olabilir; belgeden doğrulanamadı. **Güvenli taraf:** iste. Zararı yok,
> doğrulanmamış tek gereklilik olarak işaretle.

> **`rupload` devam protokolü notu:** Yükleme 300 MB'a kadar tek PUT ile
> gönderilebilir. Kesilme halinde `offset` header'ı ile kaldığı yerden
> gönderilebileceği endpoint'in adından anlaşılıyor, ama resmî cevap
> biçimi (sunucu kaldığı offset'i bildiriyor mu) belgede yok. Ağ kesintisi
> senaryosu kendi testinizle doğrulanmalı.

---

## 2. TikTok — Content Posting API

> Bu kısım **30 Eylül 2026** itibarıyla resmî dokümanlardan doğrulanmıştır.
> Okunan sayfalar: Get Started – Direct Post (4 Ağustos 2026), Direct Post API
> referansı (24 Ağustos 2026), Upload Video referansı, Get Post Status
> referansı (4 Ağustos 2026), Media Transfer Guide, Content Sharing Guidelines.

### 2.1 İki yayın modu

TikTok'un Content Posting API'sinde iki ayrı uç nokta var. Karıştırmayın.

| | Direct Post | Upload (inbox) |
| --- | --- | --- |
| Uç nokta | `POST /v2/post/publish/video/init/` | `POST /v2/post/publish/inbox/video/init/` |
| Scope | **`video.publish`** | **`video.upload`** |
| Sonuç | Doğrudan profilde yayınlanır | Creator'ın inbox'una taslak gider, creator TikTok'ta yayınlar |
| Bu uygulama | **Bunu kullan** | Kullanma |

Durum kodları ayırt eder: `SEND_TO_USER_INBOX` yalnız upload akışında görülür.

### 2.2 Public URL gerekmiyor — ama resmî öneri tersini söylüyor

`source_info.source` iki değer alır:

| Değer | Ne yapar | Alan mülkiyeti doğrulaması |
| --- | --- | --- |
| `FILE_UPLOAD` | İkili gövdeyi `upload_url`'ye `PUT` edersin | **Gerekmez** |
| `PULL_FROM_URL` | TikTok senin URL'inden çeker | **Gerekli** — "Manage URL properties" akışından |

`FILE_UPLOAD` teknik olarak public URL istemiyor. **Ancak** Content Sharing
Guidelines şunu söylüyor:

> "PULL_FROM_URL should be used when API Clients already have the to-be-posted
> contents on server-side file storage services."
>
> "FILE_UPLOAD should be used when the to-be-posted video is on the **users'
> devices** (PC, Mac, Switch, etc) of API Clients."
>
> "**If video resources are already on API Clients' servers, do not use
> FILE_UPLOAD; use PULL_FROM_URL instead.**"

**Yorum (önemli):** Bu uygulamanın videoları **sunucu diskinde** duruyor, bir
kullanıcının telefonunda değil. TikTok'un ürün rehberi bu durumda açıkça
`PULL_FROM_URL` diyor. Yani teknik olarak `FILE_UPLOAD` çalışır, ama
**ürün-politika uyumu tartışması doğurur** — denetim (audit) sırasında ve
red sürecinde karşı çıkılacak nokta bu olabilir.

Bu, uygulamanın mimari kararını etkiler: `SP_PUBLIC_BASE_URL` yalnız
"arayüze uzaktan erişim" için değil, **TikTok PULL_FROM_URL yolu** için de
anlam kazanır. Her iki durumda da tünel gerekebilir.

### 2.3 Uçtan uca akış

**Adım 1 — creator_info (ZORUNLU, her yayında):**

```http
POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
Authorization: Bearer <AccessToken>
Content-Type: application/json; charset=UTF-8
```

```json
{
  "data": {
    "creator_avatar_url": "<creator avatar CDN URL>",
    "creator_username": "tiktok",
    "creator_nickname": "TikTok Official",
    "privacy_level_options": ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    "comment_disabled": false,
    "duet_disabled": false,
    "stitch_disabled": true,
    "max_video_post_duration_sec": 300
  },
  "error": { "code": "ok", "message": "", "log_id": "202210112248442CB9319E1FB30C1073F3" }
}
```

> `max_video_post_duration_sec` **creator'a göre değişir** (ör. 300). Guidelines
> bunu zorunlu kılar: "When posting a video, API clients **must check** if the
> duration of the to-be-posted video follows the `max_video_post_duration_sec`
> returned in the creator_info API." → Bu, sabit 3 dakika kuralından üstündür.

> `privacy_level_options` **arayüzde gösterilmek zorundadır.** Yanlış
> seçilirse 403 `privacy_level_option_mismatch` döner ve TikTok bunu
> "violations to TikTok's product-use guidance" olarak niteler.

**Adım 2 — init:**

```http
POST https://open.tiktokapis.com/v2/post/publish/video/init/
Authorization: Bearer <AccessToken>
Content-Type: application/json; charset=UTF-8
```

```json
{
  "post_info": {
    "title": "this will be a funny #cat video on your @tiktok #fyp",
    "privacy_level": "MUTUAL_FOLLOW_FRIENDS",
    "disable_duet": false,
    "disable_comment": true,
    "disable_stitch": false,
    "video_cover_timestamp_ms": 1000,
    "is_aigc": true
  },
  "source_info": {
    "source": "FILE_UPLOAD",
    "video_size": 50000123,
    "chunk_size": 10000000,
    "total_chunk_count": 5
  }
}
```

```json
{
  "data": {
    "publish_id": "v_pub_file~v2-1.123456789",
    "upload_url": "https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123"
  },
  "error": { "code": "ok", "message": "", "log_id": "202210112248442CB9319E1FB30C1073F3" }
}
```

> `upload_url` **1 saat geçerli**: "The upload_url is valid for one hour after
> issuance. The upload must be completed in this time range."
> `publish_id` en fazla 64 karakter, `upload_url` en fazla 256 karakter.
> Bu yüzden `upload_url` kalıcı veri tabanında **saklanmamalı**, saat damgasıyla
> geçerlilik kontrol edilmelidir. `TranscodePreset.providerUploadUrlTtlSec`
> portu tam olarak bunun için var.

**Adım 3 — parçalı yükleme:**

```bash
curl -X PUT 'https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123' \
  -H 'Content-Range: bytes 0-30567099/30567100' \
  -H 'Content-Length: 30567100' \
  -H 'Content-Type: video/mp4' \
  --data '@/path/to/file/example.mp4'
```

`Content-Type` yalnız `video/mp4`, `video/quicktime`, `video/webm` olabilir.
`Content-Range` ve `Content-Length` **zorunludur.**

> **Yorum:** Uygulamanın `ResolvedCopy.coverAtPercent` alanı bir **yüzde**
> tutuyor, TikTok ise `video_cover_timestamp_ms` (milisaniye) istiyor. Adaptör
> sınırında `mediaInfo.durationSec × coverAtPercent / 100 × 1000` dönüşümü
> yapılmalı. Bu dönüşüm `domain`de değil `adapters/`de olmalı.

**Adım 4 — durum:**

```http
POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
Authorization: Bearer <AccessToken>
Content-Type: application/json; charset=UTF-8
```

```json
{ "publish_id": "v_pub_file~v2-1.123456789" }
```

```json
{
  "data": {
    "status": "FAILED",
    "fail_reason": "picture_size_check_failed",
    "publicaly_available_post_id": [],
    "uploaded_bytes": 10000
  },
  "error": { "code": "ok", "message": "", "log_id": "202210112248442CB9319E1FB30C1073F3" }
}
```

| Durum | Anlamı |
| --- | --- |
| `PROCESSING_UPLOAD` | Yalnız `FILE_UPLOAD`. Yükleme sürüyor |
| `PROCESSING_DOWNLOAD` | Yalnız `PULL_FROM_URL`. İndirme sürüyor |
| `SEND_TO_USER_INBOX` | Yalnız upload akışı. Taslak creator'a gitti |
| `PUBLISH_COMPLETE` | **Bitti** |
| `FAILED` | Hata. `fail_reason` tablosuna bak |

`uploaded_bytes`: 1-indeksli yüklenen bayt sayısı. Yükleme ilerlemesini
takip etmek için kullanılabilir.

### 2.4 Chunk kuralları

| Kural | Değer |
| --- | --- |
| Parça boyutu | En az **5 MB**, en fazla **64 MB** |
| Son parça | `chunk_size`'ı aşabilir, **128 MB**'ye kadar |
| Parça sayısı | 1 – **1000** |
| Gönderim | **SIRALI** (chunk_id sırayla ilerlemeli) |
| Ara parça cevabı | **206 Partial Content** |
| Son parça cevabı | **201 Created** |
| Toplam boyut | En fazla 4 GB |

`total_chunk_count` formülü — bu satır koda yazılmalı:

```
total_chunk_count = floor(video_size / chunk_size)
```

**Kenardurum (dokümanın açıkça söylediği kural):**

> "Videos with a total size less than 5 MB must be uploaded as a whole, with
> `chunk_size` equal to the entire video's byte size. Videos with a total size
> greater than 64 MB must be uploaded in multiple chunks."

Yani 5 MB altı video için "en az 5 MB" kuralı **uygulanmaz**; tek parça
gönderilir. 5–64 MB arası da tek parça olabilir. 64 MB üstü çok parça.

### 2.5 Teknik sınırler

| Özellik | Değer |
| --- | --- |
| Kapsayıcı | MP4 (**önerilen**), WebM, MOV |
| Video kodek | H.264 (**önerilen**), H.265, VP8, VP9 |
| Kare hızı | **23 – 60 fps** |
| Çözünürlük | Her iki eksende **360 – 4096** piksel |
| Süre — akış | "All TikTok creators can post **3-minute** videos" |
| Süre — yükleme | "The longest video a developer can send ... is **10 minutes**" |
| Dosya boyutu | En fazla **4 GB** |
| Başlık | 2200 UTF-16 rune |
| En-boy oranı | **API'de zorunluluk YOK** — dokümanda aspect kısıtı yok |

> Süre kuralında iki sınır var ve ikisi de doğrulanmış: akış 3 dakika,
> yükleme 10 dakika. Uygulamanın `tiktok.ts` spec'indeki `duration` (3–10 dk)
> ve `duration_in_feed` (≤3 dk) ayrımı resmî tabloyla birebir örtüşüyor.
> Yine de gerçek sınır creator'ın `max_video_post_duration_sec` değeridir.

> 9:16 zorunluluğu **yoktur.** Bu uygulamanın `aspectWarningRule` uyarı
> üretmesi doğru davranıştır: platform kısıtı değil, ürün kararı. Kuralı
> `provisional` işaretli tutmak doğru.

### 2.6 Hız sınırları

| Uç nokta | Sınır |
| --- | --- |
| `POST /v2/post/publish/video/init/` | **6 / dakika** / kullanıcı token'ı |
| `POST /v2/post/publish/status/fetch/` | **30 / dakika** / kullanıcı token'ı |
| `POST /v2/post/publish/creator_info/query/` | 20 / dakika |

429 cevabı: `rate_limit_exceeded`.

> `SP_PUBLISH_CONCURRENCY=1` varsayılanı bu sınırlar için doğru. Tek hesapla
> çalışan bir kurulumda saniyede birden çok init atmak 6/dk sınırını aşar.

### 2.7 `fail_reason` — geçici mi kalıcı mı

Bu tablo, uygulamanın `isRetryableKind` kararının tek dayanağıdır.

| `fail_reason` | Sınıf | Dayanak |
| --- | --- | --- |
| `internal` | **GEÇİCİ** | "This is a **retryable** error." |
| `video_pull_failed` | **GEÇİCİ** | "**a retry is recommended**" |
| `photo_pull_failed` | **GEÇİCİ** | "a retry is recommended" |
| `file_format_check_failed` | KALICI | Desteklenmeyen medya formatı |
| `duration_check_failed` | KALICI | Süre kuralına uymuyor |
| `frame_rate_check_failed` | KALICI | Desteklenmeyen kare hızı |
| `picture_size_check_failed` | KALICI | Desteklenmeyen görsel boyutu |
| `spam_risk_too_many_posts` | KALICI | "Try to post the videos from the TikTok Mobile App." |
| `spam_risk_user_banned_from_posting` | KALICI | "**Retry should not be done.**" |
| `spam_risk_text` | KALICI | "**Retry should not be done.**" |
| `spam_risk` | KALICI | "**Retry should not be done.**" |
| `auth_removed` | KALICI | "**Retry should not be done.**" |
| `publish_cancelled` | KALICI | Geliştirici iptal etti |

**HTTP hata kodları:**

| HTTP | `error.code` | Anlam | Sınıf |
| --- | --- | --- | --- |
| 400 | `invalid_param` | Gövde hatalı | KALICI |
| 400 | `invalid_publish_id` | `publish_id` yok | KALICI |
| 400 | `token_not_authorized_for_specified_publish_id` | Token bu `publish_id`'ye yetkili değil | KALICI |
| 401 | `access_token_invalid` | Token süresi dolmuş/geçersiz | Özel → yeniden yetkilendir |
| 401 | `scope_not_authorized` | `video.publish` izni yok | KALICI |
| 403 | `reached_active_user_cap` | Günlük aktif kullanıcı kotası doldu | KALICI (bugün) |
| 403 | `unaudited_client_can_only_post_to_private_accounts` | Denetim geçilmemiş istemci | KALICI (yapısal) |
| 403 | `url_ownership_unverified` | `PULL_FROM_URL` alan adı doğrulanmamış | KALICI (yapısal) |
| 403 | `privacy_level_option_mismatch` | Gizlilik seçeneği creator_info ile uyuşmuyor | KALICI (kod hatası) |
| 403 | `spam_risk_too_many_posts` | Günlük post kotası doldu | KALICI (bugün) |
| 429 | `rate_limit_exceeded` | Hız sınırı | **GEÇİCİ** |
| 5xx | — | TikTok sunucu/ağ hatası | **GEÇİCİ** |

**Sonsuz döngü tuzağı:** `auth_removed` için TikTok açıkça "Retry should not be
done" diyor. Bu `fail_reason` `RETRYABLE_ERROR_KINDS` içine yanlışlıkla girerse
iş sonsuza kadar kuyrukta döner ve kullanıcının token'ı gereksiz yere
tükenir.

### 2.8 AI etiketi

`post_info.is_aigc = true` → "the video will be labelled with **Creator labeled
as AI-generated** tag in video's description." Varsayılan `false`. Alan
`post_info` içindedir, `source_info` içinde değil.

### 2.9 ⚠️ `share_url` API'de dönmez

Bu, uygulamanın durum makinesini doğrudan etkileyen bir kısıttır.

- `status/fetch` cevabındaki `publicaly_available_post_id` **yalnız** herkese
  açık yayınlanmış içerik için dolu gelir: "post_id is returned **only if** the
  post is published for public viewership and **has been approved by the TikTok
  moderation process**."
- Denetimden geçmemiş istemci `SELF_ONLY` yayın yapar → `post_id` hiç gelmez.
- Kalıcı bağlantı için `/v2/video/query/` (`video.list` scope) gerekir ve o da
  yalnız herkese açık içerik için çalışır.

**Sonuç:** TikTok'ta `published` ile `published_no_link` ayrımı zorunludur.
Uygulamanın `JobState` içindeki `published_no_link` ve `MetricSet.unavailable`
alanları (`reason: "not_public"`) tam olarak bu boşluk için var.

**Moderation süresi:** "Moderation usually finishes within one minute. In some
cases, moderation may take a few hours." Yani birkaç saat bekleyen bir iş
normaldir — `processing` durumunda sonsuza kadar beklememek, bir üst
noktada `published_no_link`'e düşmek gerekir.

**İşlem süreleri (tahmin değil, doküman tablosu):**

| Boyut | Ortalama süre |
| --- | --- |
| 512 MB | Yarım dakikadan az |
| 1 GB | Yaklaşık 1 dakika |
| 4 GB | 2 dakikadan fazla |

> "The time taken in any given stage can vary by use cases and **a time limit
> is not guaranteed**." → Zaman aşımı koymak doğru ama kısa tutmak yanlış.

### 2.10 Webhook'lar — yoklama yerine (yeni bulgu)

Get Post Status sayfası iki mekanizma tanımlıyor: **Fetch Status endpoint** ve
**Content Posting webhooks**. Webhook'lar uygulamanın dashboard'unda kayıtlı
URL'ye gönderilir.

| Olay | Alanlar | Anlamı |
| --- | --- | --- |
| `post.publish.failed` | `publish_id`, `reason`, `publish_type` | Yayın başarısız |
| `post.publish.completed` | `publish_id`, `publish_type` | İçerik yayınlandı |
| `post.publish.publicly_available` | `publish_id`, `post_id`, `publish_type` | **Herkese açık oldu — `post_id` burada gelir** |
| `post.publish.no_longer_publicaly_available` | `post_id`, `publish_type` | Artık herkese açık değil |
| `post.publish.inbox_delivered` | `publish_id`, `publish_type` | Taslak creator inbox'una gitti |

**Yorum (mimari olarak önemli):** `post.publish.publicly_available` olayı,
`publicaly_available_post_id` değerini **itmeden** almanın tek yoludur.
`status/fetch` 30/dk sınırına tabidir ve `post_id` yalnız moderasyon
tamamlandıktan sonra döner. Webhook varsa yoklamaya gerek kalmaz; yoksa
`status/fetch` + gerçekçi bir bekleme penceresi gerekir.

Bu uygulama şu an webhook altyapısı içermiyor; `app/src/http` katmanında
eklenmesi bir sonraki iş paketidir.

### 2.11 Token ömrü

| Değer | Süre |
| --- | --- |
| Access token | **24 saat** |
| Refresh token | **365 gün** |

**Zorunlu kural:** Dönen `refresh_token` girdiğinden **farklı olabilir** ve
yenisiyle **değiştirilmek ZORUNDADIR.** `null` dönmesi "koru" demek değildir,
"bu sefer dönmedi" demektir. İkisi ayrı durumdur.

Uygulamanın `RefreshOutcome.refreshToken` sözleşmesinde bu ayrım zaten var:
`null` = eskiyi koru, non-null = değiştir. `CredentialRecord.rotatedAt` alanı
"eski refresh token geçersizleşti" kuralını taşır.

### 2.12 Denetim (audit) geçmemiş istemci

> "All content posted by unaudited clients will be restricted to **private
> viewing mode**."

General Guidelines, denetim geçene kadar üç kısıt koyuyor:

| Kısıt | Değer |
| --- | --- |
| Kullanıcı tavanı | "Unaudited API Clients can allow up to **5 users** to post in a **24 hour window**" |
| Görünürlük | "Unaudited API Clients can only post contents in **`SELF_ONLY`** viewership" |
| Hesap görünürlüğü | "All user accounts using the API client to post must be set to **private** at the time of posting" |

**Denetimden geçtikten sonra ne yapılmalı:**

> "To make the contents publicly viewable later on, the account owner must
> **first change their account visibility to public, and then change the
> privacy settings of each content to 'Everyone.'**"

İki ayrı adım, hesap sahibinin yapması gerekiyor. Otomasyonla yapılamaz.

**API hata seviyesindeki karşılıkları:** `reached_active_user_cap` (günlük
aktif kullanıcı kotası) ve `unaudited_client_can_only_post_to_private_accounts`
(403, init'te bloklar).

**Yorum:** "5 kullanıcı / 24 saat" sınırı uygulamanın ölçeğiyle uyumsuz.
Bu, denetimin sadece "kayıt" değil **ürün engeli** olduğu anlamına gelir.

### 2.13 Sandbox

| Kural | Değer |
| --- | --- |
| Sandbox sayısı | Uygulama başına en fazla **5** |
| Kullanıcı sayısı | Sandbox başına **10** |
| Public yayın | **YASAK** |

> "Sandbox mode does not offer access to Content Posting API for public videos."

**Yorum:** Sandbox geliştirme için kullanışlı, ama gerçek yayın testi
**gerçek kullanıcı hesabıyla** yapılmalı — ve o hesap denetim geçene kadar
`SELF_ONLY` görecek. Bu, "yayın çalışıyor mu" sorusunun ilk gerçek cevabının
olmayacağı anlamına gelir; yalnız "istek kabul edildi ve private yayınlandı"
doğrulanabilir. Entegrasyon testlerinde buna göre beklenti yazılmalı.

### 2.14 Ek kural — pending paylaşım tavanı (yeni)

Upload akışı için: "To reduce spamming, TikTok limits the number of videos
that can be uploaded via API that are not pending approval and posting by the
creator. There may be at most **5 pending shares within any 24-hour period**."

Bu kural doğrudan uygulanmasa bile (Direct Post kullanıyoruz) inbox
kuyruğunun sızmadığını gösterir.

### 2.15 Fotoğraf desteği (yeni)

Content Posting API artık **fotoğraf** da destekliyor. Ayrı uç nokta:

```http
POST https://open.tiktokapis.com/v2/post/publish/content/init/
```

Gövdede `post_mode` (`DIRECT_POST` / `MEDIA_UPLOAD`) ve `media_type` (`PHOTO`)
zorunludur. `source_info.photo_images` bir dizi URL'dir, `photo_cover_index`
kapak seçer, `post_info.auto_add_music` vardır.

**Önemli:** Fotoğraflar `PULL_FROM_URL` + doğrulanmış alan adı ister. Bu
uygulama video yayınlıyor, ilgisi yok — ama "TikTok her şeyi URL ile yapar"
yanılgısına düşmemek için not düşüldü.

### 2.16 TikTok — Bilinmeyenler

| # | Doğrulanamayan | Not |
| --- | --- | --- |
| 1 | `Retry-After` header davranışı | 429 cevabında `Retry-After` header'ından **hiç** söz edilmiyor. `rate_limit_exceeded` yalnız hata kodunda. Bekleme süresi uygulama tarafında seçilmeli |
| 2 | Denetim (audit) başvuru süresi ve kriterleri | Resmî sayı yok. "Several days to two weeks" ifadesi brief'in kaynağında; okunan belgelerde doğrulanamadı |
| 3 | Denetim reddi sonrası itiraz yolu | Belgede yok |
| 4 | `is_aigc` etiketinin topluluk standardı karşılığı | TikTok dokümanı yalnız etiket metnini söylüyor, zorunluluk/ceza yok |
| 5 | Sandbox → production geçiş süreci | Limitler ve yasak var, **geçiş adımları yok** |
| 6 | `FILE_UPLOAD` ile sunucu diski kullanımının denetimde sorun yaratıp yaratmayacağı | Rehber "do not use FILE_UPLOAD" diyor ama bunu ihlal edenler için bir yaptırım belirtilmemiş → *Bilinmeyenler* |
| 7 | `/v2/video/query/` cevap şeması ve hız sınırı | Sayfa okunmadı; `video.list` scope'unun kesin davranışı belgelenmedi |
| 8 | `brand_content_toggle` / `brand_organic_toggle` semantiği | Alanlar var, "paid partnership to promote a third-party business" ve "creator's own business" tanımları var; ikisi birlikte kullanılırsa ne olur yazmıyor |
| 9 | Webhook imzalama/doğrulama yöntemi | Olaylar listelenmiş, güvenlik (secret, imza) anlatımı yok |
| 10 | `upload_url` 1 saat dolduğunda `publish_id` ne oluyor | Yeniden init mi, aynı `publish_id` mi kullanılacak yazmıyor |

---

## 3. YouTube — Data API v3

> Bu kısım **30 Eylül 2026** itibarıyla resmî dokümanlardan doğrulanmıştır.
> Okunan sayfalar: Videos: insert (14 Eylül 2026), Quota Calculator
> (15 Eylül 2026), Quota and Compliance Audits, YouTube Data API Overview
> (14 Eylül 2026), API Reference, Errors, `support.google.com/youtube`
> başvuru formu.

### 3.1 Yükleme akışı

```http
POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status
Authorization: Bearer <access_token>
Content-Type: application/json; charset=UTF-8
X-Upload-Content-Type: video/mp4
```

```json
{
  "snippet": {
    "title": "Reklam başlığı",
    "description": "Açıklama",
    "tags": ["etiket1", "etiket2"]
  },
  "status": {
    "privacyStatus": "private",
    "publishAt": "2026-10-01T09:00:00Z",
    "selfDeclaredMadeForKids": false,
    "containsSyntheticMedia": true,
    "license": "youtube"
  }
}
```

Cevap: **200** + `Location` header'ında session URI.

```http
PUT <Location-değeri>
Content-Type: video/mp4
Content-Length: 104857600
```

| Yükleme kısıtı | Değer |
| --- | --- |
| Dosya boyutu | En fazla **256 GB** |
| MIME | `video/*` veya `application/octet-stream` |

**Chunk:** Çok parçalı yüklemede chunk boyutu **256 KB'nin katı olmalıdır.**
YouTube **tek PUT'u önerir.** Bu uygulama 4 GB işletimsel tavanı koyduğu için
tek PUT pratikte sorun değil, ama kesilme kurtarması için chunk boyutu
matematiği `adapters/`de doğru yazılmalı.

### 3.2 ⚠️ KRİTİK: `videos.insert` artık 1600 birim değil

Bu, 2026'nın en çok sürpriz yapan değişikliğidir ve eski koddan kopyalanan
her yerde yanlıştır.

**Videos: insert referansı, birebir:**

> "Quota impact: **100 calls per day. A call to this method has a quota cost of
> 1 unit in the Video Uploads quota bucket.**"

**Quota Calculator sayfası, birebir:**

> "Projects that enable the YouTube Data API have a default quota allocation of
> **100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day
> combined for all other endpoints**."
>
> "The `search.list` and `videos.insert` methods have their **own quota
> buckets**. Each of these methods has a default daily limit of **100 per
> day**. The quota cost is **1 per call**."

**Bu yüzden iki ayrı kota kovası vardır:**

| Kova | Günlük | Çağrı başına |
| --- | --- | --- |
| **Video Uploads** (`videos.insert`) | 100 | 1 |
| **Search** (`search.list`) | 100 | 1 |
| **Diğer tüm endpoint'ler** (toplam) | 10 000 birim | değişken |

Günlük kota **Pasifik saatiyle gece yarısında** sıfırlanır.

> ⚠️ **Aynı sayfa kendi içinde çelişkili.** Quota Calculator sayfasının bir
> paragrafı hâlâ diyor ki: "methods like `videos.insert` have the **highest
> cost of 1600 points**." Bu, güncel olmayan bir artık metin. Aynı sayfanın
> tablosu "insert | 100 quota per day. Each call costs 1 quota." diyor ve
> `videos.insert` referans sayfası da 1 birim diyor.
>
> **Karar:** 1 birim doğrudur. Eski 1600 değeri **kaldırılmış, güncellenmemiş
> bir paragrafta kalmış.** Kodda 1600 yazıyorsa bu bir hatadır.

| Diğer yöntem | Birim |
| --- | --- |
| `videos.update` | 50 |
| `videos.list` | 1 |
| `videos.delete` | 50 |
| `thumbnails.set` | 50 |
| `channels.list` | 1 |

> "**All API requests, including invalid requests, incur at least a one-point
> quota cost.**" → Geçersiz istek de kota harcar. Yayın sırasında 400
> alıyorsanız kotanız yine azalır; hata ayıklamayı canlı ortamda yapmayın.

**Analytics API ayrı sistemdir** ve bu kotadan harcamaz. (`yt-analytics` kendi
kota yapısına sahiptir; detay bu belgenin kapsamı dışında.)

### 3.3 Scope'lar

| Scope | Durum |
| --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | **ZORUNLU** |
| `https://www.googleapis.com/auth/youtube.force-ssl` | **ZORUNLU** |

**Zorunluluk nedeni:** `videos.insert` referans sayfasının "Authorization"
tablosu `youtube.upload`, `youtube` ve `youtubepartner` ile birlikte
`youtube.force-ssl`'i de listeler. `force-ssl` olmadan istek `403` alır.

### 3.4 ⚠️ `videos.update` `youtube.upload`'u KABUL ETMEZ

Bu ayrı bir token gereksinimi:

- Yükleme `videos.insert` ile, `youtube.upload` scope'u ile yapılır.
- `privacyStatus` ve `publishAt` güncellemesi `videos.update` ile yapılır.
- **`videos.update` çağrısı için `youtube.upload` yetkisi yeterli DEĞİLDİR.**
  `youtube` (tam kapsam) veya en azından `youtube.force-ssl` gerekir.

**Sonuç:** Tek bir token elde etmek yetmez. Uygulamanın `AuthProvider.exchangeCode`
çağrısında `scopes` dizisi **her iki kapsamı da** içermelidir; yenileme akışı da
aynı seti korumalıdır. `scopes_json` kolonu (`credentials` tablosu) hangi
setin verildiğini kaydeder — yenileme bu listeye bakarak karar vermelidir.

### 3.5 ⚠️ YIKICI TUZAK: `part` ile gönderilmeyen alan SİLİNİR

`videos.update` semantiği:

> "The `part` parameter serves two purposes. It identifies the properties that
> the write operation will set as well as the properties that the API response
> will include."

**"will set"** — yani `part=status` gönderdiğinizde, `status` içindeki
**belirtmediğiniz her alan silinir.**

Somut örnek — bu hata yapılırsa:

```json
// ❌ YANLIŞ: selfDeclaredMadeForKids, containsSyntheticMedia, license SİLİNİR
{ "part": "status", "status": { "privacyStatus": "public" } }
```

```json
// ✅ DOĞRU: hedef part'ın TÜM alanları gönderilir
{
  "part": "status",
  "status": {
    "privacyStatus": "public",
    "selfDeclaredMadeForKids": false,
    "containsSyntheticMedia": true,
    "license": "youtube",
    "embeddable": true,
    "publicStatsViewable": true
  }
}
```

**Mimari sonuç:** `status` part'ı için gönderilecek gövde **kısmi (partial)
nesne olamaz.** Adaptör, `videos.insert` sırasında gönderdiği tüm `status`
alanlarını kalıcı olarak saklamalı ve `videos.update`'te **hepsini** geri
göndermelidir. Bu, `PublishJob` üzerinde ya da `contents.metadata_json`
içinde bir "last known status" alanı demektir. Ekran kartındaki AI
bildiriminin (`containsSyntheticMedia`) yayın sonrası bir `videos.update`
sırasında kaybolması, sessiz bir politika ihlalidir.

**Aynı kural `snippet` için de geçerlidir:** `part=snippet` ile yalnız
`title` gönderirseniz `description` ve `tags` silinir.

### 3.6 `status.publishAt` koşulları

**Zamanlama, ilk yüklemede `videos.insert` ile yapılır:**

```json
{
  "snippet": { "title": "..." },
  "status": {
    "privacyStatus": "private",
    "publishAt": "2026-10-01T09:00:00Z"
  }
}
```

Kurallar:

| Koşul | Durum |
| --- | --- |
| `privacyStatus` **`private`** olmalı | Zorunlu |
| Video **daha hiç yayınlanmamış** olmalı | Zorunlu |
| `publishAt` UTC olmalı | Zorunlu |
| Hata kodu | `invalidPublishAt` (400) — "The request metadata specifies an invalid scheduled publishing time" |

**Yorum:** Uygulamanın `StartResult` tipindeki `scheduled` varyantı tam olarak
bu yolu temsil eder ve yalnız YouTube için geçerlidir. Instagram ve TikTok
`supportsNativeSchedule: false` → zamanlama kendi iş kuyruğumuzda.

**Yarış koşulu:** `publishAt` dolduğunda YouTube videoyu otomatik `public`
yapmaz; `privacyStatus` "private" kalmalıdır, aksi halde video zamanında
görünmez. Yayın sonrası `videos.update` ile `privacyStatus` değiştirilmelidir —
ve o update'te **tüm status alanları** gönderilmelidir (§3.5).

### 3.7 `contentDetails.targetContentCategory` KALDIRILDI

`videos.insert` sayfasının "settable properties" listesi şunları içeriyor:

```
snippet.title, snippet.description, snippet.tags[], snippet.categoryId,
snippet.defaultLanguage, localizations.(key).title, localizations.(key).description,
status.embeddable, status.license, status.privacyStatus, status.publicStatsViewable,
status.publishAt, status.selfDeclaredMadeForKids, status.containsSyntheticMedia,
recordingDetails.recordingDate
```

`contentDetails.targetContentCategory` **bu listede yok.** Kaldırılmış.

`containsSyntheticMedia` **`status` altındadır**, `contentDetails` altında
**değildir.** Yanlış yere koymak sessizce yok sayılır.

### 3.8 Shorts

| Özellik | Değer |
| --- | --- |
| Süre | **En fazla 3 dakika** (60 saniye sınırı kaldırıldı) |
| En-boy | Kare (`16:9`, `1:1`, `4:3`) veya **dikey** (`9:16`) |
| `#Shorts` etiketi | **Resmî olarak ZORUNLU DEĞİL** |

**Yorum:** Uygulamanın `PlatformCopySchema.madeForShorts` alanı
`default(true)` — doğru varsayılan, ama "zorunlu" diye sunulmamalı. API
kılavuzunda zorunluluk dili yok.

**3 dakikayı aşan + Content ID iddiası olan video GLOBAL olarak bloke edilir**
(oynatılmaz, önerilmez). Otomatik yayıncıda bu şu demektir: 3 dakikayı aşan
bir içerik sessizce yayınlanabilir ama izlenemez. Buna karşı bir ön kontrol
konmalı.

`definition` enum'u 2026'da sadeleşti: `sd`, `hd`.

4K–8K arası oynatma desteği 2022'de kaldırıldı.

### 3.9 ⚠️ 7 günlük token sınırı

OAuth consent ekranı **"External"** ve **"Testing"** durumundaysa refresh
token **7 gün sonra** iptal edilir. Bu, YouTube kapsamları için de geçerlidir —
istisna yoktur.

**Aşmanın yolları:**

| Yol | Gereken |
| --- | --- |
| (a) | **Workspace / Cloud Identity** projesi + consent ekranı **"Internal"** kullanıcı tipi |
| (b) | Consent ekranı **"In Production"** durumuna alınır |
| (c) | **Tam doğrulama (verification)** tamamlanır |

**Yorum:** Bu uygulama yerelde, tek kullanıcı tarafından işletiliyor. En
kısa yol (a): bir Workspace/Cloud Identity projesi oluşturmak ve consent
ekranını Internal yapmak. (b) ve (c) daha uzun ve harici kullanıcı varsayıyor.

**7 günlük sınırın etkisi:** Refresh token her hafta yeniden yetkilendirme
gerektirirse, "zamanlanmış yayın" ürünü kullanılamaz hale gelir. Kurulum
sırasında bu karar **ilk gün** verilmelidir, sonra değil.

### 3.10 ⚠️ Production öncesi zorunlu: doğrulanmamış proje = `private`

> "All videos uploaded via the `videos.insert` endpoint from **unverified API
> projects created after 28 July 2020 will be restricted to private viewing
> mode**. To lift this restriction, each API project must undergo an **audit**
> to verify compliance with the Terms of Service."

Bu, "neden yükledim ama kimse görmüyor" sorusunun resmî cevabıdır.

| Koşul | Sonuç |
| --- | --- |
| Proje 28 Temmuz 2020 sonrası oluşturuldu **ve** doğrulanmamış | Tüm yüklemeler `private` kilitli |
| Proje doğrulanmış | Kilit yok |
| Doğrulanmamış projede kotа artışı istenirse | Compliance audit zorunlu |

Compliance audit formu:
`https://support.google.com/youtube/contact/yt_api_form`

> "All ... for additional quota requests must go through a compliance audit. We
> also conduct ... **re-audits** to ensure API usage is compliant with YouTube's
> Developer Policies and Terms of Service."

**Yorum:** Yükleme teknik olarak başarılı olur, `video.id` döner, ama video
görünmez. Otomatik yayıncıda bu, "başarılı" görünüp "yayınlanmamış" olan bir
durumdur. Uygulama yükledikten sonra `videos.list` ile `status.privacyStatus`
kontrolü eklemeli, aksi halde yanlış başarı raporlar.

### 3.11 ⚠️ `youtubers` scope YOKTUR

Bu scope **yoktur.** Eski YouTube CMS / Analytics v1 kalıntısıdır. Dokümanda
0 eşleşme bulunur, sayfa 404 verir.

**Kanal grupları (managed channels) şöyle alınır:**

```http
GET https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,id
    &mine=true
    &managedByMe=true
```

### 3.12 Reklam uygunluğu ve 18+ — API'de YOK

Yalnız YouTube Studio arayüzünde ayarlanabilir. `videos.insert` ve
`videos.update` gövdelerinde reklam uygunluğu veya yaş kısıtlaması alanı yok.
Uygulama bu ayarları yönetemez; kullanıcı Studio'dan yapmalıdır.

### 3.13 ⚠️ 27 Ağustos 2026 — view sayımı değişti

Her YouTube Data API sayfasının üstünde kalıcı bir uyarı bandı var:

> "**Important: YouTube is updating its policy for how it counts views for all
> video formats.**"

**29 Eylül 2026** itibarıyla bu politika **tüm formatlarda** geçerlidir:
view sayımı artık "oynatma başlangıcı"na sayılır. Kısa videolar, Shorts ve
normal videolar aynı kurala tabidir.

**Sonuç:** Analitik panelde **tarih kırılması** yapın. 27 Ağustos 2026
öncesi/sonrası view sayıları doğrudan karşılaştırılabilir değildir; artış
gibi görünen şey politika değişikliği olabilir.

### 3.14 YouTube hata kodları

| HTTP | `reason` | Anlam | Sınıf |
| --- | --- | --- | --- |
| 400 | `mediaBodyRequired` | Video içeriği gönderilmemiş | KALICI |
| 400 | `uploadLimitExceeded` | "The user has exceeded the number of videos they may upload" | KALICI (bugün) |
| 400 | `invalidTitle` | Başlık geçersiz veya boş | KALICI |
| 400 | `invalidDescription` | Açıklama geçersiz | KALICI |
| 400 | `invalidTags` | Anahtar kelimeler geçersiz (boş string de geçersiz) | KALICI |
| 400 | `invalidCategoryId` | Kategori ID geçersiz | KALICI |
| 400 | `invalidPublishAt` | Zamanlanan yayın zamanı geçersiz | KALICI |
| 400 | `invalidLicense` / `invalidPrivacySetting` (403) | Değer geçersiz | KALICI |
| 400 | `invalidVideoGameRating` | Oyun ratingi geçersiz | KALICI |
| 403 | `forbidden` | Yetkilendirme yok — scope eksik olabilir | **ÖZEL** → scope kontrolü |
| 403 | `quotaExceeded` | Kota aşıldı | **GEÇİCİ (günlük)** |
| 403 | `uploadLimitExceeded` | Kanal yükleme limiti | KALICI |

> `quotaExceeded` 403'tür ama "bugün" sınıfındadır. `ratelimit` sınıfıyla
> eşlenip ertesi gün yeniden denemeye alınabilir; `auth` sınıfıyla eşlenirse
> kullanıcı yanlış bilgilendirilir.

### 3.15 YouTube — Bilinmeyenler

| # | Doğrulanamayan | Not |
| --- | --- | --- |
| 1 | Shorts'e özel analitik API filtresi | Belgelenmemiş. `dimensions=video==` normal akışta çalışır ama Shorts ayrımı için ayrı filtre yok |
| 2 | 27 Ağustos 2026 view politikasının tam metni | Sayfalarda yalnız uyarı bandı var, politika sayfasına bağlantı yok. Tam davranış (otomatik oynatma, döngü sayılıyor mu) bilinmiyor |
| 3 | `videos.update` için gereken **asgari** scope tam listesi | Referans sayfası `youtube.upload` **ve** `youtube` **ve** `youtubepartner` **ve** `youtube.force-ssl` listeliyor; hangisinin yeterli olduğu yazmıyor. Güvenli taraf: ikisini de iste |
| 4 | Compliance audit'in gerçek süresi | Resmî sayı yok. "We also conduct re-audits" ifadesi geçiyor, süre yok |
| 5 | Compliance audit reddi sonrası yol | Form üzerinden yeniden başvuru mu, yeni proje mi gerektiği yazmıyor |
| 6 | Workspace/Cloud Identity "Internal" consent'in kişisel projelerde kullanılabilirliği | Yalnız Workspace projelerinde mümkün olduğu genel bilgi; belgeden doğrulanamadı |
| 7 | Content ID global blok kuralının hangi süreyi kapsadığı | "3 dakikayı aşan" deniyor, eşik değerinin kesin sınırı ve istisnaları yazmıyor |
| 8 | `status.publishAt` ile planlanan video, saat gelince `public` olmuyorsa kullanıcıya bildirim verilir mi | Belgede yok |
| 9 | `googleusercontent` dışı `selfDeclaredMadeForKids` değişikliğinde `videos.update` gerekip gerekmediği | Belgede yok |

---

## 4. Karşılaştırma — üç platform tek tabloda

| Konu | Instagram | TikTok | YouTube |
| --- | --- | --- | --- |
| Herkese açık video URL'i gerekli mi | **Hayır** (resumable) | Hayır (`FILE_UPLOAD`) / hayır (`PULL_FROM_URL` + alan adı doğrulama) | **Hayır** (resumable) |
| Resmi yayın zamanlaması | **Yok** | **Yok** | **Var** (`status.publishAt`) |
| Kalıcı permalink her zaman alınabilir mi | Evet (`permalink`) | **Hayır** — yalnız herkese açık + moderasyon onaylı | Evet |
| Günlük yayın kotası | 50 **veya** 100 / 24 saat (çelişkili, canlı okunmalı) | 5 kullanıcı / 24 saat (denetim geçene kadar) | 100 `videos.insert` / gün |
| Kota okunabilir mi | **Evet** (`content_publishing_limit`) | Hayır | Hayır (API Console) |
| Ağ kesintisinde kaldığı yerden devam | Var (offset) | Var (chunk no) | Var (resumable) |
| Yükleme adresi ömrü | Container 24 saat | `upload_url` **1 saat** | Oturum süresi belirtilmemiş |
| AI bildirim alanı | `is_ai_generated` | `post_info.is_aigc` | `status.containsSyntheticMedia` |
| Kurulumda kritik engel | **Yok** (kendi hesabınıza App Review gerekmez) | **App Review + denetim (haftalar)** | **Compliance audit (haftalar)** |
| 9:16 API'de zorunlu mu | Hayır | **Hayır** | Hayır |

**En zor kurulum:** TikTok. Hem scope onayı hem App Review hem denetim gerekiyor
ve denetim geçene kadar public yayın yapılamıyor.

**En kolay kurulum:** Instagram. Kendi yönettiğiniz hesaplara yayın için App
Review gerekmiyor, Standard Access otomatik.

**En sinsi hata:** YouTube `videos.update` ile `part`'ta belirtmediğiniz alanın
silinmesi. `containsSyntheticMedia` kaybolursa AI bildirimi ihlali olur ve
hiçbir hata mesajı çıkmaz.

---

## 5. Bu dokümanın sınırları

1. **Sürüm kayması olabilir.** Meta'da v21.0 **21 Ocak 2027**'de kalkacak.
   YouTube'da politika değişiklikleri 2026'da sürüyor. Bu doküman tarihli bir
   anlık görüntüdür; sayıların kendisi değişecek.
2. **Kota sayıları kesin değil.** Instagram'da resmî kaynaklar kendi içinde
   çelişiyor. Canlı okuma zorunlu.
3. **Kurulum süreleri tahmindir.** Hiçbir platform app review süresini resmî
   sayıyla vermiyor. KIMLIK-KURULUMU.md'deki süreler "sıra fikri"dir, garanti
   değildir.
4. **Resim yükleme (carousel, TikTok fotoğraf) kapsam dışı.** Bu uygulama
   video yayınlıyor.
5. **Analitik/inSight'lar kısmi.** Instagram `instagram_manage_insights`,
   TikTok `/v2/video/query/`, YouTube `yt-analytics.readonly` — üçü de
   ayrıntılı okunmadı.
