---
description: Mevcut sistemin bileşenlerini, ilişkilerini ve veri akışını teknik diyagram olarak göster
agent: architect
subagent: false
---

`/diagram` — Mevcut isteğin teknik yapısını görselleştir.

Son kullanıcı isteğini esas al ve şu yapıda göster:

1. **Sistem sınırı** — hangi bölüm inceleniyor?
2. **Bileşenler** — frontend, backend, database, AI, storage, API ve ilgili modüller.
3. **Sorumluluklar** — her bileşenin görevi.
4. **İlişkiler** — hangi bileşen hangisiyle iletişim kuruyor?
5. **Veri akışı** — verinin başlangıçtan sona izlediği yol.
6. **Bağımlılıklar** — kritik bağlantılar ve dış servisler.
7. **Diagram** — mümkünse Mermaid `graph` veya uygun teknik diyagram kullan.
8. **Riskler** — coupling, bottleneck, gereksiz bağımlılık veya belirsiz sınırlar varsa belirt.

Kod implementasyonu yapma.
Gereksiz sınıf veya dosya seviyesine inme.
Önce yüksek seviyeli mimariyi göster.

Eksik bilgi varsa mevcut proje bağlamından makul varsayım yap ve belirt.