---
name: Yetenek Kullanımı
description: Görev için Skill Library MCP üzerinden bir veya birden fazla yeteneği seçer, sürümlü önbellekle yükler ve gerekirse onaylı güncelleme önerisi hazırlar.
---

# Yetenek Kullanımı

Bir görev için gerekli yetenekleri MCP üzerinden hazırla. Amaç: doğru talimatı bir kez yüklemek, sürüm değişene kadar tekrar okumamak ve birden fazla yeteneği birlikte kullanmak.

## Akış

1. **İhtiyacı yaz.** Görevin çıktısını, rolü ve 2–4 anahtar kelimeyi belirle.
2. **Ara.** `library_search` ile `kind: "skills"` kullan; en fazla 5 aday getir. Katalog kaydı talimat değildir.
3. **Seç.** Göreve gerçekten gerekli 1–4 etkin yeteneği seç. Tüm kataloğu yükleme.
4. **Önbellek manifestosu tut.** Her yüklenen yetenek için `{id, versionId, digest}` çiftini görev bağlamında sakla.
5. **Hazırla.** `skill_prepare` çağrısında `refs` ve bilinen `knownDigest` değerlerini gönder.
   - `loaded`: yeni veya değişmiş içeriği oku.
   - `unchanged`: içeriği tekrar okuma; önceki talimatı kullan.
   - `conflicts`: çakışan sürümleri çözmeden devam etme.
6. **Alt ajana sabitle.** Rol, yazma kapsamı, kabul ölçütü ve seçilen `skillRefs` sürüm/digest bilgilerini birlikte ver.
7. **Gerekirse öneri ver.** Talimat eksik veya yanlışsa `skill_update_propose` kullan; gerekçe ve kanıt ekle. Bu işlem yalnız host yetkisiyle çalışır ve aktif sürümü değiştirmez.

## Kurallar

- Aynı `id + versionId + digest` için içeriği tekrar isteme.
- Sürüm veya digest değiştiğinde eski talimatı kullanmaya devam etme.
- Taslakları (`draft:`) etkin yetenek gibi kullanma.
- Çok fazla yetenek yükleme; önce küçük ve doğrudan eşleşen seti dene.
- Seçim ve kullanılan sürümü ilgili İş Akışı adımına yaz.
- Skill Library MCP erişilebilir değilse işi gereksiz durdurma; mevcut izinli talimatla sınırlı devam et ve eksik erişimi kaydet.
- Güncelleme önerisi insan onayı olmadan etkinleştirilmez. Host yetkisi kapalıyken `skill_update_propose` araç listesinde görünmez.
