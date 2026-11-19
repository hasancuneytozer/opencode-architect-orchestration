---
description: Orchestra orkestrasyonunu tam çalıştırır — brifing, iş bölümü, paralel sevkiyat, doğrulama, ders çıkarma
agent: architect
subagent: false
---

$ARGUMENTS

Bu görevi tam Orchestra akışıyla yürüt:

1. **`brief` becerisi** — hedefi tek cümleye indir, gözlemlenebilir kabul kriterleri üret, kapsam dışını adlandır, ucuz belirsizlikleri varsayımla kapat (varsayımları yaz), pahalı ya da dışarı etkili belirsizlikleri tek seferde `question` ile sor.
2. Görev bağlantısı varsa Architect rolünün İş Akışı teslim adımlarını uygula. Teslim sahibi ve kabul ölçütü aynı görevde izlenir.
3. Bağımsız paketleri `dispatch` becerisiyle dağıt. Birlikte çalışan bileşenleri birleşmiş sürümde sına.
4. İş Akışı'na kaydedilen kanıtı sohbette yeniden yazma. Sonucu, engeli veya gereken kararı bildir.

Bu işi otonom bitirmek istiyorsan: her tur sonunda `orchestra_report` çağır. Kullanıcı
`/loop <hedef>` ile de başlatabilir.
