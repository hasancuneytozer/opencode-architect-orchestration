---
description: Sıradaki görev durumunu, hafıza sağlığını ve yapılacakları tek ekranda göster
agent: architect
subagent: false
---

`/standup` — Orchestra durum raporu.

Şunları topla ve tek ekranda raporla:

1. **Oturum** — mevcut hedef nedir, kabul kriterleri neler, geriye ne kaldı?
2. **Döngü** — `/loop status` çalıştır: durum, iterasyon sayısı, son rapor, bitiş nedeni.
   (Çalışmıyorsa "döngü yok" de.)
3. **Hafıza** — `orchestra_recall` ile istatistiği al: toplam/aktif/otomatik/bekleyen sinyal
   sayıları. En güçlü 5 dersi listele.
4. **Bekleyen dönüşüm** — `needsLesson` işaretli auto hatalar varsa listele ve
   `crew/curator` çağırmayı öner.
5. **Sıradaki** — bir sonraki tek adım. Tek cümle.

Rapor kısa olsun. Süsleme yok, sayı ve kanıt var.
