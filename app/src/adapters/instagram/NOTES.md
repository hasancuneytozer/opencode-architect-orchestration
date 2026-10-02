# Instagram adaptörü — varsayımlar ve bilinmeyenler

Bu dosya, adaptörün **neyi bildiği** ve **neyi bildiğini sandığı** ayırır.
Doğrulanmamış her varsayım burada yazılıdır; gizli varsayım, gün gelince
kullanıcıya sürpriz yapar.

## 1. PROFESYONEL HESAP ŞARTI (uygulama ön koşulu, doğrulanabilir değil)

Content Publishing API yalnız **Business** ya da **Creator** (profesyonel)
Instagram hesaplarında çalışır. Kişisel hesapta `/media_publish` sessizce
`OAuthException` döner; adaptör `readInstagramAccount` içinde bunu
`no_instagram_business_account` **yetkilendirme hatası** olarak verir.

Bu bir yayın hatası DEĞİLDİR; hesap sahibinin yapması gereken bir işlemdir
(Instagram uygulamasında "Profesyonel hesaba geç"). Kullanıcıya "hesabınızı
profesyonel yapın" demek için tek bir HTTP kodu yok — bu yüzden davranış
`precheck`'te değil, yetkilendirme ANINDA üretilir. Hesap sonradan profesyonel
duruma geçse yeniden yetkilendirme gerekir (token'ın page bağlantısı eskir).

## 2. FACEBOOK PAGE ZORUNLULUĞU VE "HANGİ SAYFA?" SORUSU

Facebook Login yolunda bir Page ZORUNLUDUR. Birden çok sayfa yönetiliyorsa
`pickPageWithInstagram` **ilk `instagram_business_account` taşıyan** sayfayı seçer
ve `linkedPageId` kayda yazılır. Bu seçim **kör bir seçimdir**: panelde
"hangi sayfa?" diye soran bir ekran YOKTUR. Çok sayfalı kullanıcılar yanlış
sayfaya yayın yapabilir. Doğru çözüm `linkedPageId`'nin panelden
seçilebilir olmasıdır; o ekran bu pakette değil.

Sayfa listesinde `instagram_business_account` alanı YOKSA her sayfa tek tek
denenir (bazı App Review sürümlerinde `/me/accounts` gövdesi alanı taşımaz).

## 3. `id` mi `uri` mi? (CANLIDA DOĞRULANMADI)

Resumable container yanıtı `{ id, uri }` döner. **Hangisinin yetkili olduğu
resmî dokümanda net yazılı değil.** Kodun kuralı:

1. `id` varsa → `externalId` odur (durum sorgusu `/{id}` kullanır, tutarlılık şart).
2. `id` yoksa → `uri`'nin **son yol segmenti** kimlik kabul edilir. Bu bir
   **ÇIKARIMDIR** ve canlıda tek bir yanıtla doğrulanmadı.
3. `uri` mutlak bir adrese `uploadUrl` olarak kullanılır; değilse adres
   `{RUPLOAD_BASE}/{v}/{id}` biçiminde kurulur.

İki alan da varsa ve farklıysa `id` kazanır. Bu ayrım yanlışsa belirtileri
tarif ettiğimizden farklı olur — yayın öncesi tek bir canlı container ile
`id === uri'nin son segmenti` doğrulanmalıdır.

## 4. PARÇA BOYUTU 8 MB (DOĞRULANMAMIŞ)

`INSTAGRAM_RESUMABLE_CHUNK_BYTES = 8 MiB`. Meta'nın resumable upload için parça
başına alt sınırlı olduğu biliniyor, ancak **sayı canlı ölçülmedi**. 8 MB hem
en yaygın belgelenen alt sınırın üstünde hem de 300 MB'ı 38 parçaya böler.

`UploadSession.partSizeBytes` kalıcı yazıldığı için ofset aritmetiği bu değere
bağlıdır: **süren bir yüklemede sabit ARTIRILMALIDIR, AZALTILAMAZ.**
Azaltılırsa `uploadedParts × yeni boyut` yanlış ofset verir ve Meta
"offset çakıştı" ile reddeder. Değiştirmek tek yerdedir.

## 5. `debug_info.retriable` DAVRANIŞI CANLIDA DOĞRULANMADI

Meta'nın `rupload` hata gövdesinde `debug_info.retriable` alanının **hangi durumda
`true`, hangi durumda `false` olduğu** belgelenmemiştir. Kod şu kuralı uygular:

- alan `true` → `RetryablePublishError` (aynı `offset`le tekrar gönderilebilir),
- alan `false` → `PermanentPublishError`,
- alan **yok** → HTTP durumu: 4xx **kalıcı**, 5xx/429 **geçici**.

Son satır bilinçli bir varsayımdır: sessizce "belki geçcidir" deyip 4xx'i
geçici sayamayız, çünkü baytların bir kısmı yüklenmiş olabilir ve aynı ofsetle
tekrar göndermek veri bozar. Alan gerçekten `true` dönmediği sürece 400 hataları
iş kuyruğunda birikerek "sürekli başarısız" görüntüsü üretebilir — canlı bir
testte izlenmelidir.

## 6. KOTA SAYILARI ÇELİŞKİLİ (bu yüzden hardcode YOK)

Resmî kaynaklar birbiriyle çelişiyor: Content Publishing rehberi "24 saatte 100
API yayını" der, `content_publishing_limit` dokümanı ise `quota_total: 50`
örneği verir. Hangisinin doğru olduğu hesaba ve uygulama türüne göre değişebilir.

Bu yüzden **hiçbir sayı kodda sabit yazılmaz.** `readQuota` her seferinde
`GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config&since=`
uyç noktasını okur; `since` en fazla 24 saat öncesine gösterilir (doküman sınırı).
404/403/5xx veya eksik alan → `null` döner ve motor yayını **ENGELLEMEZ** (kısıt
zaten Meta tarafında uygulanıyor). `quota_duration` yoksa 86400 saniye varsayılır.

`quota_usage` **yalnız bu uç noktanın saydığı yayınları** kapsar; panelden
yapılan yayınlar dahildir, başka istemciler kapsam dışı olabilir.

## 7. PERMALINK YOKSA `published_no_link`

`media_publish` **200 döndükten sonra** yayın geri alınamaz. Bu yüzden
permalink okuma hatası **yutulur** ve `PollResult` `{ state: "published",
permalink: null }` döner; motor `finishPublished` içinde bunu
`published_no_link` durumuna çevirir. Yayın geri alınamayacağı için "başarısız"
demek **yanlış** olurdu: içerik akışta vardır.

`media_product_type` ayrıca okunur: `media_type` yayın sonrası **her zaman
`VIDEO`** döner, Reels ayrımı yalnız `media_product_type` ile yapılır. Reels
DEĞİLse `providerStatus` `PUBLISHED_<ÜRÜN>` olur (ör. `PUBLISHED_FEED`) ve
arşivde görünür.

## 8. `refresh` BİR OAUTH REFRESH GRANT'İ DEĞİLDİR

Graph API **refresh token yayınlamaz**. `refresh(refreshToken)`, saklanan
long-lived belirteci `fb_exchange_token` ile uzatmayı dener; Meta bu değişimi
**kısa ömürlü** belirteç için belgeler, uzun ömürlüyü reddedebilir.

- Başarılıysa `refreshToken: null` döner (sözleşme: "yeni refresh token dönmedi,
  eskisini koru"). Meta üretmediği için `null` DOĞRUDUR.
- Reddedilirse kalıcı `auth` hatası → yeniden yetkilendirme.
- `accountChanged: false`: uzatma yanıtı hesap kimliği taşımaz, değişiklik
  **tespit edilemez**. `true` uydurmak sessiz bir güvenlik iddiası olurdu.

## 9. MÜKERRER KORUMA SÜREÇ İÇİDİR

Container gövdesinde resmî idempotens alanı **yoktur**. `idempotencyKey`
süreç içi bir `Map`'te tutulur; aynı anahtar + **aynı dosya**
(`storageKey|bytes|mimeType`) + süresi dolmamış container → yeni container
AÇILMAZ. Süreç yeniden başlarsa harita boşalır. Kalıcılık
`publish_jobs.idempotency_key` sütununda (db katmanı) zaten vardır.

Süresi dolmuş container yenilenir: Meta 24 saat sonra `EXPIRED` döner ve aynı
`creation_id` yeniden kullanılamaz.

`media_publish` çağrısı `FINISHED` dalının İÇİNDE ve TEK YERDE yapılır;
`PollContext` "publish edildi mi" bilgisi taşımadığı için ikinci bir çağrı
mükerrer paylaşım riski taşır.

## 10. YÜKLEME BAYTLARI İÇİN DEPO ERİŞİMİ ENJEKTE EDİLİR

`PublishInput.media` yalnız `storageKey` taşır, dosya yolu taşımaz
(`StoreMediaRefResolver` `info.path`'i de `storageKey` yapar). 300 MB'lık gövde
`store.read()` ile belleğe alınamaz. Bu yüzden `uploadParts` baytları
`openRange` (ya da `resolvePath` → `node:fs.createReadStream({start,end})`)
üzerinden **akış olarak** açar. HİÇBİRİ verilmezse `uploadParts` sessizce
"başarılı" demez: `validation` / `range_source_missing` kalıcı hatası verir.

**Bu paketin yapmadığı:** `src/main.ts` ve `src/http/server.ts` bu seçeneği
bağlamıyor. Bağlanana kadar `uploadParts` çalışmaz (yayın `preparing`de kalır).
Bağlanması gereken yer tek satırdır.

## 11. PPA (Meta Platform Agreement) GEREKLEBİLİR — BİLİNMEYEN

Resumable upload ve Content Publishing için uygulamanın **App Review**'tan
geçmiş olması ve PPA kabul edilmiş olması gerekir. Bu, HTTP 400/403 olarak
"yetki yok" görünür ama **hangi eksikliğin** (yayın alanı, video türü, test
video'su eksikliği) ayrımı belgelerde net değildir. Adaptör bu durumu
`auth`/`policy` olarak sınıflar, kök nedeni kullanıcıya söyleyemez.

## 12. SAAT KAYNAĞI ZORUNLUDUR

`now: () => number` **zorunlu** bir parametredir; varsayılanı yoktur. Saati
gizleyen bir varsayılan, "container süresi doldu mu" sorusunu test edilemez hale
getirir. Üretimde `() => Date.now()` verilir.

## 13. BİLMEDİĞİMİZ BAŞKA NOKTALAR

- `username`/`displayName` `instagram_business_account` gövdesinden gelir; alan
  yoksa `username: null` ve `displayName = page adı` döner. Uydurulmaz.
- `share_to_feed: true` sabittir. `share_to_feed: false` yalnız Reels'i akışta
  gizler; bu uygulama reklam içeriği yayınladığı için `true` seçilmiştir —
  bu bir **ürün kararı**, sağlayıcı zorunluluğu değil.
- `is_ai_generated` `false` olsa bile AÇIKÇA gönderilir: alan yok bırakılırsa
  sunucu "beyan yok" ile ayırt edemez.
- 5 dakikalık yoklama sınırı **kendi kuyruğumuzda** uygulanmaz; `retryAfterMs`
  yalnız bir ÖNERİDİR. Meta önerisine uyulduğu için motor dakikada bir sorar.
- `rupload` yanıtının `200/201` dışında `308` dönüp dönmeyeceği doğrulanmadı;
  `308` görülürse `classifyMetaFailure` `http_308` üretip kalıcı hata verir
  (bu, `offset`'li resumable akışta beklenen bir yanıt DEĞİLDİR).