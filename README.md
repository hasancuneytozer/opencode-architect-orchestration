# Orchestra — opencode için mimar-merkezli orkestrasyon

Karmaşık bir işi alırsın; sistem işi böler, doğru rollere **paralel** dağıtır, sonucu
**doğrular** ve hatalardan **kalıcı ders** çıkararak bir sonraki sefer daha akıllı başlar.
Gerektiğinde **tam otonom** çalışır, durursan kaldığı yerden devam eder.

Bağımlılığı yoktur: saf opencode yapılandırması + tek bir küçük plugin. Klasörü olduğu gibi
başka bir projeye kopyalarsan sistem tamamen taşınır.

---

## Kurulum (git)

```sh
git clone https://github.com/hasancuneytozer/opencode-architect-orchestration.git
cd opencode-architect-orchestration
npm install
opencode
```

`npm install` yalnızca plugin'in ihtiyaç duyduğu `@opencode/plugin` paketini kurar; sistemin
kendisi dosya tabanlıdır. Kurulumdan sonra mimar rolü otomatik açılır.

Bu deponun **kendi üzerinde** çalışması gerekmez — istediğiniz herhangi bir projeye
kopyalayıp orada kullanabilirsiniz:

```sh
# kendi projenize taşıyın
cp -r <bu depo>/.opencode <sizin projeniz>/
cp    <bu depo>/opencode.jsonc <sizin projeniz>/
```

Yalnızca tek bir projede kullanacaksanız kopyalamak yeterlidir; `git` gerekmez.

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
├── orchestra.json                 dayanıklılık ayarları (yoksa varsayılanlar)
├── plugins/orchestra/             hafıza motoru + otonom döngü + dayanıklılık
│   ├── memory.ts                  ders deposu, puanlama, otomatik yakalama
│   ├── tools.ts                   orchestra_recall/lesson/forget/report
│   ├── loop.ts                    /loop komutu
│   ├── fallback.ts                retry hook'u, sınıflandırma, devre, geri çekilme
│   └── index.ts                   bağlama + hafıza enjeksiyonu
└── memory/                          sürümlenmez, her klon boş başlar
    ├── lessons.jsonl              kalıcı dersler (kişiye özel, depoda yok)
    └── state.json                 döngü durumu + plugin tanılaması (geçici)

scripts/orchestra.test.mjs        saf mantık regresyon testi (npm test)
```

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
yazma, `git push` gibi işlerde `blocked` durur. `opencode.jsonc` bu komutları tüm roller için
`deny` eder.

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

1. **Kesin yasaklar.** `rm -rf /`, `git push`, `git reset --hard`, `npm publish`,
   `curl | sh`, `.env`/`.pem`/`.key` yazımı — rol dosyaları da aynı yasakları tekrar eder,
   çünkü rol izinleri tabanın üzerine eklenir.
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
`git push` ve `rm -rf` yasakları bayrakla da reddedilir. Kalıcı bir karşılığı yoktur —
her oturumda yazman gerekir.

---

## Taşıma

Klasörü kopyala, `npm install` çalıştır. Başka projede de aynı sistem çalışır. Hafıza
**kopyalanmaz**: `.opencode/memory/` o projede sıfırdan başlar ve oradan öğrenir. Derslerin
aktarılmak istersen `.opencode/memory/lessons.jsonl` dosyasını elle hedef projeye kopyala.

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
