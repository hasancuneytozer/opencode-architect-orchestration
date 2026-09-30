---
description: Rol ekle/çıkar, bir rolün yeteneğini genişlet, beceri ekle/kaldır
agent: architect
subagent: false
---

Kadro talebi: $ARGUMENTS

`cast` becerisini uygula:

1. **Önce mevcut rol yeter mi?** Yeni rol eklemeden önce mevcut rollerin yeteneklerini ve
   izinlerini gözden geçir. Gerekiyorsa rolü genişlet (izin + gövde + model).
2. **Gerekçeyi yaz:** bu yeteneği neden ayrı bir rol istiyorsun? Hangi iş paketleri
   aynı rolden çıkacak?
3. Yeni rol gerekiyorsa `.opencode/agents/crew/<ad>.md` yaz:
   - `description` tek cümle ve modelin onu seçebileceği kadar ayırt edici
   - `mode: subagent`, uygun `model`
   - salt-okunur rol ise `edit: deny`
   - gövdede Kurallar / Yöntem / Yasaklar / **Ne döneceksin** bölümleri
4. Rol kaldırılacaksa sil ya da `opencode.jsonc` içinde `disabled: true` yap.
5. Beceri eklemek/güncellemek gerekiyorsa `.opencode/skills/<id>/SKILL.md` yaz ya da düzenle.
6. Ardından `opencode debug agents` ile kadronun gerçekten yüklendiğini doğrula ve değişikliği
   tek cümleyle özetle.

Değişiklikten sonra mimara ne kazandı, ne kaybetti — onu da yaz.
