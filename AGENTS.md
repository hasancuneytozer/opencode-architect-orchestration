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
| Dayanıklılık | `.opencode/plugins/orchestra/fallback.ts` | Saf mantığı `npm test` ile test edilir. Hook asla isteği bozamamalı. |
| Yapılandırma | `.opencode/orchestra.json` | Yoksa geçerli varsayılanlar kullanılır. |
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

## Dayanıklılık kuralları (`fallback.ts`)

- `session.hook("retry")` **hazır** hook'tur. İçinde uyuyup elle yeniden prompt atma;
  `event.decision` değiştir. Böylece opencode kendi attempt muhasebesini ve sert tavanını
  yönetmeye devam eder.
- `attempt` fiziksel denemedir: ilk istek 1, **ilk retry 2**. İlk retry tam `baseDelayMs`
  beklemeli, sonrakiler ikiye katlamalı. (Bu sıra burada bir kez bozuktu, test yakaladı.)
- **Tekrar denemenin anlamsız olduğu durumlar:** kota (402), geçersiz istek (4xx), bağlam
  taşması. Bunlarda `retry: false` döndür; hazır deneme bütçesini yakma.
- **Bağlam taşması** opencode tarafından ayrı yolla compaction ile çözülür. Retry etmek
  aynı taşmayı yeniden üretir.
- `autoSwitch` **varsayılan kapalıdır** ve kapatılmalıdır. `ctx.session.switchModel`
  oturum düzeyinde kalıcı bir değişikliktir; "ilk modele dönüş" davranışını geri
  yüklemek bizim sorumluluğumuzdadır (`restoreOnRecovery`). Bu küçük ama kalıcı bir durum
  sızıntısı riski taşır; kullanıcı bilerek açmalıdır.
- **Devre kalıcı bir yasak değil.** Soğuması bitmiş model yeniden seçilebilir ve hata
  sayacı sıfırlanır; aksi halde 5 hatadan sonra devreye girmiş bir model tek hatada yeniden
  açılır ve kullanılamaz olur. `sweepBreakers()` her hatadan önce çalışır. Testlerde "iki
  model arka arkada bozulur, üçüncüye düşülür" senaryosu kilitlidir; geri alınma.
- Devre (cooldown) durumu süreç içindedir; yeniden başlatınca sıfırlanır. Kalıcılık
  gerekmiyorsa bu kabul edilmiş bir sadeleştirmedir.

## Doğrulama

```sh
npm run typecheck                        # plugin tip güvenliği
npm test                                 # saf mantık regresyon testi (55 kontrol)
opencode debug agents                    # roller yüklendi mi
opencode plugin list                     # plugin keşfedildi mi
```

Plugin tanılama kanalı: `orchestra_recall` çıktısının sonunda `UYARI:` satırı varsa bir
parça kaydedilememiştir. `state.json` içindeki `diagnostics.steps` bunun kaynağıdır.
Beklenen değer: `tools: ok`, `loop: ok`, `fallback: ok`.

## Hafıza kuralları

- Ders **kural** olmalı, olay değil: "bunu yap" yaz, "dikkat et" yazma.
- Tek seferlik hatalar derse çevrilmez. Eşik 3.
- Yanlış dersi silme, `orchestra_forget` ile emekliye ayır.
- Dayanıklılık katmanı da hafızaya yazar: `fallback:<sınıf>` imzalı auto kayıtlar üretilir
  ve mevcut eşik/sinyal mantığıyla derse dönüşür. Yeni bir kayıt türü icat etme —
  `Memory.capture()`'ı yeniden kullan.
- `.opencode/memory/` depoya girmez; her klon sıfır hafızayla başlar.

## Durum

Bitirdiğinde şunları raporla: hangi katmana dokundun, tip kontrolü ve test geçti mi,
canlı davranışı nasıl doğruladın. "Muhtemelen çalışır" kabul edilmez.
