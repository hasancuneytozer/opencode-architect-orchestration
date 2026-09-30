---
name: Ders Çıkarma
description: Yaşanan bir hatayı veya keşfi kalıcı, uygulanabilir ve eşleştirilebilir bir derse dönüştürür. Hata tekrarlandığında sistemin kendiliğinden hatırlamasını sağlar. Her başarısızlıktan sonra ve teslimden önce kullan.
---

# Ders Çıkarma

Plugin araç hatalarını **yakalar**; bu beceri onları **öğretilebilir kurala** çevirir.
Farkı anla: yakalanan hata olaydır, ders kuraldır.

## Ne zaman ders yazarsın

Yaz:
- Aynı hatayı ikinci kez yapıyorsan.
- Bir aracın beklenmedik davrandığını öğrendiysen (doğru kullanımını buldunysan).
- Bir alışkanlığın seni bir kez yakaladıysa ("önce dosyayı oku").
- Uzun bir işi bitirmek için bilinmeyen bir incelik gerektiyse.

**Yazma:**
- Tek seferlik, bağlama özgü hatalarda (sözdizimi hatası, yanlış dosya adı).
- Sadece bir kez oluşmuş ve tekrarlanmayan gürültülerde.
- Kendinden emin olmadığın çıkarımlarda — hafızayı zehirlemek, hiçbir şey yazmamaktan kötüdür.

## Dersin anatomisi

```
Kural:    <gelecekte neyi nasıl yapacağız>
Gerekçe:  <hangi hataya yol açtı, hangi koşulda geçerli>
Etiketler: <araç adı, teknoloji, komut — doğru hataya eşleşsin>
```

## İyi ve kötü ders

| Kötü | Neden | Daha iyi |
| --- | --- | --- |
| "Dikkatli ol." | Uygulanamaz | "Değiştirmeden önce dosyayı oku; satır numarası tahmin etme." |
| "Hata yaptın." | Olay, kural değil | "Windows'ta yol ayırıcı `\`; JSON içinde `/` kullan." |
| "Testleri çalıştır." | Zaten söylenen | "`pnpm test`; `npm test` bu depoda yok, `package.json` scripts'e bak." |
| "MCP dokümantasyonuna bak." | Neyi arayacağını söylemiyor | "`blender_*` araçları `execute_blender_code` sonrası çağrılmalı." |

Bir dersi yazdıktan sonra kendine sor: **gelecekte aynı durumda bu kural bana ne yapma fırsatı
veriyor?** Fırsat vermiyorsa, ders değil laf.

## Otomatik yakalanmış bir hatayı derse çevirme

Sistem `<orchestra-memory>` bloğunda tekrar eden ama henüz derse dönüşmemiş hataları "SİNYAL"
olarak gösterir. Dönüştürmek için `id`'yi ya da `signature`'ı kullan:

```
orchestra_lesson({
  title: "Windows yol ayırıcı JSON'da kaçış gerektirir",
  rule: "JSON kaynak dosyalarında yol ayırıcı olarak / kullan; ters eğik çubuğ kaçır.",
  body: "shell komutunda \\ kayıpsız ama JSON'da kaçış karakteri sayılıyor.",
  tags: ["json", "windows", "yol"],
  promote: "L-0042"
})
```

`promote`, o ham kaydı dersin **kaynağı** yapar; hem kayıt hem ders kalır, geçmişi kaybolmaz.

## Düşman: hafıza zehirlenmesi

Hafıza biriktikçe yanlış dersler de birikir. Bu yüzden:

- Geçersiz kılacağın bir ders varsa üstüne yazma: `supersedes` kullan ya da
  `orchestra_forget` ile emekliye ayır.
- Bir dersi emekliye ayırırken nedenini yaz.
- İki ders çelişiyorsa ikisini de bırakma; birini emekliye ayır.

## Toplu bakım

Döngü sonlarında `crew/curator` çağır: bekleyen sinyalleri derse çevirir, bayat ve çelişen
dersleri temizler. Her turun sonunda kendi hatanı da dönüştürmeyi unutma.
