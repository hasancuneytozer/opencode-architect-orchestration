---
description: Hedefi otonom, rapor tabanlı ve sınırlı biçimde "bitene kadar" yürüt
agent: architect
subagent: false
---

Bu görevi tam otonom yürüt: $ARGUMENTS

1. Önce hedefi tek cümleye indir ve gözlemlenebilir kabul kriterlerini yaz.
2. `orchestra_recall` ile ilgili dersleri getir.
3. `dispatch` becerisine göre iş paketlerini böl ve bağımsız olanları paralel başlat.
4. Her tur sonunda **`orchestra_report`** çağır — bu olmadan otonomi sürdürülemez:
   - gerçek ilerleme varsa `continue` + `next` + en az bir kanıt
   - kabul kriterleri karşılandıysa `done` + kanıtlar
   - karar gerekiyorsa `blocked` + hangi karar, hangi seçenekler
5. Aynı hataya ikinci kez takılırsan yaklaşımı değiştir; üçüncü denemeyi yapma.
6. Öğrendiğin her hatayı `orchestra_lesson` ile kalıcı derse çevir.

Tur bitince tek satırla `ORCHESTRA-STATUS: continue|done|blocked` yaz.
