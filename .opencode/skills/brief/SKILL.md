---
name: Görev Brifingi
description: Ham istekten net, sınırlandırılmış ve kabul edilebilir bir görev brifingine geçer. Belirsizliği azaltır, kapsamı sabitler, kabul kriteri üretir. Yeni bir görev alındığında veya brifing netleşmediğinde kullan.
---

# Görev Brifingi

Orchestra'da iş, brifingden başlar. Brifing yanlışsa, bölünen her paket yanlış olur.

## Çıktı şekli

```
## Hedef
<tek cümle, eylem cümlesi>

## Kabul kriterleri
- <gözlemlenebilir çıktı 1>
- <gözlemlenebilir çıktı 2>

## Kapsam dışı
- <bilerek yapılmayacak şey>

## Kısıtlar
- <teknik, yasal, araç, süre kısıtları>

## Bilinmeyenler
- <belirsiz olan ve nasıl çözüleceği>

## Risk
- <yanlış giderse ne olur, geri dönüş maliyeti>
```

## Kurallar

**Kabul kriteri gözlemlenebilir olmalı.** "Çalışıyor" kriter değildir; "`pnpm test` yeşil ve
`/api/health` 200 dönüyor" kriterdir. Doğrulanamayan kriter, kriter değildir.

**Kapsam dışını yaz.** "Yalnızca şu dosyayı düzelt" cümlesi, en pahalı kelimedir ama en çok
koruyan ifadedir. Kapsam dışı yazmazsan alt ajanlar genişler ve iş kayar.

**Belirsizliği azalt, yok etme.** Üç şeyi dene: (a) güvenli varsayılanı seç ve yaz, (b) ucuz
olanı yap, (c) araştır. Ancak **geri dönüşü pahalı** veya **dışarıya etkili** işlerde (üretim
dağıtımı, veri silme, sözleşmeye bağlı değişiklik, gizli dosya) dur ve `question` ile sor.

**Tek seferde sor.** Beş ayrı soru, kullanıcıya beş tur kaybettirir. Soruları tek `question`
çağrısında topla; cevaplanmayanları varsayılanla kapat ve varsayımanı yaz.

**Yazılı varsayım her zaman geçerlidir.** Varsaydığın bir şey işi şekillendirdiyse, sonuçta
"şunu varsaydım" olarak yaz. Sessiz varsayım, en pahalı hatadır.

## Alışılmış hata kalıpları

- "Refactor et" → Neyi değiştirdiğinde anlaşılır kıl? Kabul kriteri nedir?
- "Daha hızlı yap" → Hangi işlem, hangi girdiyle, ne kadar hızlı olmalı?
- "Düzelt" → Neyin bozuk olduğunu nasıl kanıtlayacağız?
- "İyileştir" → İyileşmenin ölçülmesi nedir? Ölçü yoksa kriter yoktur.

## Son kontrol

Paket üretmeye geçmeden önce kendine sor:

1. Bitti dediğimde neye bakarak "bitti" derim?
2. Hangi dosyalara dokunulmayacak?
3. Yanlış anladıysam en pahalı hata hangisi?
4. Hangi tek soru, bu belirsizliğin çoğunu siler?

Dördü de cevaplanmıyorsa brifing eksiktir.
