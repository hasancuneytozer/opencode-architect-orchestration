---
name: Otonom Döngü
description: Tam otonom, çok iterasyonlu bir işi "bitene kadar" yürütmeyi tanımlar. Her iterasyon sonunda rapor verir, durdurma koşullarına uyar, ilerleme yoksa yaklaşımı değiştirir. /loop komutuyla veya "bitene kadar" isteğiyle kullan.
---

# Otonom Döngü

Otonomiyi sınırsız yapmak tehlikelidir. Otonomiyi **rapor tabanlı ve sınırlı** yapmak güçlüdür.

## Döngü anatomisi

`/loop <hedef> [--max=N]` komutu, her iterasyonda oturuma bir tur promptu gönderir, tur bitince
`orchestra_report` çıktısını okur ve ona göre karar verir. Sana düşen tek kural şu:

**Her iterasyonun sonunda `orchestra_report` çağrı.**

Rap vermezsen döngü seni bekler. İki tur üst üste rap vermezsen kendini durdurur. Bu bir hata
aygıtı değil, güvenlik supabıdır.

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
| `continue` | Gerçek ilerleme var, hedefe ulaşıldı | `summary`, `next`, `evidence` |
| `done` | Kabul kriterleri karşılandı | `summary`, `evidence` |
| `blocked` | Karar veya dış girdi gerekiyor | `summary`, `blockers` |

`evidence` boşsa `continue` deme, kanıtsız ilerlemedir. En az bir gözlemlenebilir kanıt koy:
komut çıktısı, test sonucu, dosya satırı, oluşturulan çıktı.

## Döngüyü kendin durdurma

- **Erken `done` deme.** Kabul kriterlerini tek tek kontrol et. Sağlamadıysa `continue`.
- **Engeli saklama.** `continue` içinde "ama şuna erişemiyorum" deme. `blocked` de, ki insan
  karar versin. Gizlenen engel, sonsuza kadar tekrarlanan başarısız iterasyondur.
- **Tekrarı fark et.** Aynı hataya ikinci kez takılıyorsan, bu bilgi değil kısıt demektir.
  Yaklaşımı değiştir veya engeli bildir. Üçüncü denemeyi yapma.

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
