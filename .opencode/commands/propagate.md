---
description: Kaynak repo ile türetilen projeler arasındaki sapmayı raporlar; hiçbir dosyayı değiştirmez
agent: architect
subagent: false
---

`$ARGUMENTS` — Orchestra aktarım denetimi.

Kaynak repo **her zaman** bu repo (`.opencode/agents/architect.md` bunun sahibidir).
Türetilen projeler: `C:\projects\eynva-studio`, `C:\projects\opencode-library`,
`C:\projects\opencode-observer`.

## Kesin kural

**Aktarım tek yönlüdür: bu repo → diğerleri.** Asla tersi. Bir hedefe ait özellik
(kendi plugin'i, kendi config'i, kendi AGENTS.md'si) buraya geri yazılmaz.

## Yapılacak

1. **Yüzeyleri karşılaştır.** Her hedef için:
   - `.opencode/commands/`, `.opencode/skills/`, `.opencode/agents/` — içerik
     karşılaştırması yap; **satır sonu (LF/CRLF) farkı gerçek fark sayma.**
   - `.opencode/plugins/orchestra/` — dosya kümesi ve içerik.
   - `AGENTS.md`, `.opencode/orchestra.json`, `opencode.jsonc`, `package.json` —
     **yalnızca varlık/varlık değil**; bunlar projeye özeldir.
2. **Üç durum ayır ve karıştırma:**
   - **ESKİ** — hedefte var, kaynakta var, içerik eski. Bu **aktarılabilir**.
   - **YENİ EKSİK** — kaynakta var, hedefte yok. Bu **aktarılabilir**.
   - **ÖZGÜ** — hedefte var, kaynakta yok ya da yapısal olarak farklı.
     Bu **aktarılamaz**; projeye özel bir karardır. Dokunma, sadece bildir.
3. **Aktarılabilir olanı listele**, dosya yoluyla birlikte.
4. **Özgü olanı ayrı listele** ve neden ayrı olduğunu tek cümleyle yaz.
5. Hiçbir dosyayı değiştirme. Rapor ver, kararı bana bırak.

## Raporda ne olsun

- Hedef başına: `ESKİ` / `YENİ EKSİK` / `ÖZGÜ` başlığı altında dosya listesi.
- **Karar gerektiren** durum varsa en sonda tek cümleyle yaz: ne seçenekler var.
- Sayı ve dosya yolu. Açıklama şişirme, gerekçe yalnız `ÖZGÜ` için tek cümle.

Rapor kısa olsun. Aktarım için ayrı bir komut/görev ayrıdır; bu komut yalnızca raporlar.