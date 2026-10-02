# Kimlik Kurulumu — Sıfırdan, Adım Adım

Bu belge, üç platformun kimlik bilgilerini **hiçbir şey bilmeyen** birinin
takip edebileceği sırayla anlatır. Her adımda: ne yapılacak, hangi ekranda,
elde edilen değer uygulamanın `.env` dosyasına **hangi anahtarla** yazılacak,
ne kadar sürer, nerede takılır.

> **Tüm süreler tahmindir.** Hiçbir platform başvuru süresini resmî sayıyla
> vermiyor. Süreler "sıra fikri"dir, taahhüt değildir.
>
> **Kurulumu kim yapar:** Meta adımları bir uygulama yöneticisi; TikTok ve
> YouTube adımları bir geliştirici hesabı gerektirir. Hesap sahibi, kurulum
> yapan kişiden farklı olabilir.

---

## 0. Önce `.env` dosyasını oluştur

```sh
cd app
copy .env.example .env      # Windows
cp .env.example .env        # macOS / Linux / Git Bash
```

`.env` dosyası **asla** depoya girmez. `.gitignore` bunu zaten kapsıyor.

**İlk çalıştırma için zorunlu iki anahtar.** Uygulama `NODE_ENV=test` dışında
başlamadan önce eksikleri tek bir Türkçe hata mesajıyla listeler; sessizce
"yarım yapılandırılmış" çalışmaz.

```sh
# 32 baytlık base64 anahtar — kayıtlı token'ları şifrelemek için
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Anahtar | Nereden gelir | Elle mi üretilir |
| --- | --- | --- |
| `SP_MASTER_KEY` | — | **Evet**, yukarıdaki komut |
| `SP_ADMIN_PASSWORD` | — | **Evet**, elle (en az 12 karakter) |

> **Uyarı:** `SP_MASTER_KEY` kaybolursa veritabanındaki kayıtlı token'lar
> **çözülemez** ve tüm hesapları yeniden yetkilendirmeniz gerekir. Üretimde
> yedekleyin. `SP_MASTER_KEY` boşsa uygulama **mock modunda** çalışır: hiçbir
> şey gerçekten yayınlanmaz. Bu, ilk denemelerde faydalıdır — kimlik
> kurulana kadar platform anahtarlarını boş bırakıp arayüzü gezebilirsiniz.

---

## 1. Instagram / Meta

**Ne kadar sürer:** Kendi yönettiğiniz hesaplara yayın yapacaksanız
**30–60 dakika**. Başkasının hesabına yayın yapacaksanız haftalar.

**En önemli cümle:**

> Kendi yönettiğiniz profesyonel hesaplara yayın yapıyorsanız **App Review
> GEREKMEZ.** Standard Access otomatiktir.

Resmî metin: "If your app will only be used by app users who have a role on the
app itself, App Review is not required." · "All Business, Consumer, and Gaming
apps are automatically approved for Standard Access for all permissions and
features."

### Adım 1.1 — Developer App oluştur

| | |
| --- | --- |
| **Ekran** | [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App** |
| **Ne seç** | Use cases → **Other** → "Build your own" (ya da doğrudan **Business** app type) |
| **Süre** | 2 dakika |

> **Hangi app type?** Content Publishing rehberi, Facebook Login yolunun
> Business app type olduğunu söyler ("Make sure your app is in Development
> mode or is a Business app type"). Consumer app seçersen App Review ekranı
> farklı akar. **Business seçin.**

### Adım 1.2 — Instagram ürününü ekle

| | |
| --- | --- |
| **Ekran** | Dashboard → **Add product** → **Instagram** → "Connect to Facebook" |
| **Ne yapılır** | Instagram API with **Facebook Login** seçilir (resumable upload yalnız bu yolda var) |
| **Süre** | 2 dakika |

> **İki Instagram seçeneği çıkacak:**
> - "Instagram API with **Facebook Login**" → `graph.facebook.com` +
>   `rupload.facebook.com`, Page ZORUNLU, **resumable upload VAR** → **Bunu seç**
> - "Instagram API with **Instagram Login**" → `graph.instagram.com`, Page
>   gerekmez, **resumable upload YOK** → video'yı public URL'e koymayı
>   gerektirir

### Adım 1.3 — İzinleri ekle

| | |
| --- | --- |
| **Ekran** | Instagram → **Permissions** → "Request permissions" |
| **Süre** | 5 dakika |

| İzin | Zorunlu mu | Neden |
| --- | --- | --- |
| `instagram_content_publish` | **EVET** | Yayınlama |
| `instagram_basic` | **EVET** | Temel hesap erişimi |
| `pages_read_engagement` | **EVET** | Page bilgisi |
| `pages_show_list` | **Önerilir** | `GET /me/accounts` için. Resmî izin tablosunda yok ama gerçek bir Meta izni; **isteyin** |
| `ads_management` / `ads_read` | Koşullu | Page rolü Business Manager'dan verilmişse |
| `business_management` | **Gerekmez** | Publish için gerekli değil |

> **Takılma noktası:** "Request permissions" düğmesi yerine
> "Get Advanced Access" yazıyorsa uygulama Business olarak tanınmıyor ya da
> hesabınız app'e bağlanmamış. Dashboard → **Settings → Basic**'e app'i bir
> Business'e bağlayın. Bağlamak için app üzerinde **Admin** olmanız yeterli;
> Business'in doğrulanmış olması gerekmez.

> **Takılma noktası 2:** "Your app will be able to request permissions for
> users only when it is Live mode" uyarısı çıkabilir. Bu ikinci kurulumda
> kastedilir; bu belgede **kendi hesabınıza** yayın planladığınız için
> Development modda kalmak yeterlidir. Live moda erken geçmek
> ("switching to Live mode prematurely... may make your app unusable for users
> who have a role on the app itself") uyarısı konusunda bilinçli olun.

### Adım 1.4 — Facebook Login for Business yapılandır

| | |
| --- | --- |
| **Ekran** | **Facebook Login for Business** ürünü → **Settings** |
| **Yapılacak** | **Valid OAuth Redirect URIs** altına tam adresi yaz |

```
http://127.0.0.1:4317/api/v1/auth/meta/callback
```

| | |
| --- | --- |
| **Süre** | 3 dakika |

> **Takılma noktası:** Adresin **birebir** eşleşmesi gerekir. Sondaki `/` yok,
> sonrasında `/` var, `localhost` ile `127.0.0.1` aynı sayılmaz. Meta redirect
> URI'yi başlangıçta doğrulamaz; ilk yetkilendirmede hata döner.

### Adım 1.5 — App ID ve Secret al

| | |
| --- | --- |
| **Ekran** | **Settings → Basic** |
| **Al** | **App ID** ve **App Secret** |
| **Süre** | 1 dakika |

`.env` içine:

```ini
SP_META_APP_ID=<App ID>
SP_META_APP_SECRET=<App Secret>
SP_META_REDIRECT_URI=http://127.0.0.1:4317/api/v1/auth/meta/callback
```

> **App Secret**'ı paylaşmayın ve depoya koymayın. `SP_META_APP_SECRET`
> olmadan token değişimi (`code` → `access_token`) yapılamaz.

### Adım 1.6 — Test kullanıcılarını ekle

| | |
| --- | --- |
| **Ekran** | **Roles → Test Users** → "Add People" |
| **Ekle** | Yayın yapacak Instagram/hesap yöneticisinin profilini |
| **Süre** | 2 dakika |

> Bu adım **kendi hesabınız için de yapılmalı.** App'e rolü olmayan hiçbir
> kullanıcı izin veremez; rolü olan kullanıcı Standard Access'i otomatik alır.
> `SP_ADMIN_PASSWORD` arkasındaki oturumun hangi Meta hesabıyla yetkilendiği bu
> adıma bağlıdır.

### Adım 1.7 — 2FA'yı aç

| | |
| --- | --- |
| **Ekran** | Facebook **Settings → Security and login → Two-factor authentication** |
| **Ne yapılır** | Facebook hesabında 2FA aç |
| **Süre** | 5 dakika |

> **Zorunluluk:** Instagram'ın bağlı olduğu **Page**'de 2FA açıksa, Page'i
> yöneten kullanıcının da 2FA yapmış olması gerekir. Bu, Instagram
> hesabının ayarı değil, **Facebook hesabının** ayarıdır. Kapatmayın.

### Adım 1.8 — Page bağlantısını doğrula

| | |
| --- | --- |
| **Ekran** | Instagram → **Instagram API with Facebook Login** → Bağlı hesaplar |
| **Kontrol** | Hedef IG profesyonel hesabı listede ve durumu bağlı mı |

Daha kesin doğrulama, uygulama çalışırken:

```http
GET https://graph.facebook.com/v26.0/me/accounts?fields=name,access_token,instagram_business_account
```

| | |
| --- | --- |
| **Süre** | 5 dakika |

> **Takılma noktası:** IG hesabı **Profesyonel** değilse (kişisel hesap)
> hiçbir adımda görünmez. Instagram mobil uygulaması → Profil → Ayarlar →
> Hesap türü → **Profesyonel** seçeneğine geçin. Business veya Creator olabilir.
>
> **Takılma noktası 2:** Page listeleniyor ama `instagram_business_account`
> boş dönüyorsa IG hesabı o Page'e bağlanmamış. Instagram → Ayarlar → Hesap
> → Bağlı hesaplar üzerinden Page'i seçin.

### Adım 1.9 — İlk yayın kontrolü

Sıra şöyle olmalı:

1. Token al (OAuth)
2. `GET /me/accounts` → Page listesi
3. `GET /{page-id}?fields=instagram_business_account` → **IG user id**
4. `POST /{ig-user-id}/media` (`upload_type=resumable`, `media_type=REELS`)
5. `POST https://rupload.facebook.com/ig-api-upload/v26.0/{container_id}` —
   header **`Authorization: OAuth`**, `offset: 0`, `file_size: <bayt>`
6. `GET /{container_id}?fields=status_code` → `FINISHED` bekle
7. `POST /{ig-user-id}/media_publish` `{"creation_id": "..."}` → `media_id`

> **Container 24 saatte ölür.** Adım 4'ten 7'ye arasında uzun bir bekleme
> olursa container `EXPIRED` olur ve baştan başlamak gerekir.
>
> **Takılma noktası:** Adım 5'te 400 alıyorsanız header yanlıştır. `Bearer`
> değil `OAuth` yazılacak. Adım 2/3 hata veriyorsa izinler eksiktir (1.3'e
> dönün).

### 1.10 — Meta: ne zaman App Review gerekir

| Durum | Gerekir mi |
| --- | --- |
| Kendi yönettiğiniz IG profesyonel hesapları | **HAYIR** |
| Bir ajansın müşteri hesapları (siz yönetmiyorsunuz) | **EVET** — Advanced Access + App Review + Business Verification |
| Kullanıcıların kendi hesaplarına bağlanması | **EVET** |

Advanced Access istenirse:

- Her izin için **ekran kaydı** zorunlu. Eksik kayıt = o izin onaylanmaz.
- Her izin için başvurudan **önceki 30 gün** içinde en az 1 başarılı API çağrısı
  yapılmış olmalı.
- "If we are unable to access your app to test it, **your entire submission will
  be rejected**." → Meta uygulamanıza erişmek zorunda. `127.0.0.1` adresine
  erişemezler; gerçek bir demo ortamı (veya tünel) şart.
- Business Verification **Advanced Access için zorunlu** (1 Şubat 2023'ten
  beri). Advanced Access alan uygulamalar yıllık **Data Use Checkup** da
  tamamlamak zorundadır.

---

## 2. TikTok

**Ne kadar sürer:** Developer Portal'da app kurmak 30 dakika. **App Review
+ denetim: haftalar.** Bu, üç platformun en uzun yoludur.

### ⚠️ 2.0 — Başlamadan önce risk uyarısı (okuyun)

TikTok'un resmî ürün kullanım kuralları şunu söylüyor:

> "Apps must not be for private or personal use."

ve bir yardımcı aracı açıkça **reddedilmiş** bir kullanım örneği olarak
listeleniyor:

> "A utility tool to help upload contents to the account(s) you or your team
> manages" — ❌ **kabul edilmez**

Bu uygulamanın tanımı tam olarak budur: sizin ve ekibinizin yönettiği
hesaplara içerik yükleyen bir yardımcı araç.

**Bu riski bilerek kabul edin:**

| Durum | Risk |
| --- | --- |
| Geniş kitlelere yönelik değil, yalnız kendi hesaplarınızı yönetiyor | **Reddedilme riski yüksek** |
| Araca birden çok işletme/ajans kullanıyor | Product-use rehberi ihlali iddiası |
| Araç, kullanıcıyı TikTok'a götüren bir "Share to TikTok" deneyimi sunuyor | Product-use rehberine **uyar** |

> **Yorum (risk bildirimi):** Uygulama "Share to TikTok" deneyimi olarak
> konumlandırılmamalıdır. Kendi iş akışınızın otomasyon aracı olarak
> kalmalıdır. Bu, teknik bir ayar değil, ürün mimarisi ve arayüz kararıdır.
> Başvuru metninde de aracın "geniş kitlelere yönelik bir platform değil,
> ekibimizin kendi kanal yönetimi için kullandığı dahili bir araç" olduğunu
> açıkça yazın.

Bununla birlikte: resmî olarak tanınan, "Share to TikTok" akışı da vardır ve
onun için de aynı denetim gerekir. Reddedilme olasılığı sıfır değildir.

### Adım 2.1 — Developer Portal'da app oluştur

| | |
| --- | --- |
| **Ekran** | [developers.tiktok.com/apps](https://developers.tiktok.com/apps) → **Create app** |
| **Alanlar** | App Name, App Description, Logo |
| **Süre** | 10 dakika |

### Adım 2.2 — "Content Posting API" ürününü ekle

| | |
| --- | --- |
| **Ekran** | App → **Products** → **Content Posting API** → **Add** |
| **Ne yapılır** | **Direct Post** yapılandırmasını **AÇ** |
| **Süre** | 5 dakika |

> **Neden Direct Post:** İki mod var.
> - **Direct Post** (`/v2/post/publish/video/init/`, scope `video.publish`) →
>   doğrudan yayınlar. **Bunu istiyoruz.**
> - **Upload** (`/v2/post/publish/inbox/video/init/`, scope `video.upload`) →
>   creator'ın inbox'una taslak gönderir, creator TikTok'ta yayınlar.
>
> **Takılma noktası:** Ürün eklenmiş görünüyor ama scope'lar listede yoksa
> "Direct Post" yapılandırması açılmamıştır. Products sayfasında tekrar
> kontrol edin.

### Adım 2.3 — Client Key ve Secret al

| | |
| --- | --- |
| **Ekran** | App → **App Settings** → **Client Key** / **Client Secret** |
| **Süre** | 1 dakika |

`.env` içine:

```ini
SP_TIKTOK_CLIENT_KEY=<Client Key>
SP_TIKTOK_CLIENT_SECRET=<Client Secret>
SP_TIKTOK_REDIRECT_URI=http://127.0.0.1:4317/api/v1/auth/tiktok/callback
```

### Adım 2.4 — Content Posting API erişimini talep et

| | |
| --- | --- |
| **Ekran** | [developers.tiktok.com/apps/publishers/content-posting/](https://developers.tiktok.com/apps/publishers/content-posting/) |
| **Ne yapılır** | **"Content Posting API access"** / erişim talebi formu |
| **Süre** | Form 15 dakika, cevap **günler–haftalar** |

> Bu adım, app'i oluşturmaktan **tamamen ayrıdır** ve sık atlanır. Ürünü
> eklemek erişim vermek değildir.

### Adım 2.5 — Scope'ları seç

| | |
| --- | --- |
| **Ekran** | App → **Permissions** (veya scope talep ekranı) |
| **Süre** | 10 dakika |

| Scope | Zorunlu mu | Ne için |
| --- | --- | --- |
| `video.publish` | **EVET** | Direct Post yayını |
| `user.info.basic` | **EVET** | `open_id` ve kullanıcı bilgisi (hesap bağlama) |
| `video.list` | Kalıcı bağlantı için | `/v2/video/query/` — permalink almak |
| `video.upload` | **HAYIR** | Inbox akışı; kullanmıyoruz |

> **Zorunlu kural:** "Your app must be approved for the `video.publish` scope."
> Scope'u istemek yetmez, **onaylanması** gerekir. Onay gelmeden
> yetkilendirme denemesi 401 `scope_not_authorized` döner.

> **Takılma noktası:** `video.list` istenmezse kalıcı bağlantı (permalink)
> **alınamaz.** `status/fetch` yalnız herkese açık + moderasyon onaylı içerik
> için `post_id` döner, ve o zaman bile paylaşım adresi değildir. Permalink
> istiyorsanız bu scope **şimdi** isteyin — sonra eklemek yeniden incelemeye
> girer.

### Adım 2.6 — Redirect URI kaydet

| | |
| --- | --- |
| **Ekran** | App → **Redirect URI** alanı (en fazla 10 tane) |
| **Yaz** | `http://127.0.0.1:4317/api/v1/auth/tiktok/callback` |
| **Süre** | 2 dakika |

| Kural | Değer |
| --- | --- |
| Maksimum adet | 10 |
| Tür | **Statik** (wildcard `*` yok) |
| Şema | `https` zorunlu — `http://127.0.0.1` **localhost istisnasıyla** kabul edilir |

> **Takılma noktası:** TikTok, meslekî olmayan/yerel redirect URI'leri
> kabul etmeyebilir. "Invalid redirect_uri" hatası alırsanız:
> 1. Adresin `.env`'dekiyle **birebir** aynı olduğunu kontrol edin.
> 2. `localhost:4317` ile `127.0.0.1:4317` aynı sayılmaz.
> 3. Erişilemiyorsa son çare: `SP_PUBLIC_BASE_URL` üzerinden bir tünel açıp
>    `https://` adresini kaydedin. `SP_TIKTOK_REDIRECT_URI`'yi de ona
>    değiştirin.
>
> **Doğrulanmadı:** TikTok'un `http://127.0.0.1` redirect URI'yi kabul ettiği
> resmî dokümanda açıkça yazmıyor. ARAYÜZ-2026-09-30 itibarıyla localhost
> redirect akışı çalışıyor, ama bu bir **yorum**, resmî garanti değil.

### Adım 2.7 — Sandbox kullanıcısı ekle

| | |
| --- | --- |
| **Ekran** | App → **Sandbox** → **Add user** |
| **Süre** | 10 dakika |

| Limit | Değer |
| --- | --- |
| App başına sandbox | En fazla **5** |
| Sandbox başına kullanıcı | En fazla **10** |
| Public yayın | **YASAK** |

> "Sandbox mode does not offer access to Content Posting API for public videos."

**Bu, test stratejisini belirler.** Sandbox'ta yapabilecekleriniz:

- ✅ Token alma ve yenileme (refresh token rotasyonu dahil)
- ✅ `creator_info/query/` → `privacy_level_options`, `max_video_post_duration_sec`
- ✅ `video/init/` → `publish_id` + `upload_url` alma
- ✅ Chunk yükleme ve `uploaded_bytes` ilerlemesi
- ✅ `status/fetch` → `PROCESSING_UPLOAD`, `FAILED` + `fail_reason`
- ❌ **Public yayın YAPILAMAZ**

> **Sonuç:** Sandbox "yayın çalışıyor mu" sorusunu cevaplamaz. Yalnız
> "istek doğru gidiyor mu" sorusunu cevaplar. Gerçek yayın testi, denetim
> geçene kadar **gerçek bir hesapla `SELF_ONLY`** görünürlükte yapılır.

### Adım 2.8 — App Review başvurusu

Bu, en uzun ve en çok reddedilen adımdır.

| | |
| --- | --- |
| **Ekran** | App → **App Review** → Content Posting API |
| **Süre** | Hazırlık 2–3 saat, cevap **"several days to two weeks"** |

**Hazırlayacağınız materyaller:**

| Materyal | Gereklilik |
| --- | --- |
| App adı | Net ve gerçekçi; "test app" gibi isimler riskli |
| Açıklama | 2.0'daki ürün-riski notuna uygun yazın |
| Web sitesi | **Yayınlanmış, erişilebilir** bir site. 404 veren site red sebebi |
| Privacy Policy | **Görünür** bağlantı. Gizli sayfa kabul edilmez |
| Terms of Service | **Görünür** bağlantı |
| 1–5 demo video | Her biri **en fazla 50 MB** |
| Reviewer erişimi | **Ücretsiz demo hesap** — TikTok, sanatçı hesabı da olabilir |

> **Takılma noktası (en sık red):** "Reviewer'lara ücretsiz demo hesap
> erişimi" zorunludur ve sık atlanır. TikTok'un inceleyicisi kendi
> hesabıyla giriş yapıp yayınlamayı deneyecektir. Bu hesabın:
> - `video.publish` scope'unu **vermiş** olması,
> - Denetim kısıtına **takılmaması** (hesap `private` olabilir),
> - Boşta veya spam'e düşmemiş olması gerekir.
>
> **Takılma noktası 2:** Demo videolar 50 MB sınırını aşarsa başvuru
> otomatik elenir. Büyük videoyu `ffmpeg` ile küçültün.
>
> **Takılma noktası 3:** Privacy Policy sayfası Google Sites, Notion ya da
> GitHub Pages olabilir — sorun değil. Sorun olan, sayfanın **gerçekten
> erişilebilir** olmamasıdır. Giriş gerektirmemesi gerekir.

**Takılma noktası (reddedilme):** Başvuru metninde aracı "kendi hesaplarımı
yönetmek için kullandığım yardımcı" olarak tanımlarsanız 2.0'deki kural
tetiklenebilir. Aracın kullanıcı kitlesini, neyi çözdüğünü ve neden bu API'yi
seçtiğinizi somut olarak anlatın.

### Adım 2.9 — Denetim (audit) — public yayın için zorunlu

App Review onayı **yetmez.** Public yayın için ayrıca denetim gerekir.

> "All content posted by unaudited clients will be restricted to **private
> viewing mode**."

Denetim geçene kadar:

| Kısıt | Değer |
| --- | --- |
| Kullanıcı tavanı | **5 kullanıcı / 24 saat** |
| Görünürlük | Yalnız **`SELF_ONLY`** |
| Hesap görünürlüğü | Hesaplar `private` olmalı |

Denetimden sonra public yapmak **iki adımlık ve hesap sahibinin işidir:**

1. Hesap sahibi hesabı önce **public** yapar
2. Sonra **her içeriğin** gizliliğini "Everyone" yapar

Bu, otomasyonla yapılamaz. Uygulamanın bu iki adımı kullanıcıya hatırlatması
gerekir — aksi halde "yayınlandı ama kimse görmüyor" destek talebi gelir.

### 2.10 — TikTok: bilmeniz gereken diğer kurallar

| Konu | Kural | Nereden |
| --- | --- | --- |
| **Dosya aktarım yöntemi** | Sunucu diskinizde video varsa TikTok `PULL_FROM_URL` önerir (`FILE_UPLOAD` değil) | Content Sharing Guidelines |
| **Alan adı doğrulama** | `PULL_FROM_URL` kullanacaksanız alan adı/URL öneki doğrulanmalı | App → **Manage URL properties** |
| **Gizlilik seçeneği** | `creator_info` dönen seçenekleri **arayüzde göstermek zorunlu**; başka değer 403 `privacy_level_option_mismatch` döner | Direct Post referansı |
| **Süre kontrolü** | `max_video_post_duration_sec` değerine **uymak zorunlu** (300 sn olabilir) | Content Sharing Guidelines |
| **Access token** | 24 saat | — |
| **Refresh token** | 365 gün. **Dönen yeni token ile değiştirilmek zorunlu**, eskisi geçersizleşir | — |
| **Hız sınırı** | init 6/dk · status 30/dk · creator_info 20/dk | — |

**`SP_PUBLIC_BASE_URL` neden önemli:** İki ayrı nedenle gerekebilir.

1. `PULL_FROM_URL` kullanırsanız TikTok videoyu bu adresten çekecek → adres
   **herkese açık** olmalı
2. Arayüze uzaktan erişmek isterseniz

Instagram ve YouTube'da tünel gerekmez. TikTok'ta `PULL_FROM_URL`'ya geçerseniz
gerekebilir.

```ini
SP_PUBLIC_BASE_URL=https://<tunnel-adresiniz>
SP_ALLOW_PRIVATE_MEDIA_URL=false
```

> **Varsayılanı değiştirmeyin.** `SP_ALLOW_PRIVATE_MEDIA_URL=true`, Meta'nın
> "public server" kuralını ihlal eden özel adresler üretmeye izin verir.
> Yanlışlıkla `true` yapılırsa sorun Instagram'da çıkar.

---

## 3. YouTube

**Ne kadar sürer:** Proje + OAuth istemcisi 30 dakika. **Compliance audit:
haftalar.** Bu olmadan yüklemeler `private` kilitli kalır.

### Adım 3.1 — Google Cloud projesi oluştur

| | |
| --- | --- |
| **Ekran** | Google Cloud Console → **Proje oluştur** |
| **Proje adı** | Örn. `social-publish-local` |
| **Süre** | 3 dakika |

> **Proje tipi seçimi (kritik):** Google Cloud projesi oluştururken "Workspace"
> veya "Cloud Identity" seçtiyseniz bu **Workspace projesidir** ve Adım 3.3'te
> 7 günlük sınırından kurtulmanızı sağlar. Kişisel Google hesabınızla
> oluşturduğunuz proje normal projedir.

### Adım 3.2 — YouTube Data API v3'ü etkinleştir

| | |
| --- | --- |
| **Ekran** | **APIs & Services → Library** → "YouTube Data API v3" → **Enable** |
| **Süre** | 2 dakika |

> **Takılma noktası:** API etkinleşmeden OAuth consent ekranı açılmaz.
> "youtube" adı aratıp **"YouTube Data API v3"**'ü seçin; sayfada birden çok
> "YouTube" ürünü vardır.

### Adım 3.3 — OAuth consent ekranı — 7 günlük sınır burada

| | |
| --- | --- |
| **Ekran** | **APIs & Services → OAuth consent screen** |
| **Süre** | 10 dakika |

| Ayar | Değer | Not |
| --- | --- | --- |
| User type | **External** veya **Internal** | Aşağıya bakın |
| App name | `social-publish` | |
| User support email | Sizin e-posta | |
| Developer contact | Sizin e-posta | Zorunlu |

**⚠️ External + Testing seçerseniz refresh token 7 GÜN SONRA iptal edilir.**

Bu kısıt YouTube kapsamları için **istisnasızdır.** 7 gün sonra uygulama
"yeniden yetkilendirme" hatası verir ve zamanlanmış yayın ürünü çalışmaz.

**Kurtarma yolları:**

| Yol | Gereken | Ne kadar |
| --- | --- | --- |
| **(a) En kısa** | **Workspace / Cloud Identity** projesi + consent ekranı **"Internal"** kullanıcı tipi | 15 dakika |
| **(b)** | Consent ekranını **"In Production"** durumuna alın | Değişken |
| **(c)** | **Tam doğrulama** (verification) tamamlayın | Günler–haftalar |

> **Yorum:** Bu uygulama yerelde ve tek kullanıcı tarafından işletiliyor.
> Yol (a) en uygunu: proje Workspace altında açılır, consent ekranı Internal
> olur, 7 günlük sınır hiç uygulanmaz. Yol (b) ve (c) harici kullanıcı
> varsayıyor.
>
> **Doğrulanmadı:** Kişisel (Workspace olmayan) projede "Internal" kullanıcı
> tipi seçilebilir mi, resmî dokümanda açıkça yazmıyor. Workspace projesi
> güvenli seçenektir.

### Adım 3.4 — OAuth Client ID oluştur

| | |
| --- | --- |
| **Ekran** | **APIs & Services → Credentials** → **Create Credentials** → **OAuth client ID** |
| **Application type** | **Web application** |
| **Süre** | 5 dakika |

**Authorized redirect URIs:**

```
http://127.0.0.1:4317/api/v1/auth/youtube/callback
```

**Authorized JavaScript origins** (isteğe bağlı, arayüz tarayıcıdan çağrılıyorsa):

```
http://127.0.0.1:4317
```

`.env` içine:

```ini
SP_GOOGLE_CLIENT_ID=<Client ID>
SP_GOOGLE_CLIENT_SECRET=<Client Secret>
SP_GOOGLE_REDIRECT_URI=http://127.0.0.1:4317/api/v1/auth/youtube/callback
```

> **Takılma noktası:** "Web application" seçilmezse (Desktop app) redirect URI
> `http://localhost` olarak sabitlenir ve sizin adresinizle eşleşmez.
> **Web application** seçin.

### Adım 3.5 — Scope'ları belirle

`.env`'de scope yok; uygulama kodu sabit ister. Doğru liste:

| Scope | Neden |
| --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | `videos.insert` (yükleme) |
| `https://www.googleapis.com/auth/youtube.force-ssl` | **Zorunlu** |
| `https://www.googleapis.com/auth/youtube` | `videos.update` için gerekir |
| `https://www.googleapis.com/auth/yt-analytics.readonly` | Analitik isteniyorsa |

> ⚠️ **`videos.update` `youtube.upload`'u kabul etmez.** Yükleme `youtube.upload`
> ile yapılır, ama `privacyStatus` / `publishAt` güncellemesi `videos.update`
> ile yapılır ve bu çağrı için `youtube` (veya en azından `force-ssl`) gerekir.
> Token elde ederken **ikisini de** isteyin.

> ⚠️ **`youtubers` scope YOKTUR.** Bu, eski YouTube CMS / Analytics v1
> kalıntısıdır; dokümanda 0 eşleşme bulunur, sayfa 404 verir. Kanal
> gruplarını almak için `channels.list?managedByMe=true` kullanılır.

### Adım 3.6 — Compliance audit başvurusu

**Bu adım atlanırsa hiçbir şey görünmez.**

| | |
| --- | --- |
| **Ekran** | [support.google.com/youtube/contact/yt_api_form](https://support.google.com/youtube/contact/yt_api_form) |
| **Ne yapılır** | "Complete an audit for demonstrating API compliance" seçeneği |
| **Süre** | Form 1 saat, cevap **haftalar** |

> "All videos uploaded via the `videos.insert` endpoint from **unverified API
> projects created after 28 July 2020 will be restricted to private viewing
> mode**. To lift this restriction, each API project must undergo an **audit**."

**Bu adım öncesi ne olur:**

| Durum | Sonuç |
| --- | --- |
| Doğrulanmamış projeye yükleme | ✅ Yükleme **başarılı** olur, `video.id` döner |
| | ❌ Video **`private`** kalır, kimse göremez |
| Doğrulanmış projeye yükleme | ✅ Herkese açık |

**Takılma noktası (en sinsi hata):** Yükleme HTTP 200 döndüğü için
program "başarılı" der. Video gerçekte görünmezdir. Denetim tamamlanana kadar
**her yüklemeden sonra `videos.list` ile `status.privacyStatus` kontrolü**
yapılmalıdır. Aksi halde uygulama yanlış başarı raporlar.

Form doldurulurken istenen bilgiler:

| Alan | Ne yazılır |
| --- | --- |
| Project ID | Google Cloud proje numarası |
| Tahmini günlük kota | `videos.insert` için günde kaç yükleme bekleniyor |
| Peak per minute | Yoğun saatteki yükleme sayısı |
| **"Significant independent value"** | **En kritik alan.** "YouTube ekosistemine ve kullanıcılarına bağımsız değer" sağladığınızı somut anlatın |
| Web sitesi | Uygulamanın sitesi |
| Video kanalı | Test yapılacak kanal |

> **Doğrulanmadı:** "Significant independent value" kriterinin tam ölçütü
> resmî olarak tanımlı değil. "İçerik yükleyip zamanlayan yardımcı araç"
> cevabı yeterli kabul edilebilir, ama kabul garantisi yoktur.

### Adım 3.7 — İlk yetkilendirme ve kanal onayı

| | |
| --- | --- |
| **Süre** | 5 dakika |

Tarayıcıda:

1. Uygulamanın yetkilendirme bağlantısı açılır
2. Google hesabı seçilir
3. **"Google hasn't verified this app"** ekranı çıkar → **Advanced → Go to
   Social Publish (unsafe) → Allow**
4. Kanal seçilir (birden fazla kanal varsa liste çıkar)
5. Onaylanır

> **Takılma noktası (beklenen, hata değil):** Consent ekranı Testing'deyse
> uyarı bandı çıkar. Bu normaldir. Ayarlardan "Add test users" ile kendi
> hesabınızı ekleyin.
>
> **Takılma noktası 2:** "The app is blocked" hatası → consent ekranında
> hedef kullanıcı test kullanıcısı değildir.
>
> **Takılma noktası 3:** `redirect_uri_mismatch` → Adım 3.4'teki adresle
> `.env`'deki adres birebir aynı olmalı.

Kanal doğrulaması (hangi kanalları yönetebiliyorsunuz):

```http
GET https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,id
    &mine=true
    &managedByMe=true
```

### 3.8 — YouTube: ilk yayın kontrolü

```http
POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status
```

```json
{
  "snippet": { "title": "Test", "description": "Test açıklaması", "tags": ["test"] },
  "status": {
    "privacyStatus": "private",
    "publishAt": "2026-10-01T09:00:00Z",
    "selfDeclaredMadeForKids": false,
    "containsSyntheticMedia": true,
    "license": "youtube"
  }
}
```

| Adım | Beklenen |
| --- | --- |
| `POST` | 200 + `Location` header |
| `PUT <Location>` | 200/201 + video kaynağı (`id`, `snippet`, `status`) |
| `GET /videos?id=...&part=status` | `privacyStatus: "private"` ise denetim bekleniyor |

> **Takılma noktası:** `403 forbidden` alıyorsanız scope eksiktir. Adım 3.5'teki
> dört scope'un tamamını istediğinizden emin olun; özellikle `force-ssl`.
>
> **Takılma noktası 2:** `400 invalidTags` — `tags` boş string olamaz. Boş
> göndermek için alanı tamamen çıkarın, `""` yazmayın.

---

## 4. Ortak: `.env` anahtar sözlüğü

Aşağıdaki tablo `app/.env.example` dosyasıyla **birebir** çapraz kontrol
edilmiştir. Her anahtar `.env.example`'da mevcuttur.

| `.env` anahtarı | Kaynağı | Zorunlu mu | Bu belgede hangi adım |
| --- | --- | --- | --- |
| `SP_META_APP_ID` | Meta → Settings → Basic → **App ID** | Hayır¹ | 1.5 |
| `SP_META_APP_SECRET` | Meta → Settings → Basic → **App Secret** | Hayır¹ | 1.5 |
| `SP_META_REDIRECT_URI` | `http://127.0.0.1:4317/api/v1/auth/meta/callback` | Hayır¹ | 1.4 |
| `SP_TIKTOK_CLIENT_KEY` | TikTok → App Settings → **Client Key** | Hayır¹ | 2.3 |
| `SP_TIKTOK_CLIENT_SECRET` | TikTok → App Settings → **Client Secret** | Hayır¹ | 2.3 |
| `SP_TIKTOK_REDIRECT_URI` | `http://127.0.0.1:4317/api/v1/auth/tiktok/callback` | Hayır¹ | 2.6 |
| `SP_GOOGLE_CLIENT_ID` | Google Cloud → Credentials → **Client ID** | Hayır¹ | 3.4 |
| `SP_GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials → **Client Secret** | Hayır¹ | 3.4 |
| `SP_GOOGLE_REDIRECT_URI` | `http://127.0.0.1:4317/api/v1/auth/youtube/callback` | Hayır¹ | 3.4 |
| `SP_MASTER_KEY` | **Elle üretilir** (`randomBytes(32)`) | **EVET** | 0 |
| `SP_ADMIN_PASSWORD` | **Elle seçilir** (≥ 12 karakter) | **EVET** | 0 |
| `SP_PUBLIC_BASE_URL` | Tünel adresi (gerekirse) | Hayır | 2.10 |
| `SP_ALLOW_PRIVATE_MEDIA_URL` | `false` bırakın | Hayır | 2.10 |
| `SP_TIMEZONE` | `Europe/Istanbul` | Hayır | — |
| `SP_PUBLISH_CONCURRENCY` | `1` bırakın | Hayır | — |
| `SP_SCHEDULER_TICK_MS` | `15_000` bırakın | Hayır | — |
| `HOST` / `PORT` | `127.0.0.1` / `4317` | Hayır | — |
| `NODE_ENV` | `development` | Hayır | — |
| `SP_DATA_DIR` / `SP_STORAGE_DIR` / `SP_DATABASE_FILE` | Varsayılanlar | Hayır | — |
| `SP_INGEST_KEYS` | `npm run sp -- api-key create <proje>` | Hayır | — |

¹ **"Hayır"** demek: anahtar boş bırakılırsa uygulama **mock modunda** çalışır ve
gerçek yayın yapmaz. Yani bu anahtarlar başlangıçta zorunlu değildir, ancak
gerçek yayın için **zorunludur**. `SP_MASTER_KEY` ve `SP_ADMIN_PASSWORD`
dışındaki hiçbir anahtar boşsa uygulama hata vermez — bu, "yarım
yapılandırılmış" sessiz hatayı bilinçli olarak önlemek içindir.

### 4.1 Tamamlanma kontrol listesi

| # | Kontrol | Nasıl |
| --- | --- | --- |
| 1 | `SP_MASTER_KEY` 32 bayt base64 mi | `node -e "console.log(Buffer.from(process.env.SP_MASTER_KEY,'base64').length)"` → `32` |
| 2 | `SP_ADMIN_PASSWORD` ≥ 12 karakter | elle sayın |
| 3 | Meta redirect URI birebir eşleşiyor | 1.4 |
| 4 | TikTok redirect URI kayıtlı ve statik | 2.6 |
| 5 | Google redirect URI **Web application** istemcisinde | 3.4 |
| 6 | Meta'da test kullanıcısı eklendi | 1.6 |
| 7 | Facebook 2FA açık | 1.7 |
| 8 | IG hesabı profesyonel ve Page'e bağlı | 1.8 |
| 9 | TikTok `video.publish` scope'u **onaylandı** | 2.5 |
| 10 | YouTube compliance audit **başvuruldu** | 3.6 |
| 11 | YouTube consent ekranı Testing'de değil **ya da** Workspace projesi | 3.3 |
| 12 | Google'da `force-ssl` dahil tüm scope'lar isteniyor | 3.5 |
| 13 | `SP_PUBLIC_BASE_URL` yalnız TikTok `PULL_FROM_URL` kullanıyorsanız | 2.10 |
| 14 | `.env` depoya eklenmemiş | `git status` |

### 4.2 Kurulum süresi özeti

| Platform | Yalnız kendi hesaplarınız | Başkasının hesaplarına yayın |
| --- | --- | --- |
| **Instagram / Meta** | **30–60 dakika** | Haftalar (App Review + Business Verification) |
| **TikTok** | **Haftalar** (App Review + denetim) | Haftalar |
| **YouTube** | **Günler** (compliance audit) | Günler |

**Tavsiye sırası:** Önce **Instagram** ile başlayın (en hızlı, gerçek uçtan uca
test yapılabilen tek yol). Sonra **YouTube** (denetim başvurusu en uzun sürüyor,
**derhal** başlatın). TikTok en sona bırakın.

### 4.3 Bilinmeyenler (bu belgede doğrulanamayanlar)

| Konu | Durum |
| --- | --- |
| TikTok `http://127.0.0.1` redirect URI'yi kabul ediyor mu | Resmî dokümanda yazmıyor; akış şu an çalışıyor ama garanti değil |
| Kişisel Google projesinde "Internal" consent kullanılabilir mi | Yazmıyor; Workspace projesi güvenli seçenek |
| Meta localhost/tünel adresini kabul ediyor mu | Hiçbir yerde ifade yok; yalnız App Review için "erişebilmeliyiz" deniyor |
| Meta App Review gerçek süresi | Resmî sayı yok; "1 haftadan az, genelde 2-3 gün" ifadesi belgede bulunamadı |
| TikTok App Review gerçek süresi | "Several days to two weeks" deniyor, resmî sabit süre yok |
| YouTube compliance audit gerçek süresi | Resmî sayı yok |
| YouTube "significant independent value" kriteri | Ölçütü tanımlanmamış |
| Meta'da `https` zorunlu mu | Doküman yalnız "public server" diyor |
