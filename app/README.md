# social-publish

AI projelerinde üretilen **9:16 dikey reklam videolarını** Instagram, TikTok ve
YouTube'a zamanlanmış olarak yayınlayan panel + yayın motoru.

Tek kullanıcılık, yerelde çalışan bir araç. Harici servis yok, Redis yok, kuyruk
yok — kuyruk SQLite'ın kendisi.

---

## Durum (dürüst özet)

| Parça | Durum |
| --- | --- |
| Veritabanı (10 tablo, 3 migration) | ✅ |
| Medya (ffprobe/ffmpeg, depolama, 9:16 denetimi) | ✅ |
| Saf kurallar (retry, hata eşleme, metin, takvim, durum makinesi) | ✅ |
| Yayın motoru + zamanlayıcı + sahte sağlayıcı | ✅ uçtan uca kanıtlandı |
| HTTP API + ingest + CLI | ✅ |
| Panel (React + Vite + Tailwind) | ✅ |
| **YouTube adaptörü** | ✅ kod tam, **canlı deneme yapılmadı** (kimlik gerekli) |
| Instagram adaptörü | ⏳ sırada |
| TikTok adaptörü | ⏳ sırada (aşağıdaki uyarı) |
| Analitik geri çekme | ⏳ sırada |

Sağlayıcı anahtarı girilene kadar uygulama **"SAHTE YAYIN MODU"nda** çalışır:
panelin üstünde kapatılamayan bir şerit bunu sürekli söyler. Sahte modda hiçbir
içerik gerçekten Instagram/TikTok/YouTube'a gitmez.

---

## Hızlı başlangıç

```sh
npm install
cp .env.example .env        # en az SP_MASTER_KEY ve SP_ADMIN_PASSWORD doldur
npm run migrate             # veritabanını kur
npm run dev                 # API :4317 + panel :5173
```

`SP_MASTER_KEY` üretmek:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Bu anahtarı kaybetme.** Kayıtlı token'lar bu anahtarla çözülür; kaybolursa
tüm hesap bağlantıları yeniden kurulmak zorunda kalır.

Panel varsayılan olarak `http://127.0.0.1:5173` üzerinden API'ye proxy yapar.
Uzaktan (telefondan) erişmek istersen `SP_PUBLIC_BASE_URL` ver ve bir tünel aç —
**ancak videolar için tünel gerekmiyor**, aşağıya bak.

---

## İçerik nasıl beslenir

Uygulamanın asıl giriş kapısı. Üç yol:

**1. Komut satırı** (AI projelerinin en doğal yolu)

```sh
npm run sp -- ingest \
  --file C:/projeler/urun/reels/v3.mp4 \
  --project urun-3 \
  --platforms instagram,youtube \
  --caption "Yeni koleksiyon" \
  --hashtags "moda,yeni" \
  --at "2026-10-05T18:00" \
  --json
```

**2. HTTP + API anahtarı** (bir AI projesi uygulamaya dosya gönderebilir)

```sh
npm run sp -- api-key create urun-3     # anahtarı bir kez gösterir
curl -X POST http://127.0.0.1:4317/api/v1/ingest \
  -H "X-Api-Key: sp_..." \
  -F file=@v3.mp4 -F project=urun-3 -F platforms=instagram,youtube \
  -F caption="Yeni koleksiyon" -F scheduledAt=2026-10-05T18:00
```

**3. Panelden** sürükle-bırak.

Besleme sonrası:

- Video teknik olarak denetlenir (çözünürlük, süre, fps, codec, boyut, oran).
- **Hata varsa içerik `draft` kalır ve kuyruğa girmez** — gerekçe panelde görünür.
- Reklam içeriği olduğu için **onay zorunludur.** `--no-approval` yalnız
  otomasyon içindir.
- Onaydan sonra iş zamanlanır, motor sırası gelince yayınlar.

---

## Herkese açık adres gerekmiyor

2026 itibarıyla **hiçbir platform videoyu çekmiyor** — hepsine dosya yükleniyor:

| Platform | Yöntem | Kaynak |
| --- | --- | --- |
| Instagram | resumable upload (`rupload.facebook.com`) | Facebook Login yolu |
| TikTok | `FILE_UPLOAD` — ikili, sıralı parçalar | Content Posting API |
| YouTube | resumable upload | Data API v3 |

`SP_PUBLIC_BASE_URL` yalnızca **panele uzaktan erişmek** için gerekir.
Daha önce planlanan tünel zorunluluğu araştırma sonucunda ortadan kalktı.

---

## ⚠️ TikTok hakkında bilmen gereken şey

TikTok'un resmî app review kuralı şu uygulama modelini açıkça **kabul edilemez**
sayıyor:

> *"A utility tool to help upload contents to the account(s) you or your team
> manages"* — ❌

Yani "AI projelerinin çıktısını kendi hesaplarına yükleyen araç" tarif ettiğin
şey, TikTok'a başvurulduğunda **reddedilebilir**. Bu bir kod sorunu değil, ürün
konumlandırması sorunu. İki seçenek:

1. **TikTok'u hedefe alma.** Instagram + YouTube ile başla, sonra karar ver.
2. **Geniş kitleye yönelik konumlandır** (ücretli bir SaaS gibi), o zaman
   başvuru şansın var ama review 1-2 hafta sürer ve çalışan bir demo video,
   web sitesi, Privacy Policy + ToS ister.

Kod tarafında karar **"TikTok sona kalır"** şeklinde verildi: adaptör yazılacak
ama canlıya alınmayacak. Karar senin.

---

## Diğer bilmen gereken kısıtlar

| Konu | Durum |
| --- | --- |
| Instagram app review | **Kendi hesaplarına yayın yapıyorsan gerekmiyor.** Başkasının hesabına yapıyorsan gerekli. |
| Instagram kotası | İki resmî sayfa farklı sayı veriyor (100/24s ve 50). Uygulama **canlı okuyor**, sabit yazmıyor. |
| YouTube doğrulaması | Doğrulanmamış projede yüklemeler `private`'a kilitli. Compliance audit şart. |
| YouTube 7 gün | OAuth consent "Testing" modundaysa refresh token 7 gün sonra ölür. |
| TikTok denetimi | Denetimden geçmemiş istemci sadece `SELF_ONLY` yayınlayabilir. |

---

## Komutlar

```sh
npm run typecheck      # tip kontrolü
npm test               # tüm testler
npm run dev            # API + panel
npm run migrate        # veritabanı kur
npm run sp -- setup check          # eksik anahtarları listeler
npm run sp -- accounts list
npm run sp -- content list --state=scheduled
npm run sp -- jobs list --platform=instagram
npm run sp -- scheduler run        # tek tur
npm run sp -- ingest --help
```

---

## Dizin düzeni

```
src/contract/   paylaşılan şekiller (sunucu + panel ortak)
src/ports/      arayüzler (adaptörlerin uyması gereken sözleşme)
src/domain/     saf iş kuralları — I/O yok, tamamı testli
src/adapters/   gerçek ve sahte dış sistemler
src/services/   yayın motoru + zamanlayıcı
src/db/         SQLite, migration, repository
src/media/      ffprobe/ffmpeg, depolama, platform kısıtları
src/ingest/     besleme akışı + uygulama politikası
src/http/       Fastify sunucusu
src/cli/        komut satırı
web/            React panel
migrations/     sıra numaralı SQL
docs/           araştırma, mimari, kimlik kurulumu
```

**Katman kuralı:** `domain` ve `services` hiçbir kütüphaneye doğrudan dokunmaz.
`fetch`, `better-sqlite3`, `ffmpeg` yalnızca `adapters/` ve alt katmanlarda
bulunur. Bunun ödülü: gerçek yayıncı ile sahte yayıncı **aynı testleri** geçer.

---

## Ayrıntılı dokümanlar

- `docs/ARASTIRMA.md` — üç platformun doğrulanmış API kuralları + bilinmeyenler
- `docs/KIMLIK-KURULUMU.md` — sıfırdan kimlik kurulumu, adım adım
- `docs/MIMARI.md` — tasarım kararları ve bilinen riskler
- `docs/ARASTIRMA-KAYNAKLARI.md` — resmî kaynak listesi
- `.env.example` — tüm anahtarların açıklamasıyla

Panelde **Kurulum** ekranı, eksik anahtarları ve ilgili doküman bölümünü gösterir.
