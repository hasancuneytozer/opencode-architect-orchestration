# Proje-yerel açık kod opencode runtime'i

Bu dizin, **global opencode kurulumuna hiç dokunmadan** aynı deponun içinde ikinci bir açık
kod opencode runtime'i kurar ve çalıştırır. Amaç tek bir hatayı ölçülebilir kılmak:
`SessionContext.select`, plugin aktivasyon mandalını **rol seçildikten sonra** okuduğu için
henüz materyalize olmamış bir rol `AgentNotFound` üretiyordu. Bu hataya karşı **v2.0.18 açık
kaynak çekirdeğine uygulanan, burada doğrulanan yerel aktivasyon bariyeri yaması**, **bu
depoya ait ve `.gitignore`'lı** bir çalışma kopyasına uygulanır. Upstream'in bunu resmî
olarak yayımladığı bir düzeltme **değildir**.

Genel kurulum aynen yaşar: senin `opencode` komutun, `~/.local/share/opencode` profilin,
global yeteneklerin ve kimlik dosyaların değişmez. Bu paket **isteğe bağlıdır**; kullanmıyorsan
hiçbir şey çalıştırmana gerek yok.

## Sınır

| Yapar | Yapmaz |
| --- | --- |
| `.orchestra-runtime/` altına sabitlenmiş `@opencode` paketlerini kurar | Kök `package.json` bağımlılıklarını değiştirmez |
| Yalnızca indirilmiş `dist` chunk'ını bayt-doğrulamalı yamalar | Resmî EXE yeniden derlemez, upstream TypeScript build'ini çalıştırmaz |
| Ayrı bir Node süreci başlatır, `127.0.0.1` üzerinde dinler | Ortak servise, başka sürece veya başka port sürecine dokunmaz |
| Plugin'in **kodunu** kopyalar (6 `.ts`) | Kişisel veriyi, hafızayı, config'i veya `auth.json` kopyalamaz |
| Çekirdek chunk'ını geri yükler | `git` ağacına dokunmaz; `reset`/`checkout`/`stash` **yok** |

---

## Gereksinimler

| Gereksinim | Değer |
| --- | --- |
| Node.js | **>= 24** (`.orchestra-runtime` içindeki veya sistemdekini kullanır) |
| Sabitlenmiş çekirdek | `@opencode/core` **2.0.18** — başka sürüm reddedilir |
| Sabitlenmiş plugin SDK | `@opencode/plugin` **2.0.20**, `@opencode/server`/`@opencode/sdk` 2.0.18 |
| Otomatik Node indirme | yalnızca **win-x64** kanıtlı; Node **24.21.0** |
| Ağ | yalnızca `setup` (Node indirme + `npm install`) |

Node çözümleme sırası: `ORCHESTRA_NODE` → `<runtime>/bin/node` → sistem Node'u (>= 24) →
yalnızca `setup` içinde sabitlenmiş Node indirmesi. `start` **indirme yapmaz**; 24'un altındaki
bir Node ile "hata ayıklamak" yolu sunulmaz, çünkü bu kök nedeni gizler.

Diğer platformlarda (win-x64 dışı) otomatik indirme bilinçli olarak yok: doğrulanmamış bir
hash'i "kaynak" diye göstermek, doğrulanmamış ikiliyi çalıştırmaktan iyidir. O platformlarda
sistemde Node >= 24 kur ya da `ORCHESTRA_NODE=<mutlak yol>` ver.

---

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `npm run opencode:local:setup` | Runtime manifestini yazar, Node çözer, **yalnızca bu runtime'a** `npm install` yapar, çekirdek yamayı uygular |
| `npm run opencode:local:start` | Yerel sunucuyu başlatır. **İndirme yapmaz**; yalnızca `127.0.0.1` üzerinde loopback dinleyicisi açar. Projede tanımlı MCP sunucuları yine dış servise çıkabilir — dış çıkarım ölçülmedi |
| `npm run opencode:local:status` | url / pid / sürümler / hash'ler / hafıza yolu / yetkilendirme var mı |
| `npm run opencode:local:stop` | Yalnızca HTTP `shutdown` + nonce. Sinyal göndermez |
| `npm run opencode:local:restore` | **Yalnızca çekirdek chunk'ı** geri alır |
| `npm run opencode:local:attach` | `opencode` CLI'yi yerel sunucuya bağlar (`--server <url> <root>`) |
| `npm run test:local-runtime` | `patch` + `support` + `server` testlerini koşar |

Ortam değişkenleri:

| Değişken | Anlamı |
| --- | --- |
| `ORCHESTRA_NODE` | Node >= 24 için mutlak yol (`setup`/`start`) |
| `ORCHESTRA_CLI` | `attach` için `opencode` CLI mutlak yolu |
| `ORCHESTRA_NPM_CLI` | `npm_execpath` yoksa `npm-cli.js` mutlak yolu |

---

## Akış

### 1. `setup`

- `<runtime>/package.json` = `runtime-package.json` kopyası. Sabitlenmiş sürümler (`^` yok) ve
  sürüm denetimi vardır; manifest beklenen sürümleri taşımazsa kurulum **durur**.
- Node çözülür; gerekiyorsa Node 24.21.0 `win-x64` `.exe` indirilir ve **çalıştırılmadan önce**
  sha256 doğrulanır. Uyuşmazsa **hiçbir şey çalıştırılmaz**.
- `npm install --prefix <runtime> --ignore-scripts`, `npm_config_cache=<runtime>/npm-cache` ile.
  Yani **global npm cache'i, global prefix'i ve kök `node_modules` ağacı değişmez**; runtime
  sürüm bump'u bu depoyu yükseltemez.
- Ardından `patchRuntime(..., "apply")`.

### 2. `start`

Sırayla: kendi hâlinde değilse çık → Node çöz (**indirme yok**) → çekirdek kurulu mu → **yama
durumu `patched` mi** (değilse başlatmayı reddeder; çalışan kodun altını sessizce değiştirmeyiz)
→ plugin aynasını yaz → hafıza dizinini aç → rastgele parola + nonce üret → `server.mjs`'i
ayrı (detached) Node 24 süreci olarak başlat → `<runtime>/state/instance.json` değişene ve
`GET /__orchestra_runtime/info` kimliği doğrulanana kadar bekle (45 sn).

Sunucu `--experimental-transform-types` ile başlatılır; aynalanan TypeScript kodunda
parametre özellikleri vardır. Doğrulanan yapılandırma metni açıkça SDK'nın
`options.config.content` alanına, özel profil dizini de `options.config.directory` alanına
aktarılır. Gömülü SDK'nın ortam değişkenini kendiliğinden okuduğu varsayılmaz.
Yerel eklenti hedefi doğrudan `<runtime>/plugins/orchestra/` dizinidir: native Host burada
`index.ts` arar; üst dizindeki `package.json` dosyasının `main` alanını kullanmaz.

Kimlik doğrulaması **fail-closed**'dur: pid, url, `127.0.0.1`, port, nonce, proje kökü
(realpath) ve çekirdek hash'i eşleşmezse hata fırlatılır; "bilmiyorum" ile "hayır" aynı sonucu
vermez. Başlatma başarısızsa **yalnızca o adımda doğurulan çocuk** öldürülür; başka hiçbir pid
sinyalleşmez. `state.json`'ı başkası yazmışsa dosyaya dokunulmaz.

**HTTP yanıtı tek başına "hazır" demek değildir.** Sunucunun ayakta olması, proje-yerel plugin'in
gerçekten yüklendiğini kanıtlamaz. Yükleme doğrulaması ayrı bir adımdır: `GET /api/plugin`
çağrısında **tek bir** `orchestra.project-local` alias'inin etkin olması, özgün `orchestra`
id'sinin **bulunmaması** ve `tools` / `loop` / `fallback` / `tasks` tanılarının `ok` olması,
`diagnostics.steps = tools ok · loop ok · fallback ok · tasks ok`, hafıza yolunun
`ORCHESTRA_PROJECT_MEMORY` olması. Bu set tamamlanmadan "çalışıyor" denmez.

### 3. `attach`

`npm run opencode:local:attach` **yeni bir terminalde** çalıştırılır; kendi `opencode` CLI'n
`--server <url> <root>` ile açılır. Parola `argv`'ye geçmez, yalnızca çocuk sürecin ortamında
tutulur ve günlüğe yazılmaz.

- **Konuşma taşınmaz.** Elindeki mevcut oturum, `attach`'ten önce bağlandığı serviste kalır.
  Otomatik oturum taşıma, otomatik model geçişi veya yeniden başlatma **yoktur**.
- **Yeni sohbet açılır.** `attach` yeni bir sohbet açar; o anki konuşman **taşınmaz**. Bu belgede
  doğrulanmış bir `pid`/`url` yoktur — `npm run opencode:local:status` ölçülen değeri verir.
  Kabul koşularının ürettiği sentetik `repro-mock` oturumları özel profilin **kendi**
  veritabanında kalır; silinmez, aktarılmaz. Temiz bir sohbet için `/new` kullan.
- **Kimlik kopyalanmaz.** Yerel profilin `auth.json`'u globalden alınmaz; giriş yapmak
  gerekiyorsa `attach` ile açılan TUI'de `/connect` komutunu kullanıp sağlayıcına giriş yap.
  Modeli değiştirmek istersen `/models` kullanılabilir; kurulum mevcut proje modelini değiştirmez.
  Kaynak: [V2 sağlayıcı kurulumu](https://opencode.ai/v2/docs/providers#setup).
- `OPENCODE_*` değişkenlerinden **yalnızca** `OPENCODE_API_KEY` ve `OPENCODE_API_KEY_URL`
  miras alınır. Diğer sağlayıcıların ortam anahtarları korunur; kimlik dosyaları kopyalanmaz.

### 4. `status`

`url`, `pid`, `coreVersion`, `pluginVersion`, `serverCoreVersion`, `coreSha256`, `patched`,
`memoryPath`, `runtimeDir`, `node`, `authConfigured` (evet/hayır). **Parola, token ve nonce
değeri hiçbir çıktıya yazılmaz** — sırlar değil, yalnızca işaretleri raporlanır.

Bağlantı parolası git-ignored `<runtime>/state/instance.json` içindedir. Windows'ta `0o600`
özel ACL sağlamaz; depoyu okuyabilen yerel hesaplar bu dosyayı da okuyabilir. Paylaşılan
makinelerde runtime dizininin erişimini işletim sistemi izinleriyle sınırlandırın.

### 5. `stop`

Yalnızca `POST /__orchestra_runtime/shutdown` + Basic auth + nonce. Önce kimlik doğrulanır.
30 sn içinde pid kapanmazsa **hata verilir ve zorlanmaz**: süreç sinyali, desenle öldürme ya
da "opencode" adına sürece avı yoktur. Ortak servis yeniden başlatılmaz.

### 6. `restore`

- **Çalışan runtime altında reddedilir** (`restore` ve ikinci `start` dahil). Denetim
  `patch/ledger.json` değil, `<runtime>/state/instance.json` (ve eski düz `state.json`) üzerinden
  yapılır ve **fail-closed**'dur: okunamayan, nesne olmayan ya da pid'siz kayıt "durmuş" sayılmaz.
- Yalnızca çekirdek chunk'ı geri yükler. **Kişisel veri, hafıza, kimlik dosyası ve git ağacı
  dokunulmaz.** `git reset`/`checkout`/`stash` kullanılmaz.
- **İdempotenttir:** chunk zaten orijinalse işlem `original` döner, hiçbir şey yazılmaz.
- Geri alındıktan sonra `start` **reddedilir** (`çekirdek yamali değil`). Yeniden yamalamak için
  `npm run opencode:local:setup` çalıştırılır.

---

## Ne kopyalanıyor (ve ne kopyalanmıyor)

`.opencode/plugins/orchestra` **yalnızca okunur**; ayna şu 6 kodu kopyalar:

```
index.ts   memory.ts   loop.ts   fallback.ts   tasks.ts   tools.ts
```

`index.ts` **iki çapaya** dönüştürülür (`singleReplace`: anchor tam olarak 1 kez geçmeli):

| Çapa | Sonuç |
| --- | --- |
| `id: "orchestra",` | `id:"orchestra.project-local",` |
| `Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))` | `Memory.open(process.env.ORCHESTRA_PROJECT_MEMORY)` |

Neden iki çapa:

1. Farklı `id` sayesinde üretilen kopya, config'de `plugins: ["-orchestra", { package: … }]`
   listesinde **yaşayabilir**. Aynı `id`'yi taşısalardı `-orchestra` iki kopyayı da sustururdu.
   Yerleşik kopya kapanır, üretilen paket açılır.
2. Hafıza `.opencode/memory` **asla** okunmaz/yazılmaz; `start` her zaman
   `ORCHESTRA_PROJECT_MEMORY` atar. Atanmazsa `Memory.open(undefined)` hata verir — yanlış
   dizine sessizce yazmak yerine görünür biçimde durur.

Her şey `<runtime>/` altındadır ve dışarıya taşmaz:

| Yönlendirme | Hedef |
| --- | --- |
| Hafıza | `<runtime>/memory/<proje-parmak izi>` (`ORCHESTRA_PROJECT_MEMORY`) |
| Veritabanı | `<runtime>/state/project.sqlite` (`OPENCODE_DB`) |
| Profil | `HOME`, `USERPROFILE`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` |
| Windows uygulama verisi | `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH` |
| Geçici dosyalar | `TMPDIR`, `TMP`, `TEMP` |
| Günlük | `<runtime>/logs/server.log` |

---

## Yama güvenliği

Yama, **indirilmiş yayınlanmış `dist`** üzerinde çalışır. Yayınlanan `dist/session/context.js`
bir barrel'dır; gerçek uygulama içerik hash'li bir chunk'tadır ve adı build'ler arasında
değişir. Bu yüzden hedef barrel'ın ilk yeniden-dışa-aktarma importu üzerinden **çözülür**, sonra
içerikle doğrulanır (`SessionContext.select` chunk içinde bulunmalıdır).

| Durum | sha256 |
| --- | --- |
| Önce (orijinal) | `09b0ed4dae1749183a35f2a034b294702100bc1d9867e78a08fe4d9585a6722b` (5819 bayt) |
| Sonra (yamalı) | `8059d066210bbfd04511aeacbe13589f6ca5481254b8c8c2215b8869943a36cc` (6050 bayt) |

Kurallar:

- **Yalnızca iki bayt-özdeş girdi kabul edilir.** Başka bir hash → durum `conflict`, **hiçbir şey
  üzerine yazılmaz**.
- Yamalanmış metin **yazılmadan önce** hash'lenir. Tarif byte-byte `PATCHED_SHA256`'ı
  üretmiyorsa hiçbir şey yazılmaz. Sonra yazılan dosya yeniden okunup doğrulanır.
- Hedef `realpath` ile runtime kökünün **içinde** olmalıdır; dışarı çıkan bir junction/symlink
  reddedilir — global bir kuruluma ulaşması bu yüzden mümkün değildir.
- `package.json` sürümü tam olarak `2.0.18` olmalıdır.
- Orijinal chunk bir kez `<runtime>/patch/backup/` altına **değişmez** anlık görüntü olarak alınır;
  ikinci `apply` bu yedeği yeniden doğrular, üzerine yazmaz.
- Yazma temp dosya + rename'dir; yarıda kesilen yazma chunk'ı bozmaz.
- **Çalışan çekirdek değiştirilemez.** Yama, ayakta olan bir runtime tespit ederse yalnızca
  **mutasyon yapan** işlemleri reddeder: hem `apply` (chunk orijinalse) hem `restore` (chunk
  yamalıysa). Zaten hedef durumda olan bir çağrı (`apply` yamaya, `restore` orijinale) **no-op**
  döner; no-op hiçbir şey yazmadığı için canlı çekirdek üzerinde bir mutasyon yapmaz.
- Yama hiçbir süreci öldürmez, sinyal göndermez; süreç yönetimi `local.mjs`'in işidir.

---

## Node sürüm kapısı

`runtime-package.json` içindeki `engines.node` ve çalışma zamanı kontrolü **Node >= 24** ister.
Kumanda betiği Node 22 ile çalışabilir; `setup`, desteklenen win-x64 ortamında özel Node'u
indirir. Sunucu ise yalnızca sürüm kontrolünden geçen Node ile başlatılır.

---

## Doğrulama durumu

Bu bölüm **ölçümlü olanı** ayırır. Ölçüm tarihi: **2026-10-03**. Aşağıdaki taze kök ölçüm,
kullanıcının seçtiği **güncel kaynak ağacından** alınan **yayın adayına** aittir.

**Kök kontrol (taze yayın adayı, 2026-10-03) — yeşil.** `npm run typecheck` çıkış **0**;
`npm test` çıkış **0**: 8 dosyada **1192 kontrol geçti, 0 başarısız**
(208 + 125 + 178 + 96 + 108 + 123 + 93 + 261).

**Paket testleri — ayrı komut.** `npm run test:local-runtime` → **48 kontrol geçti, 0 başarısız**; 48/48 hem
denetleyici Node **22.16.0** hem de sunucunun kendi Node **24.21.0**'iyle doğrulandı. Bunlar
**saf fonksiyon** testleridir (`server.test.mjs` sahte sunucu **başlatmaz**; HTTP sözleşmesi
buradan çıkarılamaz) ve 6 entegrasyon senaryosunu **kapsamaz**. Bu komut `npm test'in **içinde
değildir**; yukarıdaki 1192 kontrolün parçası **değildir** ve iki küme karıştırılmaz.

**Uçtan uca kabul — tarihsel P20 anlık görüntüsü; bu adayın ölçümü DEĞİLDİR.**
`run-2026-10-03T06-58-44-799Z`, verdict **PASS** (harness `sha256 efa992d4…`, 06:58:44 → 06:59:10 UTC;
kaynak `acceptance/results.json`). Bu kayıt **farklı bir aşamada**, farklı bir kaynak ağacında
alınmıştır; aşağıdaki sayılar bu adayın TypeScript dosya parmak izlerine **bağlanmaz** ve
yeşil kök kontrolünün parçası değildir:

| Ölçüm | Sonuç |
| --- | --- |
| Devam senaryosu | **6/6 geçti** — `architect` ×3, `crew/maker` ×3 |
| Her geçiş | park → mutasyon (n=1..6) → park sırasında yeni `setup.begin` → ikinci istekte araç rolü → `wait 204` → `DONE`, **0 rol hatası** |
| Araç çağrısı | `toolCompleted`, parça durumu `completed` |
| `/api/plugin` | başlangıç **90/90 aktif**, son **90/90 aktif** (89 native + 1 prob paketi); `orchestra.project-local` aktif, özgün `orchestra` **yok**, `tools·loop·fallback·tasks = ok` |
| Roller | **17** rol listelendi; `architect` ve `crew/maker` mevcut |
| Negatif kontrol | **PASS** — taze native `server.log`: `Session.AgentNotFoundError`, **aynı SID + aynı rol**, `mockRequests: 0` |
| Model | yalnızca loopback `repro-mock`; **dış/üretim çıkarımı 0** (`refusedExternalModel: 0`) |
| İzolasyon | korumalı **40/40** değişmedi, kişisel hafıza **4/4** değişmedi (içerik kopyalanmadı); ortak servis PID `24156` dokunulmadı |

**Negatif kontrolün kanıt kanalı `server.log`'dur.** Kalıcı logdaki tek olay `log.synced` ve
içinde 0 rol hatası vardır: bu **kanıt değildir**, rol hatası DRAIN sonrası doğar. HTTP 200
gövdesi de kanıt değildir.

**CLI.** Kurulu gerçek native CLI **2.0.18**, `api` komutuyla **açık `--server`** üzerinden:
sürüm okuması, **17 rol** ve kimlik doğrulaması **PASS**; yanlış parola **1 kez reddedildi**
(`.orchestra-runtime/cli-acceptance.json`). **Etkileşimli `attach`/TUI test edilmedi.**

**Geri alma.** `restore` → `09b0…` orijinal; bu çekirdekte `start` **reddedildi** → `setup` →
yeniden `8059…` yamalı. Kanıt: `rollback-report.json`.

**Önceki kırmızı ölçümler — güncel yayın durumu DEĞİLDİR.** Aşağıdaki iki kayıt, bu adaydan
**önce**, aynı ağacın eski halinde alınmış ölçümlerdir; bugünün durumu böyle değildir:

- `npm run typecheck` → çıkış **2**, **tek** hata: `tasks.ts(452,37) TS2339
  BudgetProbe.yeniGorev`. Satır numarası kontrol sayısı değildir.
- `npm test` → çıkış **1**: `memory-durability` **105 geçti / 1 başarısız = 106 kontrol**;
  `&&` zinciri yüzünden `loop` / `injection` / `tasks` dosyaları **koşmadı**.

**Bu yayın adayında bu iki hata yeniden üretilmedi** (typecheck çıkış 0, `npm test` çıkış 0, 1192/0).
Bu, "hatayı biz düzelttik" iddiası **değildir**: aday, birincil ağacın o an donmuş kopyasından alındı;
bu belge yazımı hiçbir kaynak kodu, testi veya eşiği değiştirmedi. "Yalnızca ölçülen yeşildir";
aşağıdaki sınırlar kaldığı gibi geçerlidir.

**Test edilmeyenler.** Etkileşimli TUI ve **gerçek ebeveyn→çocuk alt ajan doğumu** ölçülmedi;
6 senaryo yalnızca iki rolün **API üzerinden devam** davranışını kapsar. Upstream'in tam
TypeScript build'i çalıştırılmadı; resmî EXE değiştirilmedi, ortak servis yamalı ya da yeniden
başlatılmadı, commit/push/publish yok. Kimlik kopyalanmadı.

**Kanıt dosyaları yereldir ve taşınmaz.** `results.json`, `run-*/`, `rollback-report.json` ve
`cli-acceptance.json` `.gitignore`'lı ve **sürümlenmez**; **yeni bir klonda bulunmaz.**
Tekrarlanabilir komutlar:

```sh
npm run test:local-runtime        # 48 kontrol, saf fonksiyonlar
npm run opencode:local:setup      # yamayı uygular
npm run opencode:local:start      # yerel sunucu
npm run opencode:local:status     # url / pid / hash / kimlik
npm run opencode:local:stop       # yalnızca bu sunucuyu kapat
```

6 entegrasyon senaryosu **bu komutların hiçbirinde koşmaz**: kabul harness'i geçici
(disposable) dizinde tutulur ve izlenmez; `npm test` bu senaryoları **da** çalıştırmaz ve bu
sayfadaki 48 kontrolü de içermez.

---

## Lisans ve atıf

Bu kit kendi kodunu `MIT` lisansıyla dağıtır ve **yayınlanmaz**.

`session-context-2.0.18.patch` ve `fixtures/session-context-original.js`, üçüncü taraf kaynak
koddur ve upstream'in **MIT** lisansıyla gelir. Upstream'in resmî MIT metni depoda
[`LICENSE.opencode`](LICENSE.opencode) dosyasındadır; **doğrulama için o dosyayı oku**,
bu belgedeki özetine güvenme.

- proje: `github.com/anomalyco/opencode` (paket `packages/core`)
- etiket: `v2.0.18`
- commit: `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`
  ([kaynak](https://github.com/anomalyco/opencode/tree/cd9a14a6b688d4021bee381dfd39d2cef9c0f862))
- dosya: `packages/core/src/session/context.ts`

Bu satırlar kimliği tanımlar (hangi sürüm, hangi commit, hangi dosya); **kaynak kökeni hakkında
ayrı bir iddia bu belgede üretilmez.** Öncül patch başlığındaki "GitHub API'sinden raporlandı"
türü köken notu düzeltilmiştir ve burada tekrar edilmez: ne yerelde doğrulandığını ne de
doğrulanmadığını bu doküman uydurmaz. Lisansta uyuşmazlık görürsen doğru kaynak `LICENSE.opencode`
ve yukarıdaki upstream bağlantısıdır.

Yamanın yaptığı: `yield* mcpTools.flush` ile `const agent = yield* agents.select(...)` arasına
beş satırlık bir bariyer (`Effect.serviceOption(Plugin.Service)` → `awaitActivation`) ve iki
import bağı (`effect`'ten `Option`, plugin service barrel'ından **adlandırılmış** `Plugin`
export'u). Yapmadığı: servis katmanı grafiği değişikliği, retry, cache, timeout, izin verimi.
Bariyer yalnızca okumayı sıralar; gerçekten eksik bir rol sonraki aramada yine başarısız olur.

---

## Dosya envanteri

| Dosya | Rol |
| --- | --- |
| `local.mjs` | Komut satırı. **Tek yazan yüzey** |
| `patch.mjs` | Çekirdek yamayı çözer, uygular, geri alır, hash'ler |
| `support.mjs` | Saf yardımcılar: yol üretimi, ayna planı, ortam, kimlik doğrulama |
| `server.mjs` | HTTP sunucusu: `/__orchestra_runtime/info`, `/…/shutdown` |
| `runtime-package.json` | Sabitlenmiş runtime manifesti (kök manifestin parçası **değil**) |
| `session-context-2.0.18.patch` | Kanonik upstream farkı (insan okur referansı) |
| `fixtures/session-context-original.js` | Upstream orijinalinin referans kopyası (test verisi) |
| `*.test.mjs` | Yama / yardımcı / sunucu testleri |

`<runtime>` = `<depo>/.orchestra-runtime/` (`.gitignore`'lı). Silmek runtime'i sıfırlar; genel
kurulumu etkilemez.
