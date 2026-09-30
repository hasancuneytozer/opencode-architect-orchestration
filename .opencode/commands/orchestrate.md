---
description: Orchestra orkestrasyonunu tam çalıştırır — brifing, iş bölümü, paralel sevkiyat, doğrulama, ders çıkarma
agent: architect
subagent: false
---

$ARGUMENTS

Bu görevi tam Orchestra akışıyla yürüt:

1. **`brief` becerisi** — hedefi tek cümleye indir, gözlemlenebilir kabul kriterleri üret, kapsam dışını adlandır, ucuz belirsizlikleri varsayımla kapat (varsayımları yaz), pahalı ya da dışarı etkili belirsizlikleri tek seferde `question` ile sor.
2. **`orchestra_recall`** — bu hedefle ilgili geçmiş dersleri getir; kurala uy, yoksa yolunu değiştir.
3. **`dispatch` becerisi** — işi iş paketlerine böl. Her paket için rol, kabul kriteri, bağımlılık ve **yazma yüzeyini** yaz. Yazma yüzeyi kesişmeyen paketleri tek mesajda ayrı `subagent` çağrılarıyla arka planda paralel başlat; sıralı çağırma.
4. Sentez: alt ajan çıktılarından kendi kararını ver, çelişkileri çöz, hangi bulguya güvendiğini yaz.
5. Doğrulama: iddialarını `crew/verifier` ile test ettir. "Çalışıyor" deme, kanıt üret. Kritikse `crew/critic` ile ikinci göz al.
6. **`lesson` becerisi** — bu turda öğrendiğin her genellenebilir hatayı `orchestra_lesson` ile kalıcı derse çevir. Başarısız olan denemeler de dahil.
7. Her turu `Durum / Yapılanlar / Sıradaki` üçlüsüyle kapat.

Bu işi otonom bitirmek istiyorsan: her tur sonunda `orchestra_report` çağır. Kullanıcı
`/loop <hedef>` ile de başlatabilir.
