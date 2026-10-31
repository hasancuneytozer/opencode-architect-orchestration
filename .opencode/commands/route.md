---
description: "Görev türüne göre küçük ve açık bir ekip öner; ajan başlatmaz."
agent: architect
---
Görev: $ARGUMENTS
Türü architecture/implementation/review/research/docs, riski low/normal/high olarak belirle.
`node scripts/route-task.mjs <tür> <risk>` ile mevcut rol/model dosyalarından öneriyi oku.
Bu salt okunur araç ajan başlatmaz ve model erişimini kanıtlamaz. Modeli runtime kataloğunda doğrula.
Küçük işte tüm crew'u çağırma. Yüksek riskte mimari karar ve ayrı inceleme zorunludur.
Ücretli modele veya farklı sağlayıcıya sessiz fallback yapma. Kullanıcının seçili ana modelini koru.
