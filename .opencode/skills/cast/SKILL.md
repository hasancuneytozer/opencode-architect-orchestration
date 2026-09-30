---
name: Kadro Yönetimi
description: Gerektiğinde rollere yetenek ekler, roller ekler veya çıkarır; beceri (skill) ve komut katmanlarını yönetir. "Bunu kim yapsın?", "yeni rol lazım", "bu rolü kapat" gibi durumlarda kullan.
---

# Kadro Yönetimi

Kadro sabit değildir. Göreve göre büyür, küçülür. Rol dosyası kopyalanarak türetilir; yeni rol
icat etmeye gerek yoktur.

## Karar ağacı

```
Yetenek eksik mi?
├─ Hayır → mevcut rolü kullan
└─ Evet
   ├─ Mevcut bir role birkaç araç/izin yetiyorsa → rolün yeteneğini genişlet (yetki ekle)
   ├─ Alan başka bir alan mı? (örn. bu projede video, Blender, SEO, hukuk)
   │   └─ Yeni alan rolü ekle
   └─ Sadece araç mı eksik? → MCP/izin ekle, rol değiştirme
```

**Kural:** Yeni rol eklemeden önce mevcut bir rolün genişletilip genişletilemeyeceğine bak.
Dokuz sabit rol + yirmi geçici rol, dokuz role geri dönmenin kötüsüdür.

## Mevcut rolün yeteneğini genişlet

`.opencode/agents/crew/<rol>.md` dosyasını düzenle:

- **Araç erişimi:** `permissions` listesine ekle (örn. `edit` izni, `webfetch` izni).
- **Uzmanlık:** Dosyanın gövdesine o işin kurallarını yaz.
- **Model:** `model:` satırını değiştir (kalabalık ve sık işler için hızlı/ucuz, muhakeme
  gerektirenler için güçlü model).

Değişiklik anında geçerlidir; opencode yapılandırma dizinini izler.

## Yeni alan rolü ekle

Mevcut bir role en yakın dosyayı kopyala, sonra düzenle:

```
.opencode/agents/crew/<yeni-rol>.md
```

Zorunlu alanlar:

```yaml
---
description: <tek cümle; model bu satırdan hangi rolü seçeceğine karar verir>
mode: subagent
model: <provider/model>
permissions:
  - action: edit
    resource: "*"
    effect: deny     # salt-okunur rol ise ilk kural bu olmalı
---
```

Gövdede şu dört bölüm olsun:
1. **Kurallar** — bu rolün ihlal etmeyeceği çizgi.
2. **Yöntem** — işi nasıl yaptığını adım adım.
3. **Yasaklar** — sık yapılan hatalar.
4. **Ne döneceksin** — çıktı şekli. Bu bölüm olmadan rolün çıktısı denetlenemez.

Rol adlandırma: alan adı, kişi adı değil. `crew/blender-artist`, `crew/video-editor`,
`crew/seo` iyi; `crew/ahmet` kötü. Ad alanını belirtir, kişiyi değil.

## Rolü çıkar

Dosyayı sil veya `opencode.jsonc` içinde kapat:

```jsonc
"agents": {
  "crew/seo": { "disabled": true }
}
```

Geçici bir ihtiyaç için rol açıp kapatmak yerine, tek seferlik işlerde doğrudan
`crew/general` ya da `general` kullan. Her rol, her oturumda model seçimine girer; fazlası gürültüdür.

## Beceri (skill) yönetimi

Beceri = tekrar eden bir iş kalıbı için talimat.

| Eylem | Yol |
| --- | --- |
| Ekle | `.opencode/skills/<id>/SKILL.md` |
| Var olanı güncelle | Aynı dosyayı düzenle (yenisi yüklemeden önce değiştirilir) |
| Kaldır | Dosyayı sil |

Beceri kimliği dosya yolundan türetilir: `.opencode/skills/dispatch/SKILL.md` → `dispatch`.
Aynı isimde iki beceri olursa, daha yakın dizindeki kazanır.

Ne zaman beceri yaz:
- Aynı iş kalıbını üçüncü kez yapıyorsan.
- Bir adımın sırası veya kuralları hatırlanmıyorsa.
- Bir hata, "yapılacaklar listesi" olmadan önlenmiyorsa.

Beceri yazma:
- Tek kullanımlık iş için (görev brifingi o işte yeter).
- Agent zaten güvenilir yaptığın şeyi tarif ediyorsa (beceri bakımı pahalıdır).

## Komut yönetimi

`.opencode/commands/<ad>.md` → `/<ad>`. Komut, "şu metni bu rolle şu modelle çalıştır" kısayoludur.
`$ARGUMENTS` kullanıcının girdisidir.

Sık kullanılan, tekrar eden, parametreli işler için komut yaz. Tek kullanımlık işler için yazma.

## Son kontrol

Kadro değişikliğinden sonra:

1. Rol dosyasının `description` alanı, modelin onu doğru seçebileceği kadar ayırt edici mi?
2. Salt-okunur rolün `edit` izni gerçekten kapalı mı?
3. Yeni rolün "Ne döneceksin" bölümü var mı?
4. Model ataması, rolün ihtiyaç duyduğu düşünce derinliğine uygun mu?
5. Bu değişiklik gerçekten gerekli miydi, mevcut rol yetiyor muydu?
