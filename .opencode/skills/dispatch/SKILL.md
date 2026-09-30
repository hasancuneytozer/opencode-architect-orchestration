---
name: İş Bölümü ve Paralel Sevkiyat
description: Bir görevi bağımsız iş paketlerine bömer, yazma yüzeyi çakışmasını tespit eder ve paketleri gerçekten paralel başlatır. Karmaşık, çok adımlı veya birden çok alana dokunan her işte kullan.
---

# İş Bölümü ve Paralel Sevkiyat

Paralellik bir **karar** değil, bir sonuçtur. Yanlış bölünmüş bir işi paralel başlatmak, onu
seri başlatmaktan daha kötüdür: çakışan yazmaları sessizce bozar.

## Adım 1 — Kapsamı çerçevele

Tek cümleyle hedef, tek cümleyle kabul kriteri yaz. Sonra kapsam dışını adlandır.
Bu üçü yazılmadan paket üretme.

## Adım 2 — İş paketi şablonu

Her paket şu alanlara sahip olmalıdır:

| Alan | Anlamı |
| --- | --- |
| Kimlik | K1, K2, ... |
| Hedef | Tek cümle, eylem cümlesi |
| Rol | `crew/scout`, `crew/maker`, ... |
| Girdi | Okunacak dosyalar / konu / arama sorgusu |
| Kabul | Gözlemlenebilir çıktı |
| Bağımlılık | Hangi paketler bitmeden başlayamaz |
| Yazma yüzeyi | Değiştirebileceği yollar (boşsa salt-okunur) |
| Bütçe | Derinlik: kaba tarama mı, derin analiz mi |

Yazma yüzeyi **mutlaka** doldurulmalı. Boş bırakılan yüzey, çakışma tespitini imkânsız kılar ve
paralel kararını keyfî hale getirir.

## Adım 3 — Bağımlılık grafiğini çıkar

Paketleri şu üç kategoriye ayır:

- **Düzey 0 (bağımsız):** Hiçbir pakete bağımlı değil → *aynı anda* başlatılabilir.
- **Düzey n:** Bir önceki düzeyin çıktısını kullanıyor → düzey bittikten sonra başlat.
- **Çakışan:** Bağımlılığı olmasa da yazma yüzeyi başka bir paketle kesişiyor → sıraya al
  (ya da worktree ile ayır).

Kesişen yüzey tespitinde şunları karşılaştır: dosya yolları, glob desenleri, aynı veritabanı/tablo,
aynı servisin yapılandırması, aynı çıktı dosyası (rapor, görsel, video, build artifact).

## Adım 4 — Paralel mi, sıralı mı?

Bir paket paralel başlatılır **ancak üçü birden** doğruysa:

1. Bağımlılığı yok.
2. Yazma yüzeyi diğer paketlerle kesişmiyor.
3. Rolü, diğer paketlerin çıktısını beklemek zorunda değil.

Üçü de doğruysa, paketleri **tek mesajda, ayrı `subagent` çağrılarıyla** başlat. Sıralı çağrı yazmak,
"paralel yaptım" demek değildir — o hâlâ seridir.

Şu rolleri her zaman toplu başlatabilirsin, çünkü hiçbir şey değiştirmezler:
`crew/scout`, `crew/analyst`, `crew/researcher`, `crew/critic`.
Aynı alanı inceleyen birden fazla salt-okunur rol, birbirine zarar vermez.

## Adım 5 — Aynı yüzeyi paylaşan işler

Gerçekten eşzamanlı yazılması gereken paketler için:

- **Tercih sırası:** yeniden böl (paketleri küçült) → sonra sırala → en sonra worktree.
- Çakışmayı "muhtemelen olmaz" diye geçme. İki agent aynı satırı düşünüyorsa olur.

## Adım 6 — Entegrasyon

Alt ajan çıktıları ham nottur. Toplarken:

- Çelişen bulguları tekilleştir ve hangisine güvendiğini yaz.
- Her paketin kabul kriterini tek tek doğrulat; "yaptı" demek yetmez.
- Doğrulama gereken her paket için `crew/verifier` çağır. Kritikse `crew/critic` ile ikinci göz al.

## Sık yapılan hatalar

- **Fazla bölme:** 12 pakette hiçbiri tek başına anlamlı değil. Paket, "tek cümleyle bitti" diyebilmeli.
- **Sıralı çağrıyı paralel sanmak:** 1. paketi çağır, bitmesini bekle, 2.'yi çağır → seri yapıldı.
- **Yüzeyi belirtmemek:** "birkaç dosya" yazmak, çakışma tespiti yapılamaz demektir.
- **Doğrulamayı atlamak:** alt ajan "tamam" dedi diye iş bitti saymak.
- **Her işe tam kadro:** iki dosyalık değişiklik için 9 rol çağırmak gürültüdür, iş değildir.
