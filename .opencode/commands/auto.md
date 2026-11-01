---
description: Hedefi otonom, kalıcı kabul kriterleri ve kanıtlarla "bitene kadar" yürüt
agent: architect
subagent: false
---

Bu görevi tam otonom yürüt: $ARGUMENTS

1. Önce hedefi tek cümleye indir ve gözlemlenebilir kabul kriterlerini yaz.
2. `orchestra_recall` ile ilgili dersleri getir.
3. `dispatch` becerisine göre iş paketlerini böl ve bağımsız olanları paralel başlat.
4. Her tur sonunda **`orchestra_report`** çağır — bu olmadan otonomi sürdürülemez:
   - gerçek ilerleme, yapılabilir bağımsız iş veya sonucu beklenen çalışan iş varsa
     `continue` + `next` + kalıcı görev/kriter referansı ve uygun kanıt
   - kabul kriterleri karşılandıysa `done` + kanıtlar
   - yapılabilir iş kalmadıysa `blocked` + engel, hangi karar, hangi seçenekler
5. Aynı kalıcı kabul kriteri/engel için üç sonuçsuz çözüm denemesini kanıtıyla kaydet;
   ilgili işi blokla, bağımsız işleri sürdür. Görev/işçi değiştirmek sayacı sıfırlamaz.
6. Tekrarlanan ve doğrulanmış hata örüntülerini `orchestra_lesson` ile uygulanabilir derse çevir;
   tek seferlik gürültüyü kalıcı kural yapma.

Tur bitince tek satırla `ORCHESTRA-STATUS: continue|done|blocked` yaz.
