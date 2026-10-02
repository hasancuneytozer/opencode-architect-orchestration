# YouTube adaptörü — varsayımlar ve bilinmeyenler

Bu dosya, adaptörün **neyi bildiği** ve **neyi bildiğini sandığı** ayırır.
Doğrulanmamış her varsayım burada yazılıdır; gizli varsayım, gün gelince
kullanıcıya sürpriz çıkarır.

## 1. Resumable oturumun ömrü (DOĞRULANMADI)

YouTube session URI'nin ömrünü **yazmıyor**. `expiresAt = now + 3600 sn`
(1 saat) bir **işletimsel tahmindir**, tavan değildir. Gerçek süre daha kısa
çıkarsa `PUT` 404 döner ve `container_expired` üretilir — kalıcı hata, iş
baştan başlamak zorundadır. Daha uzun çıkarsa biz yine 1 saat sonra kendi
kaydımızı geçersiz saymaz (yoklama `uploadUrlExpiresAt`'a bakar, sunucuya
sormaz); yalnız `isExpired()` kontrolü yerelde yapılır.

Bilinmeyen: oturum gerçekten ne kadar yaşıyor? 404'e kadar denemek yerine
1 saatte kapatmak, uzun dosyalarda (4 GB, düşük hız) erken iptal riski
taşıyor. Bu, `YOUTUBE_UPLOAD_SESSION_TTL_SEC` tek yerinde değiştirilebilir.

## 2. Kota sayacı GÜVENİLİR DEĞİLDİR (en önemli sınır)

`readQuota()` döndürdüğü değer **Google'ın kotanın kalanı DEĞİLDİR**. Google
kotanın kalanını okuyan bir uç nokta sunmuyor; `myRating`/`playlistItems`
gerektirir ve onlar da kota harcar. Sayac yalnızca **bu süreçte gönderdiğimiz
`videos.insert` çağrılarını** sayar (100/gün kova). Aynı kanal YouTube Studio'dan
veya başka bir sunucudan yükleme yapıyorsa bu sayı 0'ı gösterir.

Bu yüzden `used === 0` iken `null` dönülür: "hiç kullanılmadı" demek başka
süreçlerin yüklemelerini gizlemek olurdu. Kararı çağıran verir.

**Kota birimleri 2026'da değişti**: `videos.insert` = 1 birim (günde 100
çağrı ayrı kova), `videos.update` = 50, `thumbnails.set` = 50, `videos.list` = 1.
Eski "1600 birim/gün" bilgisi geçersizdir ve kodda kullanılmamıştır.

## 3. `categoryId = "27"` bir TAHMİNDİR

Entertainment (27) genel içerik için nötr bir varsayılandır, doğrulanmış bir
seçim DEĞİLDİR. Kategori reklam uygunluğunu belirlemez; yalnız videonun
hangi içerik türü kutusunda ve hangi otomatik etiketleme kümesinde ele
alınacağını etkiler. Sağlık kanalı 24, eğitim kanalı 26 ister. Seçim
`new YouTubePublishAdapter({ categoryId })` ile değiştirilebilir.

**Uyarı**: `snippet` güncelleniyorsa `categoryId` ZORUNLUDUR; yoksa 400.
`updateStatus` bunu varsayılan değerle doldurur.

## 4. `videos.update` birleştirme kuralı (EN KRİTİK)

`videos.update` yarı-birleştirmedir: gönderilen `part` içinde belirtilmeyen
alan **SİLİNİR**. `updateStatus` bu yüzden önce `videos.get` okur (1 birim),
`YOUTUBE_STATUS_WRITABLE_FIELDS` listesindeki alanların **hepsini** doldurur,
sonra gönderir. Sunucu alanı vermezse `YOUTUBE_STATUS_DEFAULTS` kullanılır —
bu, "sunucu alanı döndürmedi" ile "sunucu alanı sildi" ayrımını garanti eder.

Doğrulama **gerçek kanal üzerinde yapılmadı**. Yayın öncesi gerçek bir
`videos.update` çağrısının AI/kids beyanlarını koruduğu gözlemlenmelidir.

## 5. Doğrulanmamış proje → `private` kilidi (bilinmeyen davranış)

YouTube, API üzerinden yüklenen videoları doğrulanmamış projelerde
`private` olarak saklar. Bu bir yayın hatası değil, hesap durumudur. Adım
`precheck`'te **tespit edilemez** (token çözülemeden kanal durumu bilinmez);
tespit yalnız `videos.list` sonucunda `private` + `publishAt` yoksa yapılır ve
kullanıcıya `UNVERIFIED_PROJECT_MESSAGE` ile kalıcı `policy` hatası verilir.

**Bilinmeyen**: bu kilit proje başına mı, kanal başına mı, yoksa kanal API
erişimi kazanana kadar mı sürüyor? Süre ve kaldırma yolu belgelerde net
değil. Compliance audit'in tamamlanması otomatik mi, elle mi — bu yüzden
mesaj "gerekiyor" der, "otomatik çözülecek" demez.

## 6. Reklam uygunluğu ve 18+ kısıtı API'de YOK

`contentDetails.contentRating` (Temiz/Arşiv) ve telif/Content ID durumu
`videos.insert` ile **gönderilemez**; yalnız YouTube Studio'dan yönetilir.
Bu yüzden `precheck` bu kuralları denetlemez ve **denetlediğini iddia da
etmez**. Reklam içeriği için ön koşul başka katmanın (`services`) işidir.

## 7. Mükerrer yayın koruması kendi belleğinde

YouTube `videos.insert` gövdesinde resmî idempotens alanı **yoktur**. Bu
yüzden `idempotencyKey`, `StartResult.externalId` alanında `pending:<key>`
biçiminde taşınır ve aynı anahtarla gelen ikinci `startPublish` yeni oturum
açmaz. Koruma **süreç içidir**: süreç yeniden başlarsa `Map` boşalır ve aynı
anahtarla ikinci oturum açılabilir. Kalıcılık `PublishJob.idempotencyKey`
sütununda (db katmanı) zaten var; bu katman yalnız aynı süreç içindeki
çağrıları kapatır.

Farklı medya aynı anahtarla gelirse yeni oturum açılır: "mükerrer" değil,
farklı bir iştir.

## 8. Parçalamama kararı

`YOUTUBE_RESUMABLE_CHUNK_BYTES` (256 KB) bilinir ama **varsayılan olarak
kullanılmaz**: YouTube tek `PUT` önerir. `uploadParts()` tek gövde gönderir
ve `Content-Range` YAZMAZ. Çok parçalı yükleme gerekiyorsa 256 KB'ın KATI
olma kuralı dikkat gerektirir; bayt atlama/çakışma YouTube'da **sessiz** bir
hatadır (409). Parçalama yolu yalnız `UploadSession.partSizeBytes > 0`
gelirse açılır; motor normalde `0` yazar (bkz. §12).

## 12. Bayt gönderme: `uploadParts` ve kırılma noktaları

`startPublish` oturumu AÇAR, `uploadParts` baytları GÖNDERİR. Motor
(`src/services/publisher.ts`) ikisini ayrı adımlar olarak yürütür ve
`uploadedParts`'i `publish_jobs`'a yazar; süreç çökünce yeni işçi kaldığı
yerden devam eder.

**Doğrulanmamış:** Bu yol gerçek bir kanalda çalıştırılmadı. `201 Created`
gövdesinin video kaynağıyla gelmesi, `308` + `Range` başlığının kaldığı ofseti
bildirmesi ve `Content-Type`/`Content-Length`'in oturum açılışıyla aynı
olması **belgelenmiş davranıştır**, gözlemlenmiş değildir. İlk gerçek
yüklemede şu üçü loglanmalıdır: gönderilen `Content-Length`, dönen HTTP durumu
ve `Range` başlığı.

### 12.1 `readMedia` ZORUNLUDUR (montaj eksiği)

Resumable yükleme baytları **istemciden** gönderir; `PublishInput.media` yalnız
`storageKey` (depo içi anahtar) taşır, mutlak yol değildir. Bu yüzden
`YouTubeAdapterOptions.readMedia` verilmezse `uploadParts` **kalıcı** hata
verir (`validation`, `no_media_reader`). `main.ts` bu okuyucuyu geçmelidir;
geçmezse YouTube yayınları "bayt gönderen yok" gerekçesiyle durur — bu,
sessizce hiçbir şey göndermekten iyidir ama bir KURULUM EKSİĞİDİR.

### 12.2 Zaman aşımı 30 dakika

`http.ts` istemcisinin varsayılanı 30 saniyedir ve metadata istekleri içindir.
Gövde 2 GB'a kadar olabildiği için `uploadParts` ayrı bir zaman aşımı kullanır
(`YOUTUBE_UPLOAD_PUT_TIMEOUT_MS = 30 dk`). Kesilen yükleme sunucuda alınmış
baytları bilinmeyen noktada bırakır; bu yüzden zaman aşımı sonrası motor
`uploadedParts`'i **ARTIRMAZ** (yalnız başarılı cevapta artar). Aksi halde sonraki
deneme bayt atlatır ve sessizce 416 alır.

### 12.3 Süre tahmini hâlâ 1 saat (bkz. §1)

`uploadSessionExpired` motor tarafında, `uploadUrlExpiresAt` alanından yapılır.
Süre dolmuşsa iş **kalıcı** `container_expired` ile kapanır ve otomatik yeniden
başlatma YAPILMAZ: aynı oturuma dönmek işe yaramaz. Kullanıcı yeni yayın
başlatmak zorundadır.

### 12.4 `pending:` öneki kalıcı değildir

`startPublish` video kimliği olmadığı için `externalId` olarak
`pending:<idempotencyKey>` döner. `uploadParts` 201 aldığında gerçek kimliği
oturuma yazar; `pollPublish` `pending:` görünce bu kimliği kullanır. Süreç
yeniden başlarsa `Map` boşalır ve `pending:` kalıcı kalır — bu, §7'deki mükerrer
koruma ile AYNI sınırlama ve AYNI çözümdir (kalıcılık `publish_jobs`'ta).

## 9. Saat kaynağı zorunludur

`now: () => number` **zorunlu** bir parametredir; varsayılanı yoktur. Saati
gizleyen bir varsayılan, "süre doldu mu / publishAt geçti mi" sorularını test
edilemez hale getirir. Üretimde `() => Date.now()` verilir.

## 10. Bilmediğimiz başka noktalar

- `snippet.customUrl` yalnız bazı kanallarda döner; yoksa `username: null`
  döner ve uydurulmaz. Kullanıcı adı yerine kanal `id` gösterilebilir.
- `uploadStatus` alanı resmî dokümanda tüm durumlar için açıklanmaz;
  `failed`/`rejected` dışındaki değerler "işleniyor" sayılır.
- `videos.list` bir sayfada 50 öğe sınırındadır; `id=<tek kimlik>` sorgusu
  için bu sorun oluşmaz, ama liste tabanlı okuma yapılırsa dikkat edilmeli.
- Reklam kategorisi (`containsSyntheticMedia`) AI içeriği işaretler; bu alan
  gönderilmediğinde YouTube "temiz" varsayar ve içerik yanlış etiketlenir.
  Bu yüzden `aiGenerated` **her** yüklemede açıkça gönderilir.
