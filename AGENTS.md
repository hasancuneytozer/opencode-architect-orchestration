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
| Veri | `.opencode/memory/` | **Sürümlenmez** (`.gitignore`'da). Hafıza kişiye özeldir; her klon sıfırdan başlar. |

## Plugin kuralları

- Hafıza yakalama **asla** bir model çağrısını bozamamalı. Hook içinde `try/catch` zorunlu.
- Tüm ders mutasyonları `Memory.commit()` üzerinden geçer. Doğrudan `persistLessons()`
  çağırma: dış değişiklik kontrolü mutasyondan **önce** çalışmalıdır.
- Yeni araç eklerken `options: { namespace: "orchestra" }` kullan ve **adına `orchestra_`
  ön ekini koyma**; namespace zaten ekliyor. Ön ek koyarsan etkin ad
  `orchestra_orchestra_x` olur ve `SELF_TOOLS` filtresi yakalayamaz.
- Araç hatası iki yoldan gelir: `status === "error"` ya da "başarılı" dönüp hata metni
  içeren çıktı. V2'de sıfır dışı çıkış kodu ikincisidir; ikisini de ele al.

## Ortak İş Akışı ve görev devri

- Çok adımlı işlerde ilk planı kalıcı İş Akışı grafiğine yaz ve bağlantısını kullanıcıya göster. Ayrı teslimi veya doğrulaması olan kolları başladıkları göreve bağlı alt akışlara böl. Bağımlılığı, birleşme noktasını ve çelişkileri ilgili dal ve üst görevde izle.
- Görev paketi hedefi, yazma kapsamını, kabul ölçütünü, aynen taşınan görev bağlantısını ve gerekiyorsa sabit yetenek sürümünü içerir. Her proje kendi rol adlarını ve araçlarını bu sorumluluklara eşler.
- Tek yüzeyli, düşük riskli ve otomatik testle doğrulanabilen işler tek uygulayıcıyla yürüyebilir. Bağımsız kontrol veya ayrı iş kolları değer kattığında Architect işi böler ve işi doğrulayacak ayrı rolü seçer.
- İş Akışı MCP bağlantısı kullanılıyorsa çalışma ortamı her oturuma yalnızca atanmış görevi kapsayan kendi erişimini sağlar. Görev bağlantısını paketle ilet ve araçların göründüğünü kontrol et. Erişim bilgisini göreve veya rol dosyasına koyma.
- Maker değişikliği ve test kanıtını teslim olarak kaydeder. Verifier aynı teslimin kontrol sonucunu ve kanıtını ayrı yazar. Araç yoksa sonucu Architect'e ilet ve yazmanın gerçekleşmediğini belirt.

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
- `.opencode/memory/` depoya girmez; her klon sıfır hafızayla başlar. Hafıza elle
  düzenlenebilir, plugin dış değişikliği fark eder. Dosyayı silmek hafızayı sıfırlar.

## Durum

Bitirdiğinde şunları raporla: hangi katmana dokundun, tip kontrolü geçti mi, canlı
davranışı nasıl doğruladın. "Muhtemelen çalışır" kabul edilmez.
