---
description: Orchestra hafızasını tara — bu konuda hangi dersler var?
agent: architect
subagent: false
---

Konu: $ARGUMENTS

1. `orchestra_recall` aracıyla bu konudaki dersleri getir (limit vererek).
2. Çıkanları üç gruba ayır:
   - **Uygulanacak kurallar** — bu işte doğrudan geçerli, uyulması gerekenler
   - **İlgili ama geçerli değil** — bağlamı tutmuyor, neden geçerli değil
   - **Eksik ders** — bu konuda hata yapmaya açık, sistemde karşılığı olmayan bir şey
3. Hafızadaki çelişen veya bayat dersleri tespit et; gerekiyorsa `orchestra_forget` ile
   emekliye ayır.
4. Eksik ders için `orchestra_lesson` ile tek satırlık uygulanabilir kural yaz.

Sonuç: kısa bir liste. Ne öğrenildi, ne geçerli, ne eksik.
