# Orchestra — opencode için mimar-merkezli orkestrasyon

Karmaşık bir işi alırsın; sistem işi böler, doğru rollere **paralel** dağıtır, sonucu
**doğrular** ve hatalardan **kalıcı ders** çıkararak bir sonraki sefer daha akıllı başlar.
Gerektiğinde **tam otonom** çalışır, durursan kaldığı yerden devam eder.

Bağımlılığı yoktur: saf opencode yapılandırması + tek bir küçük plugin. Klasörü olduğu gibi
başka bir projeye kopyalarsan sistem tamamen taşınır.

---

## Hızlı başlangıç

```sh
npm install                    # yalnızca plugin için (@opencode/plugin)
opencode                       # mimar rolü otomatik açılır
```

Sohbette:

```
/orchestrate <görev>          # tam akış: brifing → bölüm → paralel → doğrulama → ders
/auto <görev>                 # aynı akış, her turda rapor vererek otonom ilerler
/loop <hedef> --max=10        # duraklatılabilir, rapor tabanlı otonom döngü
/loop stop                    # döngüyü o noktada durdur
/loop status                  # nerede olduğunu göster
/recall <konu>                # bu konuda hangi dersler var?
/standup                      # hedef + döngü + hafıza sağlığı tek ekranda
/cast <talimat>               # rol ekle/çıkar, yetenek genişlet
```

Sıradan bir cümle de yeter; mimar kendi akışını kurar.

---

## Katmanlar

```
opencode.jsonc                     yapılandırma, izinler, worktree
AGENTS.md                          deponun çalışma kuralları (otomatik yüklenir)
.opencode/
├── agents/
│   ├── architect.md               ORKESTRATÖR (primary)
│   └── crew/                      işçi roller (subagent)
│       ├── scout.md               keşif        · salt-okunur
│       ├── analyst.md             analiz       · salt-okunur
│       ├── researcher.md          dış araştırma · salt-okunur
│       ├── critic.md              red-team      · salt-okunur
│       ├── maker.md               üretim/değişiklik
│       ├── verifier.md            doğrulama/test (düzeltmez)
│       ├── curator.md             hafıza bakımı (sadece hafıza dosyaları)
│       ├── scribe.md              dokümantasyon
│       └── operator.md            ortam/CI/CD (yıkıcı işlemde durur)
├── skills/                        iş protokolleri (model bunları yükler)
│   ├── brief/SKILL.md             brifing
│   ├── dispatch/SKILL.md          iş bölümü + paralel sevkiyat
│   ├── loop/SKILL.md              otonom döngü sözleşmesi
│   ├── lesson/SKILL.md            hatadan ders çıkarma
│   └── cast/SKILL.md              kadro yönetimi
├── commands/                      /orchestrate /auto /recall /standup /cast
├── plugins/orchestra/             hafıza motoru + otonom döngü
└── memory/
    ├── lessons.jsonl              kalıcı dersler (versiyonlanır)
    └── state.json                 döngü durumu + plugin tanılaması (geçici)
```

Roller, beceriler ve komutlar **düz dosyadır**. Eklemek = dosya eklemek, çıkarmak = dosya
silmek. Kod bilmene gerek yok.

---

## Kadro

| Rol | Ne yapar | Değiştirir mi | Model (ücretsiz) |
| --- | --- | --- | --- |
| `architect` | böler, dağıtır, sentezler, doğrulatır | evet | `longcat-2.5-preview-free` |
| `crew/scout` | keşif, haritalama | hayır | `nemotron-3.5-lightning-free` |
| `crew/analyst` | seçenek karşılaştırma, karar zemini | hayır | `longcat-2.5-preview-free` |
| `crew/researcher` | web/doküman araştırması, kaynaklı | hayır | `nemotron-3-ultra-free` |
| `crew/critic` | red-team, kalite, regresyon | hayır | `longcat-2.5-preview-free` |
| `crew/maker` | dosya/ortam/ürün değişikliği | evet | `mimo-v2.6-flash-free` |
| `crew/verifier` | test/build, gerçek kanıt | **hayır** (çalıştırır) | `nemotron-3-ultra-free` |
| `crew/curator` | hafızayı düzenler | sadece hafıza | `nemotron-3-ultra-free` |
| `crew/scribe` | dokümantasyon, rapor | evet | `ling-3.0-flash-fin-free` |
| `crew/operator` | ortam, servis, dağıtım | evet | `mimo-v2.6-flash-free` |

Ücretli modele geçmek için rol dosyasının `model:` satırını değiştir
(`opencode models` ile liste). Session'da seçili model her zaman rolün modelini ezer.

### Yeni rol ekle

`.opencode/agents/crew/<ad>.md` olarak yaz. Zorunlu: tırnaklı `description` (model
hangi role ihtiyaç duyduğunu bundan anlar), `mode: subagent`, `model`, izinler, ve gövdede
**Ne döneceksin** bölümü. Ayrıntı ve karar ağacı: `cast` becerisi.

Rolü kapatmak için `opencode.jsonc` içine `"agents": { "crew/<ad>": { "disabled": true } }`.

---

## İş bölümü ve paralellik

Mimar işi **iş paketlerine** böler. Her paketin rolü, kabul kriteri, bağımlılığı ve
**yazma yüzeyi** (değiştireceği dosyalar) bellidir.

Bir paket şu üç koşulun üçüne birden uyuyorsa arka planda paralel başlatılır:

1. Bağımlılığı yok.
2. Yazma yüzeyi diğer paketlerle kesişmiyor.
3. Rolü başka paketlerin çıktısını beklemek zorunda değil.

`scout`, `analyst`, `researcher`, `critic` hiçbir şey değiştirmez — bunlar daima toplu
başlatılabilir. Gerçekten aynı anda yazılması gereken paketler `worktree` ile ayrılır
(`opencode.jsonc` içinde `../.worktrees`).

> Yanlış bölünmüş bir işi paralel başlatmak, onu seri başlatmaktan kötüdür: çakışan
> yazmaları sessizce bozar. Bu yüzden yazma yüzeyi her pakette yazılıdır.

---

## Hata-öğrenen hafıza

İki katmanlı: **otomatik yakalama** (plugin) + **bilinçli derse çevirme** (beceri).
Modelin disiplinine bırakılsaydı yakalama güvenilmez olurdu.

1. **Yakalama.** Her araç çağrısının sonucu izlenir. V2'de sıfır dışı çıkış kodu "hata"
   sayılmaz, hata metin olarak döner; bu yüzden hem fırlatılan hatalar hem de hata metni
   taşıyan çıktılar taranır.
2. **Sınıflandırma.** Hata mesajı değil **sınıfı** saklanır
   (`shell:PowerShellHatasi:CommandNotFoundException`, `shell:NodeHatasi:TypeError`).
   Yüz farklı "komut yok" hatası tek kayıt olarak birikir ve sayacı doğru çalışır.
3. **Eşik.** Tek seferlik hata ders olmaz. 3 kez tekrarlanan hata bir **sinyal** olur.
4. **Enjeksiyon.** Her kullanıcı turunda, görev metnine ve role göre en alakalı dersler
   modele **bir kez** verilir (`<orchestra-memory>` bloğu). Alt ajanlar da ana hedefi miras alır.
5. **Derse çevirme.** Sinyaller `crew/curator` ile ya da doğrudan `orchestra_lesson` +
   `promote` ile uygulanabilir kurala dönüşür. Ham kayıt dersin **kaynağı** olarak korunur.
6. **Temizlik.** Yanlış/eskimiş dersler `orchestra_forget` ile emekliye ayırılır.
   Hafıza biriktikçe yanlış ders de birikir; bu kanal onu engeller.

### Araçlar

| Araç | Ne yapar |
| --- | --- |
| `orchestra_recall` | Hafızada ara. Otomatik enjeksiyon zaten ilgili dersleri verir. |
| `orchestra_lesson` | Uygulanabilir kural yaz; `promote` ile ham hatayı derse çevir. |
| `orchestra_forget` | Yanlış/eskimiş dersi emekliye ayır. |
| `orchestra_report` | `/loop` döngüsünün durdurma sinyali. |

## Sıfırlamak / düzenlemek

`lessons.jsonl` normal bir metin dosyasıdır. Elle düzenlediğinde ya da sildiğinde sistem bir
sonraki okumada fark eder: dosyayı **silmek hafızayı sıfırlar** (plugin bayat kopyasını geri
yazmaz), elle eklediğin ders hemen kullanılabilir olur. `state.json` geçicidir, sürümlenmez.

---

## Bilinen çevresel durum

Genel yapılandırmadaki `opencode-swarm` eklentisi **v2 ile uyumsuzdur** ve yüklenmez:

```
Plugin must export a default definition with an id and an effect or setup function
```

Nedeni: V1 plugin API'sini kullanıyor (`@opencode-ai/plugin@1.x`), V2 ise `@opencode/plugin@2.x`
istiyor. Bu nedenle `architect`, `coder`, `critic` gibi rollerinin hiçbiri yüklenmiyor ve
`architect` adı çakışması oluşmuyor. Kullanılmayacaksa genel yapılandırmadan çıkarılabilir:

```sh
opencode plugin remove opencode-swarm
```

Bu bir Orchestra kusuru değildir; yalnızca ortamın mevcut halinin notu.

---

## Otonom döngü

`/loop <hedef> --max=N` her iterasyonda oturuma bir tur gönderir, tur bitince
`orchestra_report` çıktısını okur ve ona göre karar verir.

| Rapor | Anlamı |
| --- | --- |
| `continue` + `next` + kanıt | Gerçek ilerleme var. |
| `done` + kanıt | Kabul kriterleri karşılandı. |
| `blocked` + engeller | Karar gerekiyor; döngü durur, insana sorar. |

Döngü şu durumlarda **kendiliğinden durur**: `done`, `blocked`, iterasyon sınırı, tek bir
iterasyonun zaman aşımı (20 dk), 2 ardışık turda rapor gelmemesi, ya da 2 iterasyondur
aynı sonuç/kanıtla dönmesi. Yani takılan bir döngü sonsuza kadar yakmaz.

Rap vermezsen döngü seni bekler ve iki tur sonra kendini durdurur. Bu bir hata değil, supap.

Otonomi, onaylanmamış yıkıcı işlemler için kullanılmaz: üretim dağıtımı, veri silme, kimlik
yazma, `git push` gibi işlerde `blocked` durur. `opencode.jsonc` bu komutları tüm roller için
`deny` eder.

---

## Güvenlik ve izinler

`opencode.jsonc` iki bloktan oluşur:

1. **Kesin yasaklar.** `rm -rf /`, `git push`, `git reset --hard`, `npm publish`,
   `curl | sh`, `.env`/`.pem`/`.key` yazımı — rol dosyaları da aynı yasakları tekrar eder,
   çünkü rol izinleri tabanın üzerine eklenir.
2. **Otonomi.** Kalan her şey `allow`. Sistem "bitene kadar" onay istemeden çalışabilsin diye.

Temkinli bir kurulum istersen 2. bloktaki `shell: allow` satırını `ask` yap: her komut onay ister.

---

## Taşıma

Klasörü kopyala, `npm install` çalıştır. Başka projede de aynı sistem çalışır. Hafıza
projeye özeldir: `.opencode/memory/` kopyalanırsa o proje de o dersleri bilir.

---

## Sorun giderme

| Belirti | Sebep | Çözüm |
| --- | --- | --- |
| Rol `primary` yüklenmiş | Frontmatter'da `": "` bozdu | `description`'ı tırnakla |
| `/loop` yok | Komut kaydedilemedi | `orchestra_recall` çıktısındaki `UYARI:` satırı, `state.json → diagnostics` |
| Hafıza boş geliyor | İlgili ders yok | `/recall <konu>` ile sorgula; 3 eşiğini bekle |
| Plugin yüklenmiyor | Sözdizimi hatası | `npm run typecheck` |
| İzin bekliyor | `ask` kuralı | `opencode.jsonc` 2. blok |

Ayrıntılı günlük: `~/.local/share/opencode/log/opencode.log`
(`orchestra` ve `failed to load plugin` ifadelerini ara).

---

## Tasarım kararları

- **Roller dosya tabanlı, hafıza plugin tabanlı.** Roller insan tarafından düzenlenen
  şeydir; hafıza ise yakalama disiplinini modele bırakırsak güvenilmez olur.
- **İmza sınıf tabanlı, mesaj değil.** Aynı sınıftan yüz hata tek kayıt olur; sayaç
  anlamlı hale gelir.
- **Gürültü eşikle elenir.** Yakalama geniş, hatırlatma dar. Tek seferlik gürültü hiçbir
  zaman modele ulaşmaz.
- **Her mutasyon tek kapıdan.** `Memory.commit()` önce dış değişikliği kontrol eder, sonra
  uygular, sonra yazar. Tersi sırada kullanıcının sıfırlaması sessizce geri alınırdı.
- **Sessiz arıza yok.** Kayıt adımları ölçülür, tanılama `orchestra_recall` çıktısında
  görünür. Eksik parça, eksik sistem hissi vermemelidir.
