# AGENTS.md — bu deponun çalışma kuralları

Bu depo, opencode için **mimar-merkezli orkestrasyon sistemini (Orchestra)** kendisi barındırır.
Burada değişiklik yaparken bu kurallar geçerlidir.

## Katmanlar ve dokunma sırası

| Katman | Yol | Değiştirme kuralı |
| --- | --- | --- |
| Rol | `.opencode/agents/` | Frontmatter'da `description` **tırnak içinde** olmalı. İçinde `": "` geçerse YAML bozulur ve rol `primary` olarak yüklenir. |
| Beceri | `.opencode/skills/<id>/SKILL.md` | Kimlik dosya yolundan gelir; `<id>` ile klasör adı aynı olmalı. |
| Komut | `.opencode/commands/<ad>.md` | Yalnızca `.md`. `$ARGUMENTS` kullanıcı girdisidir. |
| Hafıza | `.opencode/plugins/orchestra/` | Tip güvenliği zorunlu: `npm run typecheck` yeşil olmadan bitirme. |
| Veri | `.opencode/memory/` | `lessons.jsonl` versiyonlanır, `state.json` geçicidir. |

## Plugin kuralları

- Hafıza yakalama **asla** bir model çağrısını bozamamalı. Hook içinde `try/catch` zorunlu.
- Tüm ders mutasyonları `Memory.commit()` üzerinden geçer. Doğrudan `persistLessons()`
  çağırma: dış değişiklik kontrolü mutasyondan **önce** çalışmalıdır.
- Yeni araç eklerken `options: { namespace: "orchestra" }` kullan ve **adına `orchestra_`
  ön ekini koyma**; namespace zaten ekliyor. Ön ek koyarsan etkin ad
  `orchestra_orchestra_x` olur ve `SELF_TOOLS` filtresi yakalayamaz.
- Araç hatası iki yoldan gelir: `status === "error"` ya da "başarılı" dönüp hata metni
  içeren çıktı. V2'de sıfır dışı çıkış kodu ikincisidir; ikisini de ele al.

## Doğrulama

```sh
npm run typecheck                        # plugin tip güvenliği
opencode debug agents                    # roller yüklendi mi
opencode plugin list                     # plugin keşfedildi mi
opencode api get /openapi.json           # servis ayakta mı
```

Plugin tanılama kanalı: `orchestra_recall` çıktısının sonunda `UYARI:` satırı varsa bir
parça kaydedilememiştir. `state.json` içindeki `diagnostics.steps` bunun kaynağıdır.

## Hafıza kuralları

- Ders **kural** olmalı, olay değil: "bunu yap" yaz, "dikkat et" yazma.
- Tek seferlik hatalar derse çevrilmez. Eşik 3.
- Yanlış dersi silme, `orchestra_forget` ile emekliye ayır.
- `lessons.jsonl` elle düzenlenebilir; plugin dış değişikliği fark eder ve üzerine yazar.
  Dosyayı silerek sıfırlamak çalışır.

## Durum

Bitirdiğinde şunları raporla: hangi katmana dokundun, tip kontrolü geçti mi, canlı
davranışı nasıl doğruladın. "Muhtemelen çalışır" kabul edilmez.
