# TikTok adaptörü — varsayımlar ve bilinmeyenler

Bu dosya, adaptörün **neyi bildiği** ve **neyi bildiğini sandığı** ayırır.
Instagram (`../instagram/NOTES.md`) ve YouTube için de aynı ayrım geçerli; bu
dosya o ikisinin kopyası değil, TikTok'a özgü olanları içerir.

## 1. APP REVIEW POLİTİKASI RİSKİ — EN ÖNEMLİ MADDE

TikTok'un resmî App Review politikası, **"kendi hesaplarına yükleyen araç"
tipini kabul etmiyor.** Bir üçüncü taraf uygulamanın kullanıcının adına video
yayınlaması (Content Posting API) yalnız denetimden (audit) geçmiş istemciler
için mümkündür.

Sonuçları:

- Bu kod **yazıldı ve test edildi, ama canlı bir hesaba bağlanmamalıdır.**
  `src/main.ts` bu pakette bağlanmadı; bağlantı, uygulamanın denetim sürecinden
  geçmesine bağlıdır. Bu paket `main.ts`'e dokunmaz (yazma yüzeyi kısıtlı).
- Denetim süreci, TikTok'un **kendi istediği deneme hesaplarını** ve test
  videolarını app incelemesine göndermek ister; panelde bu akışın YERİ YOKTUR.
- Denetim kısıtları aşağıda (2) ve yayın hattındaki karşılıkları
  `publisher.ts` içinde `getCreatorOptions` / `startPublish` dalındadır.

## 2. DENETİMSİZ İSTEMCİ YALNIZ `SELF_ONLY` YAYIN YAPAR

Denetimden geçmemiş istemciler için:

- yayın gizliliği **yalnız `SELF_ONLY`** olabilir,
- 24 saatte **5 kullanıcı**,
- **~15 post/gün, TÜM istemciler arasında PAYLAŞILAN** bir kota.

`403 unaudited_client_can_only_post_to_private_accounts` bir hata değil,
**kalıcı politika kararıdır** (`classifyTikTokFailure` bunu `policy` olarak
verir, mesajda "denetim gerekli" yazar). Yeniden denemek kabul edilmez.

`startPublish` bu kısıtı **sessizce zorlamaz**: kullanıcı `public` istedi ve
hesapta yalnız `SELF_ONLY` varsa, `privacyLevelProblem` açıklayıcı bir kalıcı
`policy` hatası üretir (`403 privacy_level_option_mismatch` yerine, sebebiyle
birlikte). Başka bir değere sessizce geçilmez — reklam kampanyasının sessizce
hedefsizleşmesi, "yanlış gizlilik" hatasından çok daha kötüdür.

## 3. `share_url` DÖNMEZ — `published_no_link` OLAĞANDIR

`status/fetch` yalnız `publicaly_available_post_id` döner ve o **yalnız herkese
açık yayınlanmış** içerik için gelir. `share_url` alanı Content Posting API'de
**yoktur**. Permalink için `/v2/video/query/` (`video.list` kapsamı) gerekir; o
kapsam ek yetkidir ve o uç nokta da yalnız herkese açık içerik için döner.

Sonuç: `PUBLISH_COMPLETE` → `{ state: "published", permalink: null }` ve motor
`published_no_link`'a çevirir. Bu bir arıza DEĞİLDİR: içerik yayınlandı.
Denetimden geçmemiş bir istemcinin `SELF_ONLY` yayınında kalıcı permalink hiç
bir zaman çözülemez — istatistik bu yüzden `unavailable: { reason: "not_public" }`
vermelidir.

## 4. `Retry-After` DAVRANIŞI DOĞRULANMAMIŞ

TikTok dokümanı hız sınırlarını verir (init 6/dk · status 30/dk ·
creator_info 20/dk · video/query 600/dk) ama **`Retry-After` başlığını hiç
anlatmaz.** Bu yüzden:

- `http.ts` başlığı okur (bonus), ama hiçbir karar BUNA dayanmaz.
- Yoklama aralığı `TIKTOK_STATUS_POLL_MS = 5 sn` sabittir ve sağlayıcı isteği
  2 sn'nin altına **düşürülemez** (`TIKTOK_MIN_POLL_MS`). 5 sn = 12 istek/dk,
  sınırın yarısı bile değil.
- **Üstel geri çekilme motorun işidir** (bkz. `src/services/publisher.ts`);
  bu katman yalnız `retryAfterMs` önerir.

## 5. PARÇA BOYUTU 16 MiB — CANLIDA DENENMEDİ

`TIKTOK_DEFAULT_CHUNK_BYTES = 16 MiB`. 5-64 MB aralığının ortası: küçük parça
yeniden denemeyi ucuzlatır ama çok istek üretir (4 GB'da 256 istek), büyük parça
az istek üretir ama bir istek başarısız olduğunda 64 MB yeniden gönderilir.
Gerçek kabul/red davranışı **ölçülmedi**. Değiştirmek tek yerdedir
(`planChunks` içinde clamp edilir).

## 6. `total_chunk_count = floor(...)` VE "SON PARÇA EN BÜYÜK PARÇADIR"

Doküman `total_chunk_count = floor(video_size / chunk_size)` der (`ceil` DEĞİL).
Bu formülle son parça **kalan küçük dilim değil**, `size − (count−1) × chunk`
kadar olur; yani `son ∈ [chunk, 2·chunk)`. İki sonuç doğar ve ikisi de
**dokümanın verdiği iki istisnanın** tam açıklamasıdır:

- `chunk ≤ 64 MB` iken son parça **her zaman** `< 128 MB` → "son parça 128 MB'ye
  kadar" istisnası her zaman yeterlidir,
- `chunk ≥ 5 MB` iken son parça **her zaman** `≥ 5 MB` → alt sınır da doludur.

Kısacası `floor` formülü bu iki istisna olmadan **çalışmaz**; istisnalar
formülün parçasıdır. `planChunks` bu yüzden son parçayı `chunk_size` DEĞİL
kalanın tamamı olarak gönderir (`chunkRange`).

**CANLIDA DOĞRULANMADI.** TikTok dokümanı pratikte `ceil` kastediyorsa, son
parça fazla küçük kalır ve sunucu reddedebilir. Belirti: yükleme "tamam" demeden
`FAILED` ya da 416. Düzeltme tek satırdır (`planChunks`'ta `floor` → `ceil`),
ancak `uploadParts`'in son-parça hesabıyla birlikte değişmesi gerekir.

## 7. `PULL_FROM_URL` BİLEREK KULLANILMIYOR

Resmî öneri "dosya senin sunucundaysa `PULL_FROM_URL`" der. İki neden reddettik:

1. `PULL_FROM_URL` **alan adı mülkiyet doğrulaması** gerektirir; doğrulama
   başarısız olursa yayın sessizce kabul edilmez.
2. Medyanın internete açık olmasını gerektirir ve bu uygulamanın
   `spec.requiresPublicMediaUrl: false` tercihiyle çelişir.

`FILE_UPLOAD` yalnız `video.publish` kapsamı ister ve ikilisi bize göndermek
zaten meşru yoldur.

## 8. HESABA ÖZEL SÜRE SINIRI `precheck`'TE DOĞRULANAMAZ

`max_video_post_duration_sec` ve `privacy_level_options` **token gerektirir**
(`creator_info`). `precheck` sözleşmesi gereği yerel ve ağsızdır; bu yüzden
`precheck` yalnız genel tabanı (3 sn–10 dk) uygular ve `info` bulgusuyla
"hesap limiti yayın anında kontrol edilir" der. Asıl kontrol
`startPublish` → `getCreatorOptions` içindedir.

`creator_info` **yayından önce zorunludur**: `privacy_level` listede yoksa 403
`privacy_level_option_mismatch`, süre aşılırsa 403 `duration_check_failed` gelir
ve ikisi de kaynakta anlaşılmaz.

## 9. `unlisted` → `MUTUAL_FOLLOW_FRIENDS` BİR ÜRÜN KARARIDIR

TikTok'ta "yalnız bağlantısı olanlar görsün" diye bir görünürlük kademesi
**yoktur**. `ResolvedCopy.privacy = "unlisted"` için en yakın karşılık
`MUTUAL_FOLLOW_FRIENDS`'tır (yalnız karşılıklı takipçiler görür). `precheck`
bunu `info` olarak bildirir; `privacy` alanının sözleşmesi bir
`PlatformCopy` alt kümesidir ve yeni değer eklemek `src/contract/**`
düzenlemesi gerektirirdi (bu paketin yazma yüzeyi dışında).

## 10. KOTA OKUNAMAZ — `readQuota` `null` DÖNER

Content Posting API'de `content_publishing_limit` benzeri bir sayaç uç noktası
**yoktur**. Bu yüzden:

- **hiçbir sayı kodda sabit yazılmaz.** Denetimsiz istemciler için günlük ~15
  post kotası TÜM istemciler arasında PAYLAŞILIR ve hesaba özel değildir;
  sabit yazmak uydurma olurdu.
- **Ağ isteği ATILMAZ**: `null` için istek atmak 20/dk `creator_info` kotasını
  boşa harcar.
- Motor `null` görünce yayını ENGELLEMEZ; kısıt zaten TikTok tarafında
  uygulanır. Aşılırsa `status/fetch` `fail_reason:
  "spam_risk_too_many_posts"` bildirir ve `mapTikTokFailReason` onu kalıcı
  `quota` olarak sınıflandırır.

## 11. PARÇA BOYUTU `init`'TE SABİTLENİR — SÜREÇ İÇİ OTURUM HARİTASI

TikTok `chunk_size`'ı bir kez `init`'te bildirir; sonraki `PUT`'ların
`Content-Range` değerleri O SAYIYA bağlıdır. Motor `UploadSession.partSizeBytes`
alanını **0** yazar ("parça boyutu sağlayıcıya bağlıdır") ve kalıcılaştırmaz.
Bu yüzden plan `startPublish` içinde hesaplanır, `idempotencyKey` ile süreç içi
bir haritada saklanır ve `uploadParts` aynı plandan okur (dosya anahtarı ve
bayt sayısıyla birlikte).

Harita boşsa (süreç yeniden başlamış) plan `input.media.bytes`'ten türetilir ve
motorun yazdığı `session.totalParts` ile **çapraz denetlenir**: tutmuyorsa kalıcı
`validation` hatası verilir. Yanlış ofseti sessizce göndermek videoyu bozup
TikTok'tan 416 alır; hata vermek daha dürüsttür.

**BİLİNEN BOŞLUK:** motor `continueUpload`'a **kaynak** varlığın medyasını
geçiyor (`baseInput`), `startPublish`'a ise transcode edilmiş türevi
(`finalInput`). Bayt sayıları farklıysa yukarıdaki harita olmadan ofsetler
kayar. Harita bunu **süreç içinde** çözer; süreç yeniden başlatıldığında
tespit edilebilir ama düzeltilemez (motor katmanı bu paketin dışında).

## 12. MÜKERRER KORUMA SÜREÇ İÇİDİR

`init` gövdesinde resmî idempotens alanı **yoktur** (`publish_id` sunucunun
ürettiği bir kimliktir, istemci veremez). Aynı `idempotencyKey` + **aynı dosya**
(`storageKey|bytes|mimeType`) + süresi dolmamış oturum → yeni `publish_id`
**AÇILMAZ**. Farklı dosya aynı anahtarla gelirse bu artık mükerrer DEĞİLDİR ve
yeni `init` açılır. Süresi dolmuş oturum yenilenir (`upload_url` 1 saatte
geçersizleşir).

Kalıcı koruma motorun kuralıdır: `externalId` yazılmış bir iş için
`startPublish` yeniden çağrılmaz. Kalıcı anahtar
(`publish_jobs.idempotency_key`) db katmanındadır.

## 13. `accountChanged: false` TESPİT EDİLEMEZ

Port imzası `refresh(refreshToken)` der; karşılaştırılacak eski `open_id`
çağıra GİRMEZ. TikTok'un cevabı `open_id` taşısa bile elimizde onunla
karşılaştıracağımız hedef yoktur. `true` uydurmak sessiz bir güvenlik iddiası
olurdu; `false` "tespit edilemedi" demektir.

## 14. `refresh` DÖNEN `refresh_token`'I AYNEN GEÇİRİR

TikTok yenileme cevabında yeni (ve farklı) bir `refresh_token` döner; eskisi
geçersizleşir. Alan **yoksa** `null` döner (sözleşme: "koru"). UYDURMA bir
yenisi asla üretilmez — sözleşmedeki `null` "koru" anlamına gelir ve çağıran
`refreshTokenEnc` içindeki eskiyi bırakır. `access_token` 24 saat,
`refresh_token` 365 gün geçerlidir.

## 15. REDIRECT URI KURALI SIKI UYGULANIR

`https` ile başlamalı, fragment içermemeli, 512 karakterden kısa olmalıdır.
`http://localhost` **kabul edilmez**: TikTok kayıtta yalnız https ister; gevşek
bir kontrol "panelde kayıtlı" dediği hâlde token isteğinin reddedilmesine yol
açar. Sıkı kontrol, hatanın kaynağını (kayıt defteri) doğrudan gösterir.

## 16. `src/main.ts` BAĞLANTISI BU PAKETTE DEĞİLDİR

Instagram'da olduğu gibi `main.ts` bu seçenekleri bağlamıyor. Bağlanana kadar
`uploadParts` çalışmaz (yayın `preparing`de kalır). Bağlanması gereken yer tek
satırdır: `openRange`/`resolvePath` verilmeden `TikTokPublishAdapter`
yükleme oturumu açabilir ama bayt GÖNDERMEZ ve `validation /
range_source_missing` kalıcı hatası verir.

## 17. SAAT KAYNAĞI ZORUNLUDUR

`now: () => number` **zorunlu** bir parametredir; varsayılanı yoktur. Saati
gizleyen bir varsayılan, "upload_url süresi doldu mu" sorusunu test edilemez hale
getirir. Üretimde `() => Date.now()` verilir.

## 18. BİLMEDİĞİMİZ BAŞKA NOKTALAR

- `user.info.basic` **kullanıcı adı döndürmez** (yalnız `open_id`, `union_id`,
  `display_name`, `avatar_url`, sayaçlar). `username: null` DOĞRU cevaptır;
  `display_name` yoksa `open_id` gösterilir, uydurulmaz.
- `video_cover_timestamp_ms` **hesaplanabilmesi süreye bağlıdır.** Süre bilinmiyorsa
  alan GÖNDERİLMEZ: bilinmeyen süreyle bir zaman damgası uydurmak, kullanıcının
  seçtiği kareyi yok saymaktır (TikTok `0`'ı "ilk kare" olarak yorumlar).
  Yüzde → ms dönüşümü: `round(durationSec × 1000 × percent / 100)`.
- 2200 karakterlik caption sınırı **UTF-16 kod birimiyle** ölçülür: Türkçe
  harfler 1, **emoji 2** sayılır. `copy.ts` de aynı ölçümü kullanır; metin
  kırpılmaz, ret edilir.
- `is_aigc` `false` olsa bile AÇIKÇA gönderilir: alan yok bırakılırsa sunucu
  "beyan yok" ile ayırt edemez ve içerik sessizce AI etiketsiz yayınlanır.
- Parça cevabı: ara parça **206**, son parça **201**. Son parça 206 dönerse
  `done: true` bildirilir (baytlar gitmiştir; `done: false` motoru sonsuz
  döngüye sokardı) — sapma yoklamada `FAILED` ile yakalanır.
- `pollPublish` `uploadUrlExpiresAt` dolmuşsa HATA VERMEZ (Instagram verir):
  TikTok baytlar alındıktan sonra işlemeyi kendi tarafında sürdürür,
  `upload_url` yalnız bayt göndermeyi düzenler. Süresi dolmuş bir adres, dolmuş
  bir yayını "başarısız" yapmaz.
- Hız sınırları `status/fetch` için 30/dk'dır; `init` 6/dk ve
  `creator_info` 20/dk. `init` neden ayrı bir hattta çağrılır: `precheck`
  `creator_info` **istemez** (ağ çağrısı yapmaz), oran `startPublish` içinde
  korunur.
