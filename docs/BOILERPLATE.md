# BOILERPLATE — bu klasörü yeni bir projeye taşıma

Bu klasör bir **şablondan kopyalanarak** kurulan bir proje köküdür; içinde taşınacak altyapı
vardır, kendi başına çalışan bir uygulama değildir. Kopya alındıktan sonra bu dosya yalnızca
**tarihsel bir referans** olur: aşağıdaki tarifler kopyanın o andaki hâlini anlatır.

## Kopya alırken değiştirilecekler (ZORUNLU)

| # | Dosya | Ne yapılır |
| --- | --- | --- |
| 1 | `AGENTS.md` | 1. satırdaki `<PROJE ADI>` ve 3. satırdaki `<PROJE ADI> — <tek cümlelik amaç>` placeholder'larını doldur. |
| 2 | `README.md` | Projenin kendi hikâyesi. `<PROJE ADI>` ve `<tek cümlelik amaç>` placeholder'larını doldur. |
| 3 | `package.json` | `"name"` alanı **geçerli bir npm adı olmalı**: yalnızca küçük harf, `-` ve `_`. **Ölçüldü:** köşeli parantezli `<proje-adi>` adıyla `npm install` **çalışır** (temiz klon ölçümü: 2026-10-04'te 283 paket kuruldu, çıkış kodu 0) — yani kurulum bozulmaz. Bozulma yerleri **yayın akışıdır**: `npm publish` bu adda `EINVALIDPACKAGENAME` verir. Proje yayın edilmeyecekse geçerli adda olması şart değildir; yine de adı kopyalama anında doldurmak en temizidir. |
| 4 | `package-lock.json` | Kökteki iki `"name"` satırı `package.json` ile **aynı** olmalı. Farklıysa ilk `npm install` lock'u sessizce yeniden yazar ve `git status` kirli kalır. |
| 5 | `docs/BOILERPLATE.md` | Bu dosyayı **silme**; sürüm güncellemeleri için referans olarak kalır. |

## Kopyadan sonra doğrulama (hepsi yeşil olmadan bitti deme)

```sh
npm install                # @opencode/plugin çözülemezse plugin yüklenmez — EN SIK HATA
npm run typecheck
npm test
opencode plugin list       # orchestra satırı görünmeli
opencode debug agents      # architect + crew/* görünmeli

git status                 # "temiz" olmalı — npm install lock'u DEĞİŞTİRMEMELİ
```

> **`opencode plugin list` ve `opencode debug agents` soğuk başlangıçta kararsızdır.**
> Ölçüldü: `git init`/`git clone` sonrası ilk çağrılar **çıkış kodu 0** ile `No plugins found`
> döndü. `debug agents` de aynı şekilde etkileniyor: ilk çağrı **536 satır** döndü ve
> `architect`/`crew/*` **yoktu** (sağlıklı çıktı ~6.700 satır). Kararsızlık **deneme sayısına
> değil süreye bağlı**: arka arkaya hızlı çağrılar servisin ısınmasından önce düşer.
> Doğru tedavi: **birkaç saniye bekleyip tekrar dene**. Çıkış kodu 0 "plugin yüklü" /
> "roller çözüldü" demek **değildir** — çıktının içeriğini doğrula: `orchestra` satırı ve
> `architect` + `crew/` gerçekten var mı? Sağlıklı `debug agents` çıktısı ~6.700 satırdır;
> tamamını okuma, `architect` ve `crew/` satırlarını ara.

## Ölçülmüş tuzaklar (bu klasörün canlı ortamda ölçülmüş hataları)

Aşağıdakiler varsayım değil, bu makinede 2026-10-04'te ölçülmüştür:

1. **`@opencode/plugin` çözülemezse plugin sessizce yüklenmez.** Logda
   `failed to load plugin ... Cannot find package '@opencode/plugin' imported from
   <proje>/.opencode/plugins/orchestra/index.ts` çıkar ve tüm araçlar sessizce kaybolur.
   Sebep: hedef projede `node_modules` yok. Çözüm: hedef projede `npm install`.
2. **Hafıza her zaman hedef projenin içine yazılır.** `.opencode/plugins/orchestra/index.ts:396`
   → `Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))`.
   `ctx.location.directory` proje köküdür. Yani sistemi global kurmak bile o projede
   `.opencode/memory/` oluşturur. `.gitignore`'a `.opencode/memory/` yazmak zorunludur.
   Commit'e girmesini istemiyorsan `.git/info/exclude` kullan — o dosya asla commit edilmez.
3. **`OPENCODE_CONFIG_DIR` çekirdek 2.0.18'de ek plugin kaynağı olarak çalışmıyor.**
   Ölçüldü: geçici bir dizine `plugins/orchestra` kondu, `opencode plugin list` boş döndü.
   Global kullanım isteniyorsa dosyalar fiziksel olarak `~/.config/opencode/` altında olmalı
   (`agents/`, `commands/`, `skills/`, `plugins/`, `opencode.json`).
4. **Submodül kullanma.** `git submodule add` `.gitmodules` ve gitlink yazar; `.opencode/`
   altındaki roller elle düzenlendiği için güncellemeler sessizce geri alır.
5. **Hedef projede `opencode.jsonc` varsa üstüne yazma, birleştir.** Config dosyaları
   replace değil **merge** edilir; izinlerde **son eşleşen kural kazanır**. Joker `allow`
   sonra gelirse yasakları öldürür — bu yüzden sıralama: joker allow'lar ÖNCE, taban
   yasaklar SONRA, orkestrasyon kapıları EN SON.
6. `opencode-swarm` V2 ile uyumsuzdur ve yüklenmez; bu Orchestra kusuru değildir.

---

# Orchestra — opencode için mimar-merkezli orkestrasyon (taşınan sistem)

Karmaşık bir işi alırsın; sistem işi böler, doğru rollere **paralel** dağıtır, sonucu
**doğrular** ve hatalardan **kalıcı ders** çıkararak bir sonraki sefer daha akıllı başlar.
Gerektiğinde **tam otonom** çalışır, durursan kaldığı yerden devam eder.

Bağımlılığı yoktur: saf opencode yapılandırması + tek bir küçük plugin. Sistemin kendisi
**0,81 MB / 56 dosyadır** (`git ls-files` ile ölçüldü). Klasörü olduğu gibi kopyalarsan
sistem taşınır — ama yanında **kişisel hafızanı** ve **643 MB isteğe bağlı runtime'ı** da
taşırsın. Taşıma yollarının farkı aşağıda.

---

## Kurulum (git)

```sh
git clone https://github.com/hasancuneytozer/opencode-architect-orchestration.git
cd opencode-architect-orchestration
npm install
opencode
```

`npm install` yalnızca plugin'in ihtiyaç duyduğu `@opencode/plugin` paketini kurar; sistemin
kendisi dosya tabanlıdır. Kurulumdan sonra mimar rolü otomatik açılır. Bu **normal kurulum
yoludur**; aşağıdaki isteğe bağlı proje-yerel runtime onun yerine geçmez, üstüne eklenir.

Sistemi **üç yolla** taşıyabilirsin. Farkları ölçülmüştür.

**Yol A — git (önerilen).** Yalnız takip edilen 56 dosya (0,81 MB) gider; hafıza, runtime ve
`node_modules` gelmez. `.gitignore` bu yolda gerçekten korur.

```sh
git clone <bu depo> <sizin projeniz>
cd <sizin projeniz>
npm install
```

**Yol B — ham klasör kopyası.** `git` kullanılmaz, dolayısıyla **`.gitignore` da çalışmaz**:
ignore edilen her şey kopyalanır. Ölçülen fark: kopyalanan ≈ **799 MB / 57.673 dosya**,
taşınması gereken ≈ **0,81 MB / 56 dosya** — yaklaşık **986 kat**. Kopyaladıktan hemen sonra
üç şeyi sil:

```sh
rm -rf .opencode/memory      # 62 kişisel ders + state.json'daki eski oturum kimliği
rm -rf .orchestra-runtime    # 643 MB: indirilmiş node.exe, npm cache, 18 MB oturum DB'si
rm -rf node_modules          # npm install yeniden kurar
```

PowerShell'de `Remove-Item -Recurse -Force <yol>` aynı işi görür.

**Yol C — yalnız sistemi mevcut bir projeye taşı.** Config'i olmayan, kendi işi olan bir
projeye işi yararın:

```sh
cp -r <bu depo>/.opencode <sizin projeniz>/
cp    <bu depo>/opencode.jsonc <sizin projeniz>/
```

Burada da `.opencode/memory/` kopyalanır. Silmeyi unutursan hedef proje **senin
derslerinle** başlar, sıfırdan değil.

Depoyu submodül olarak eklemek isterseniz (önerilmez):

```sh
git submodule add https://github.com/hasancuneytozer/opencode-architect-orchestration.git .opencode
```

Neden önerilmez: `.opencode/` altındaki roller, beceriler, komutlar ve plugin gerektiğinde
elle düzenlenir. Submodül güncellemeleri bu dosyaları sessizce geri alabilir. Kopyalama
yöntemi yerelde kalır, sürüm güncellemesi sizde olur.

### Gereksinimler

| Gereksinim | Sürüm |
| --- | --- |
| opencode | 2.x (V2 plugin API'si) |
| Node.js | 22+ |
| Model | `opencode.jsonc` içinde tanımlı; varsayılan `opencode/space-bunny-free` (ücretsiz) |

Ücretli model kullanmak isterseniz `opencode.jsonc` içindeki `model` satırını ve rol
dosyalarındaki `model:` alanlarını değiştirin. Aynı anda role özel model atamak için
`agents.<id>.model` kullanılabilir.

### İsteğe bağlı: proje-yerel açık kod runtime

**Normal kurulumu değiştirmez.** Yalnızca `AgentNotFound` hatasını ölçülebilir kılmak ve
**v2.0.18 açık kaynak çekirdeğine uygulanan, burada doğrulanan yerel aktivasyon bariyeri
yamasını** kendi çalışma kopyanızda denemek isterseniz kullanılır. Upstream'in bunu resmî
olarak yayımladığı bir düzeltme **değildir**.

```sh
npm run opencode:local:setup     # Node 24 + sabitlenmiş çekirdek 2.0.18 + yamayı uygular
npm run opencode:local:start     # ayrı süreç, 127.0.0.1, özel profil/hafıza
# yeni terminalde:
npm run opencode:local:attach    # opencode --server <url> <root>
```

Kuruluysa `setup`'a gerek yoktur: `npm run opencode:local:start`, ardından **yeni bir
terminalde** `npm run opencode:local:attach` yeterlidir. `attach` **yeni bir sohbet** açar;
o anki konuşmanız bağlı olduğu servisde kalır ve **taşınmaz**. Belgelenmiş bir `pid`/`url`
varsayılmaz — `npm run opencode:local:status` çıktısı okunur. Giriş gerekiyorsa `attach`
ile açılan TUI'de `/connect` kullanılır; kimlik kopyalanmaz.

Global kuruluma, ortak servise veya sistem yapılandırmasına **hiçbir komut dokunmaz**: her şey
`.orchestra-runtime/` altındadır ve `.gitignore`'lıdır (paketler, indirilen Node, özel veritabanı,
profil ve hafıza). Plugin'in yalnızca **kodu** (6 `.ts`) kopyalanır; kişisel hafıza, config ve
`auth.json` kopyalanmaz. `stop` yalnızca HTTP `shutdown` çağırır, `restore` yalnızca çekirdek
chunk'ını geri yükler — git ağacına, `reset`/`stash` ile dokunmaz, hafızanı silmez.

> **Kanıt (yerel ölçüm, 2026-10-03).** Gerçek dağıtılmış sunucuya karşı **6/6** devam
> senaryosu **PASS**: `architect` ve `crew/maker` için park → mutasyon → park sırasında yeni
> `setup` → araç çağrısı `completed` → `DONE`, **0 rol hatası**; negatif kontrolde taze native
> `server.log` satırı `Session.AgentNotFoundError` verdi. **Sınırlar:** etkileşimli TUI ve
> gerçek ebeveyn→çocuk alt ajan doğumu **ölçülmedi**; 6 senaryo yalnızca iki rolün API
> üzerinden devam davranışıdır ve **dış/üretim model çağrısı 0**'dır. Upstream'in tam TypeScript
> build'i çalıştırılmaz, resmî EXE yeniden derlenmez — dağıtım indirilmiş `dist`'e hash'lenmiş
> yerel yamadanır. Bu yüzden "upstream hata düzeltti" denmez, yalnızca "bu çalışma kopyasında
> ölçüldü" denir. Kanıt dosyaları `.gitignore`'lı ve yereldir; **yeni bir klon sonuçları
> görmez**. Bu dağıtımın **taze yayın adayında** (2026-10-03) kök kontrol yeşildir:
> `npm run typecheck` çıkış **0**, `npm test` çıkış **0** — 8 dosyada **1200 kontrol geçti,
> 0 başarısız** (216 + 125 + 178 + 96 + 108 + 123 + 93 + 261). Bu paketin kendi testi **ayrıdır**:
> `npm run test:local-runtime` `npm test`'in parçası **değildir**; kendi 48 kontrolünü Node
> **22.16.0** ve **24.21.0** altında 48/48 geçer. Yukarıdaki 6 senaryo ise **önceki P20
> anlık görüntüsüdür**, bu adayda yeniden koşulmadı. P17/P23'teki kırmızı ölçümler **bu adayda
> yeniden üretilmedi**; "hatayı biz düzelttik" denmez.

Ayrıntılı/teknik sürüm, güvenlik sözleşmesi, hash değerleri ve lisans atfı:
[`tools/opencode-runtime/README.md`](tools/opencode-runtime/README.md).

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
├── orchestra.json                 dayanıklılık + bütçe ayarları (yoksa varsayılanlar)
├── plugins/orchestra/             hafıza motoru + görev defteri + otonom döngü + dayanıklılık
│   ├── memory.ts                  ders deposu, puanlama, otomatik yakalama
│   ├── tasks.ts                   görev defteri, yüzey çakışma denetimi, bütçe
│   ├── tools.ts                   recall/lesson/forget/report/task/status
│   ├── loop.ts                    /loop komutu
│   ├── fallback.ts                retry hook'u, sınıflandırma, devre, geri çekilme
│   └── index.ts                   bağlama + hafıza enjeksiyonu
└── memory/                          sürümlenmez, her klon boş başlar
    ├── lessons.jsonl              kalıcı dersler (kişiye özel, depoda yok)
    └── state.json                 döngü durumu + plugin tanılaması (geçici)
    + *.lock                       süreçler arası yazma kilidi (geçici)

scripts/*.test.mjs + .opencode/scripts/*.test.mjs   regresyon testleri (npm test; sayılar çıktıdan okunur)
```

`npm test` yalnızca bu ağacın kök regresyonlarını koşar; **kaç dosya ve kaç kontrol geçtiği
komutun kendi çıktısından okunur** — buraya sabit sayı yazılmaz, çünkü her sürümde değişir.
Bu depoda 2026-10-04'te ölçülen: 8 dosya, 1200 kontrol geçti, 0 başarısız. Runtime paketinin
testi ayrı bir komuttur ve `npm test`'e **dahil değildir**: `npm run test:local-runtime`
(2026-10-04'te ölçülen: 48 kontrol).

Roller, beceriler ve komutlar **düz dosyadır**. Eklemek = dosya eklemek, çıkarmak = dosya
silmek. Kod bilmene gerek yok.

---

## Kadro

Tüm roller **tek model** kullanır: `opencode/space-bunny-free`. Sıfır maliyet, öngörülebilir
davranış; kademelendirme bilinçli olarak kapalı.

| Rol | Ne yapar | Değiştirir mi | Model |
| --- | --- | --- | --- |
| `architect` | böler, dağıtır, sentezler, doğrulatır | evet | `space-bunny-free` |
| `crew/scout` | keşif, haritalama | hayır | `space-bunny-free` |
| `crew/analyst` | seçenek karşılaştırma, karar zemini | hayır | `space-bunny-free` |
| `crew/researcher` | web/doküman araştırması, kaynaklı | hayır | `space-bunny-free` |
| `crew/critic` | red-team, kalite, regresyon | hayır | `space-bunny-free` |
| `crew/maker` | dosya/ortam/ürün değişikliği | evet | `space-bunny-free` |
| `crew/verifier` | test/build, gerçek kanıt | **hayır** (çalıştırır) | `space-bunny-free` |
| `crew/curator` | hafızayı düzenler | sadece hafıza | `space-bunny-free` |
| `crew/scribe` | dokümantasyon, rapor | evet | `space-bunny-free` |
| `crew/operator` | ortam, servis, dağıtım | evet | `space-bunny-free` |

### Model değiştirmek

Rol dosyasının `model:` satırını değiştir. `opencode models` ile liste alabilirsin.

Kademelendirmek istersen (muhakeme isteyen rollere güçlü, kalabalık rollere hızlı model):

| Roller | Model |
| --- | --- |
| `architect`, `crew/analyst`, `crew/critic` | `opencode/longcat-2.5-preview-free` |
| `crew/researcher`, `crew/verifier`, `crew/curator` | `opencode/nemotron-3-ultra-free` |
| `crew/maker`, `crew/operator` | `opencode/mimo-v2.6-flash-free` |
| `crew/scout` | `opencode/nemotron-3.5-lightning-free` |
| `crew/scribe` | `opencode/ling-3.0-flash-fin-free` |

> **Session'daki model her zaman rolün modelini ezer.** `opencode.jsonc` içindeki `model`
> satırı yalnızca yeni oturumların varsayılanını belirler; eldeki session'ın modeli TUI'da
> seçtiğin modeldir. Yanlış modelle açılmış bir session'da rol ataması işe yaramaz.

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
| `orchestra_report` | `/loop` döngüsünün durdurma sinyali. **Yalnızca mimar çağırabilir.** |
| `orchestra_task` | Görev defteri: iş paketi ekle, durumunu ilerlet, kanıt ekle. **Yalnızca mimar.** |
| `orchestra_status` | Defter + bütçe tek ekranda: kim ne yapıyor, hangi yüzeyler çakışıyor. |

> **`orchestra_report` neden mimara özel?** Rapor TEK yuva olarak tutulur
> (`state.json → report`) ve `/loop` onu okuyarak döngüyü durdurur. Araç global
> olduğu için, bir alt ajan `status: "done"` bildirseydi otonom iş tamamlanmadan kapanırdı.
> İki katmanlı koruma var:
> 1. **İzin:** her `crew/*` rolünün frontmatter'ında `orchestra_report → deny`. Araç
>    modelin listesinde hiç görünmez, denemeye de gerek kalmaz.
> 2. **Programatik kapı:** aracın kendisi `context.agent` değerini denetler; rol mimar
>    değilse yazmaz ve gerekçeyi döndürür.
>
> Canlı doğrulama: `crew/maker` alt ajanına rapor çağırması söylendi; katalogda aracı
> görmedi, çağırmayı denedi ve `Unknown tool` aldı. `state.json` değişmedi.

> **`orchestra_task` neden mimara özel?** Görev defterinin durumu mimarın kararıdır.
> Alt ajan kendi işini `done` ilan edebilirse kabul kriterini kendisi belirler ve
> mimarın bağımlılık sırası ile çakışma denetimi anlamsızlaşır. Aynı iki katmanlı
> koruma geçerli: rol dosyasında `deny` + araçta `context.agent` denetimi.

---

## Görev defteri

İş paketleri artık **yalnızca metin değil, kodla izlenebilir** bir kayıt. Defter
`orchestra_task` ile doldurulur, `orchestra_status` ile okunur.

| Alan | Anlamı |
| --- | --- |
| `id`, `title`, `role` | Kim, ne, hangi rol |
| `dependsOn` | Bağımlılık. Tamamlanmadan `running` olamaz; döngüsel bağımlılık reddedilir |
| `writeSurface` | Dokunacağı yollar. **İki görev kesişirse çakışma raporlanır** |
| `acceptance` | Kabul kriteri. `done` için boş **olamaz** |
| `evidence` | Kanıt. `done` için boş **olamaz** |
| `status` | `planned → running → verifying → done / blocked / failed` |

**Bu neyi zorluyor?** Daha önce yazma yüzeyi ve bağımlılık yalnızca modelin
uyması beklenen metindi (`skills/dispatch/SKILL.md`); kod tek satırını görmüyordu.
Artık:

- **Çakışan yüzey görünür.** İki `running` görev aynı dosyaya dokunuyorsa sistem
  bildirir. Engellemez — karar mimarın — ama **göremez artık**.
- **Kanıtsız "bitti" reddedilir.** `evidence` boşsa `done` kabul edilmez. Bu,
  "yaptım" ile "çalıştığını kanıtladım" ayrımını sözlüğe değil koda bağlar.
- **Döngüsel bağımlılık yakalanır.** `A → B → A` tespit edilip reddedilir.
- **Geçersiz geçiş reddedilir.** `planned`dan `done`a atlamak mümkün değildir.

> Yüzey kesişimi **tespit** yapar, engellemez. Çakışan iki işi seri yapmak da
> bazen doğru karardır; sistem kararı vermez, kararın görünür olmasını sağlar.

## Bütçe

`.opencode/orchestra.json` → `budget` bloğu canlı okunur:

```jsonc
"budget": {
  "maxWallClockMs": 14400000,   // 4 saat
  "maxIterations": 50,
  "maxConcurrentTasks": 8,
  "maxTasksPerGoal": 200
}
```

Sınır aşılınca `orchestra_status` **aşım** gösterir ve `UYARI` notu düşer. Bütçe
kendisi durdurmaz — durduran `/loop`'tur; defter ölçer, döngü keser. Bu ayrım
bilinçlidir: ölçüm ve karar farklı katmanlarda kalır.

## Sıfırlamak / düzenlemek

`.opencode/memory/` **depoya girmez** (`.gitignore`'da). Bu bilinçli bir tercihtir: her yeni
klon **sıfır** bir hafızayla başlar, yani sistem sana devredilen dersleri değil, **kendi
hattalarından** öğrenir. Başkasının hatasıyla değil, senin hatanla çalışır.

Dosya normal bir metin: elle düzenlediğinde ya da sildiğinde sistem bir sonraki okumada fark
eder. **Silmek hafızayı sıfırlar** (plugin bayat kopyasını geri yazmaz), elle eklediğin ders
hemen kullanılabilir olur.

Paylaşılan bir ders seti kurmak istersen (ekip standardı gibi), `lessons.jsonl` dosyasını
kendi projenizde ayrıca sürümlenebilir yapabilirsiniz; bu durumda o klon kendi kopyasıyla
başlar.

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
yazma, uzaktaki geçmişi ezma gibi işlerde `blocked` durur. `opencode.jsonc` bunları tüm roller
için `deny` eder. Düz `git push` bu kapsamda değildir — commit'i mimar kendi gönderir;
zorlamalı varyantlar (`--force`, `-f`) yine yasaktır.

---

## Dayanıklılık (fallback)

Sağlayıcı hatalarında iki işi birden yapar: **boşuna deneme harcamaz** ve **bu kalıpları
unutmaz**. opencode'un hazır `session.hook("retry")` hook'unu kullanır; hook içinde uyuyup
elle yeniden prompt atmaz, `event.decision` değerini değiştirir. Böylece opencode kendi
attempt muhasebesini ve sert tavanını yönetmeye devam eder.

### Ne zaman tekrar denenir, ne zaman denemez

| Hata | Sınıf | Karar | Neden |
| --- | --- | --- | --- |
| 429 | hız sınırı | **tekrar dene**, üstel bekleme | geçici |
| 5xx | sunucu | **tekrar dene**, orta bekleme | geçici |
| ağ / timeout | ağ | **tekrar dene**, kısa bekleme | geçici |
| 402 | kota | **tekrar deneme** | beklemek işe yaramaz, sadece bütçe yakar |
| 400 / 404 / 422 | geçersiz istek | **tekrar deneme** | aynı istek aynı cevabı alır |
| bağlam taşması | taşma | **tekrar deneme** | opencode ayrı yolla compaction ile çözer |
| iptal | iptal | dokunma | kullanıcı istedi |

### Geri çekilme

`delay = min(maxDelayMs, baseDelayMs × 2^(attempt-2))` + %25 rastgelelik.

`attempt` fiziksel denemedir: ilk istek 1, **ilk retry 2**. Yani ilk retry tam
`baseDelayMs` bekler, sonrakiler ikiye katlar. Rastgelelik, eşzamanlı iki isteğin aynı
anda geri dönüp sağlayıcıyı tekrar yormasını engeller.

### Devre (cooldown)

Bir model üst üste `cooldownThreshold` kez (varsayılan 3) başarısız olursa o model
`cooldownMs` boyunca (varsayılan 60 sn) devre dışı bırakılır. Devre açıkken gelen istekler
**anında** `retry: false` döner — hazır deneme bütçesini ölü bir modelde yakmaz.

### Hafızaya yazma (bizim farkımız)

Dayanıklılık sadece bir dosyaya log yazmaz. Tekrarlanan kalıplar hafızaya **sinyal** olarak
yazılır, 3. eşikte kuralları eşiğe girer:

```
orchestra:fallback:quota            → "bu sağlayıcıda kredi bitti"
orchestra:fallback:rate-limit       → "bu model bu sağlayıcıda hız sınırı atıyor"
orchestra:fallback:context-overflow → "bu projede bağlam taşıyor, küçük adımla ilerle"
```

Yani sistem "bu sağlayıcı bana rate-limit atıyor" derdini kendi dilinde öğrenir ve mimar
bir sonraki işte daha bilinçli davranır. Genel amaçlı fallback eklentilerinin bu kısmı yok.

> **Yapılandırma canlıdır.** `.opencode/orchestra.json` dosyasını düzenlediğinde
> opencode'u yeniden başlatmana, plugin'i yeniden yüklemene gerek yok. Ayar dosyası her hata
> olayında kontrol edilir; değişmişse yeniden okunur. Bu maliyet yalnızca sağlayıcı hatası
> olduğunda ödenir, normal akışta hiç çalışmaz.

### Model zinciri (varsayılan KAPALI)

`autoSwitch` açıldığında, bir model devreye girdiğinde sıradaki sağlıklı modele geçilir.
Zincir sırayla taranır; **hâlâ soğuyan** modeller atlanır:

```
chain: [p/a, p/b, p/c]      p/a devrede
  p/b  hâlâ soğuyorsa  -> atlanır
  p/c  temizse          -> p/c seçilir
  hepsi soğuyorsa      -> zincirde bir adım atılır
```

Yani gerçek bir "sırayla dene, çalışanı bul" listesidir. Devre kalıcı bir yasak değil:
**soğuması bitmiş** bir model yeniden seçilebilir. Devre yalnızca `cooldownMs` (60 sn)
boyunca engeldir.

Ayrıca soğuması biten modelin hata sayacı sıfırlanır. Bu kritik: aksi halde 5 hatadan sonra
devreye girmiş bir model, tek bir yeni hatada anında yeniden devreye girer ve sen o modeli
hiç kullanamazsın. Sayaç sıfırlanınca model tam bir deneme bütçesiyle geri döner.

```jsonc
"autoSwitch": true,
"chain": ["opencode/space-bunny-free", "opencode/nemotron-3-ultra-free"]
```

> **Neden varsayılan kapalı?** `ctx.session.switchModel` oturum düzeyinde **kalıcı** bir
> değişikliktir. "Az önce seçtiğin modele dönme" davranışını geri yüklemek bizim
> sorumluluğumuzdadır (`restoreOnRecovery`). Bu, küçük ama kalıcı bir durum sızıntısı
> riski taşır; bilerek açılmalıdır.

> **Geri dönüş kabul anında olur.** Model düzelince ilk modele dönüş, bir sonraki turun
> başında (`prompt` kabul anında) gerçekleşir — yani o turun isteği gerçekten ilk modelde
> çalışır. Bu bilinçli bir seçimdir: `context` hook'u model gönderilmeden hemen önce
> çalıştığı için oradaki bir geçiş o turu etkilemez, ayrıca araç çağrısından sonra da
> tetiklendiği için geri dönüş turun **ortasında** devreye girebilirdi.
>
> Canlı test: birincil model kalıcı olarak bozukken, 1. turda yedeğe geçildi ve 2. turda
> istek tekrar birincil modelde denendi (402) ve yeniden yedeğe düşüldü. Yani sistem her
> turda önce birincili deniyor. Bedeli: birincil kalıcı bozuksa her turda bir başarısız
> deneme. Daha az deneme istersen `restoreOnRecovery: false` yap — ama o zaman oturum
> yedek modelde kalıcı olarak takılır.
### Yapılandırma

`.opencode/orchestra.json` (yoksa geçerli varsayılanlar kullanılır):

```jsonc
{
  "fallback": {
    "enabled": true,
    "cooldownThreshold": 3,
    "cooldownMs": 60000,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "jitter": 0.25,
    "retryNonTransient": false,
    "chain": [],
    "autoSwitch": false,
    "restoreOnRecovery": true,
    "learnFromFailures": true,
    "perAgent": {}
  }
}
```

`perAgent` ile rol bazlı geçersiz kılma yapılabilir — örneğin `architect` sık hız sınırı
alıyorsa yalnızca onun ayarları değişir:

```jsonc
"perAgent": { "architect": { "cooldownThreshold": 2, "baseDelayMs": 4000 } }
```

### Sınırlar

- Devre durumu **süreç içindedir**; opencode yeniden başlatılınca sıfırlanır.
- opencode'un kendi sert attempt tavanı geçerlidir; bu katman onu aşamaz.
- **Yalnızca sağlayıcı isteği yapıldıktan sonraki hatalar yakalanır.** Model bulunamadı,
  kimlik hatalı ya da yapılandırma bozuk gibi *uçuş öncesi* hatalar `retry` hook'una hiç
  gelmez. Canlı testte bilinmeyen bir model seçildiğinde `session.execution.failed` oldu,
  hook çalışmadı ve hafızaya kayıt düşmedi. Buna karşılık gerçek bir 402 kota hatasında
  hook çalıştı, `orchestra:fallback:quota` sinyalini yazdı ve deneme yapmadı.

---

## Güvenlik ve izinler

`opencode.jsonc` üç bloktan oluşur:

1. **Kesin yasaklar.** `rm -rf /`, `git reset --hard`, `git clean`, `npm publish`,
   `curl | sh`, `.env`/`.pem`/`.key` yazımı, **zorlamalı push**
   (`git push --force`, `git push -f`) — rol dosyaları da aynı yasakları tekrar eder,
   çünkü rol izinleri tabanın üzerine eklenir.

   Düz `git push` **serbesttir**: mimar commit'i kendi gönderir. Yalnızca zorlamalı
   varyantlar yasaktır, çünkü onlar uzaktaki geçmişi ezer.
2. **Otonomi.** Kalan her şey `allow`. Sistem "bitene kadar" onay istemeden çalışabilsin diye.
3. **Mimari kısıt.** Alt ajan yalnızca mimar tarafından başlatılabilir.

Temkinli bir kurulum istersen 2. bloktaki `shell: allow` satırını `ask` yap: her komut onay ister.

### Neden bazen yine de onay ister?

İki ayrı şey karışıyor:

| Mekanizma | Kapsam | Nerede |
| --- | --- | --- |
| `permissions` config | kalıcı, tüm oturumlar | `opencode.jsonc` |
| `--auto` bayrağı | tek oturum | `opencode --auto` |

Kural şu: **hiçbir kural eşleşmezse opencode `ask` varsayar.** "Kural yazmadım" = "serbest"
değil, "sor" demektir. opencode'un temel varsayılanında `external_directory * → ask` vardır —
proje kökü dışındaki her `read`/`edit`/`write` buradan kilitlenir. Bu yüzden 2. blokta şu
satırlar var:

```jsonc
{ "action": "external_directory", "resource": "*", "effect": "allow" },
{ "action": "question",           "resource": "*", "effect": "allow" },
{ "action": "execute",            "resource": "*", "effect": "allow" },
{ "action": "shotcut_*",          "resource": "*", "effect": "allow" },
{ "action": "blender_*",          "resource": "*", "effect": "allow" },
{ "action": "blenderlab_*",       "resource": "*", "effect": "allow" },
```

Yeni bir MCP sunucusu eklersen onun `<sunucu>_*` girdisini de buraya yaz; yoksa o sunucunun
araçları her çağrıda onay ister.

### `--auto` bayrağı

Tam otonom, ama oturuma özel çalıştırmak istersen:

```sh
opencode --auto                    # bu oturumda ask'a düşen hiçbir şey sormaz
opencode run --auto "testleri koştur"
```

`--auto` yalnızca `ask` duranları onaylar; 1. bloktaki `deny` kurallarına **dokunmaz**.
`rm -rf /`, `npm publish` ve zorlamalı push yasakları bayrakla da reddedilir. Kalıcı bir
karşılığı yoktur —
her oturumda yazman gerekir.

---

## Taşıma

Klonla (Yol A) veya kopyala (Yol B) — "Sistemi üç yolla taşıyabilirsin" bölümüne bak,
çünkü **hafızanın kopyalanıp kopyalanmadığı yola bağlı**:

- **Yol A (git):** hafıza **kopyalanmaz**. `.opencode/memory/` gitignore'lu, o projede sıfırdan
  başlar ve oradan öğrenir.
- **Yol B / Yol C (klasör kopyası):** hafıza **kopyalanır** — 62 aktif ders ve `state.json`
  içindeki eski oturum kimliği gelir. Sıfırdan başlaması için `rm -rf .opencode/memory`
  gerekir.

Derslerini bilinçli olarak aktarmak istersen `.opencode/memory/lessons.jsonl` dosyasını **elle**
hedef projeye kopyala.

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
- **Hazır hook'u kullan, kendi döngünü kurma.** Dayanıklılık, `retry` hook'u içinde
  uyuyup elle prompt atmak yerine `event.decision` değiştirir. Böylece opencode'un attempt
  muhasebesi, sert tavanı ve retry geçmişi bozulmaz; başka bir plugin de aynı hook'u
  kullanıyorsa kararlar birikir.
- **Anlamsız tekrarı durdur.** Kota ve geçersiz istekte tekrar denemek yalnızca bütçe
  yakar. "Daha çok dene" her zaman doğru değildir.
- **Dayanıklılık hatırlamalı.** Genel amaçlı fallback eklentileri log dosyasına yazar;
  biz hafızaya yazıyoruz, böylece kalıbın kendisi sistemin bilgisi hâline geliyor.
- **Güçlü varsayılan, açık risk.** `autoSwitch` kapalı gelir: `switchModel` kalıcı bir
  oturum değişikliğidir ve geri dönüşü biz yönetiriz. Ölçemediğimiz bir davranışı varsayılan
  açmak, kullanıcıdan habersiz durum sızdırmaktır.
- **Hata kökeni denetlenir, metin taranmaz.** Bir `read` çıktısındaki `TypeError` *çalıştırılmış*
  bir hata değildir; imzaya yazılırsa sayaç şişer ve sistem kendi kaydını yanlış ders sanar.
  Yalnız hata üretebilen araçların çıktısı taranır (`capture.scanTools`), kendi kayıtlarımız elenir.
- **Yazma atomik, bozuk dosya karantinada.** `atomicWrite` (tmp + fsync + rename) yarıda
  kesilen yazmada dosyayı bozmaz; okunamayan depo sessizce sıfırlanmaz, `.corrupt-<zaman>`
  adıyla yedeklenip `orchestra_recall` çıktısında `UYARI:` olarak bildirilir.
- **Ham gözlem, uygulanabilir kural değildir.** Otomatik yakalanan kayıtlar sistem bloğunda
  "veri" olarak işaretlenir; sadece `curated`/`agent` dersleri talimat olarak enjekte edilir.
  Sızgeç ayrıca blok sınırı üretilmesini engeller (`<`/`>` yok).
- **Döngü oturuma aittir.** Rapor ve döngü durumu `sessionID` + `runID` ile anahtarlanır;
  iki oturum birbirinin `done` raporuyla kapanmaz. Yalnız o iterasyona ait rapor kabul edilir.
- **İzin sırası son eşleşmeye göre yazılır.** V2'de son eşleşen kural kazanır: genel izinler
  **önce**, özel yasaklar **sonra**. Rol dosyasındaki joker `allow`, config'deki yasakları
  ezip geçtiği için **yazılmaz**; yazan roller joker'ın altına sır yasaklarını tekrarlar.
  `npm test` her rolde bunu doğrular.
