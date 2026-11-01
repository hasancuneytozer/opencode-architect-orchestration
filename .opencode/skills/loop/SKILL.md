---
name: Otonom Döngü
description: Tam otonom, çok iterasyonlu bir işi "bitene kadar" yürütmeyi tanımlar. Her iterasyon sonunda rapor verir, durdurma koşullarına uyar, ilerleme yoksa yaklaşımı değiştirir. /loop komutuyla veya "bitene kadar" isteğiyle kullan.
---

# Otonom Döngü

Kabul işi ilerleyebildiği sürece toplam adım, görev, iterasyon veya süre tavanı yoktur. `max=0` ve toplam süre `0` sınırsızdır; açık kullanıcı sınırları desteklenir. Eşzamanlı çalışan sınırı ikidir.

## Döngü anatomisi

`/loop <hedef> [--max=N]` komutu, her iterasyonda oturuma bir tur promptu gönderir, tur bitince
`orchestra_report` çıktısını okur ve ona göre karar verir. Sana düşen tek kural şu:

Kullanıcı açıkça otonom çalışma istediğinde de `/loop` kullan. Worker döndüğünde kaydı aynı
tur `verifying` veya `blocked`/`failed` yap; otomatik `done` veya TTL ile kilit açma.
`verifying` yüzeyi kilitler ama running slotu tüketmez. Gerçek verifier ajanı için ayrı
running iş paketi tut ve toplam iki çalışan sınırını aşma; verifier kabul kriterini test eder.

**Her iterasyonun sonunda `orchestra_report` çağrı.**

Eksik veya bayat rapor teknik protokol arızasıdır. Planlama ve çalışan işçiyi bekleme,
tamamlanmış çözüm denemesi değildir; bunlar için sahte ilerleme kanıtı üretme.

## Her iterasyonun ritmi

1. **Hafıza:** `orchestra_recall` ile hedefle ilgili dersleri getir. Onlara uy.
2. **Durum tespiti:** hedefe ne kadar yaklaşıldı? Geriye ne kaldı? *Ölç.* Tahmin etme.
3. **Böl ve devret:** `dispatch` becerisine göre iş paketleri üret, bağımsız olanları paralel başlat.
4. **En küçük anlamlı adım:** bir adım seç, bitir, doğrula. Yarım iş bırakma.
5. **Ders çıkar:** yeni bir hata/desen öğrendysen `orchestra_lesson` yaz.
6. **Rapor ver:** `orchestra_report` çağır.

## Rapor sözleşmesi

| Durum | Ne zaman | Alanlar |
| --- | --- | --- |
| `continue` | Hedef henüz tamamlanmadı; kanıtlı ilerleme, somut yapılabilir iş veya çalışan iş var | `summary`, `next`, defter kaydı/kanıt |
| `done` | Kabul kriterleri karşılandı | `summary`, `evidence` |
| `blocked` | Karar veya dış girdi gerekiyor | `summary`, `blockers` |

İlerleme iddiasını komut çıktısı, test sonucu veya oluşturulan çıktı ile destekle.
Planlama/bekleme raporunda somut görev/kriter ve çalışan iş referansını kullan;
işçi henüz sonuç vermediyse tamamlanmış deneme veya ilerleme kanıtı uydurma.

## Döngüyü kendin durdurma

- **Erken `done` deme.** Kabul kriterlerini tek tek kontrol et. Sağlamadıysa `continue`.
- **Engeli kaydet.** İlgili paketi engeliyle işaretle; bağımsız yapılabilir işleri sürdür.
  Kalan kabul kriterleri için ilerlenebilir yol yoksa genel `blocked` raporla.
- **Tekrarı kaydet.** Aynı kalıcı `criterionID` / `blockerID` için üçüncü tamamlanmış başarısız çözüm denemesinde yalnız ilgili kriter durur. Model turu, rapor metni veya yeni görev kimliği sayacı sıfırlamaz. Bağımsız işler sürer; ancak yapılabilir iş kalmadığında genel `blocked` raporlanır.
- `orchestra_task` ile `criterionID` ve `attempt: {id, blockerID, outcome, evidence}` yaz. Outcome: `failed`, `progress`, `resolved`, `verified`. Kanıt zorunludur. Çözüm açıkça `resolved` olarak kanıtlanır; geçmiş korunur. Tüm kriterler `verified` ve canlı görev kalmamışsa `done` ver.
- `resolved` kaydına nedensel `reason`, başarılı `verification` ve başarısız denemeden
  farklı doğrulama kanıtı ekle. Aynı hata çıktısını çözüm diye yeniden sunma.
- Yeniden deneme paketinde değiştirdiğin terminal işi `supersedes` ile belirt;
  `nextWork` ve kanıtla somut yeni yaklaşımı açıkla. Eski başarısızlığı silme.
- Arka plan işçisinin gerçek oturumunu görevde `workerID` olarak kaydet. Sonucunu
  beklerken raporda `waitingFor: [workerID]` kullan; sürekli yeni model turu üretme.
- Context özetlendikten sonra `orchestra_status({criterionID, offset: 0, limit: 10})`
  ile deneme, engel ve doğrulama geçmişini geri oku. Ayrıntı: `docs/PROGRESS-ORCHESTRATION.md`.

## Kapanış

`done` bildirdiğinde tek bir kapanış raporu yaz: ne yapıldı, kabul kriterlerinin durumu,
kanıtlar, ve sisteme eklenen dersler. Kısa ve kanıtlı.

## Denetim

- `/loop status` — mevcut iterasyon, hedef, son rapor.
- `/loop stop` — döngüyü o noktada durdurur.
- `.opencode/memory/state.json` — döngünün kalıcı durumu, elle okunabilir.

## Tehlike

Otonomi, onaylanmamış yıkıcı işlemler için kullanılamaz. Üretim dağıtımı, veri silme, göç, kimlik
yazma gibi işlerde döngü `blocked` durur ve insana sorar. Bu davranış korunmalıdır; devre dışı
bırakma.
