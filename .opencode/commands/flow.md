---
description: Mevcut özellik veya süreci adım adım kullanıcı ve sistem akışı olarak göster
agent: architect
subagent: false
---

`/flow` — Mevcut isteğin süreç akışını çıkar.

Son kullanıcı isteğini esas al ve şu yapıda göster:

1. **Amaç** — akışın başlangıç ve bitiş hedefi.
2. **Aktörler** — kullanıcı, sistem, AI, backend veya ilgili diğer aktörler.
3. **Ana akış** — başlangıçtan sonuca kadar sıralı adımlar.
4. **Karar noktaları** — koşullar ve farklı yollar.
5. **Alternatif akışlar** — ana yol dışında oluşabilecek senaryolar.
6. **Hata durumları** — başarısızlık halinde ne olur?
7. **Flow diagram** — mümkünse Mermaid `flowchart` kullan.

Akışı gereksiz teknik detayla doldurma.
Kod yazma.
Her adımın neden var olduğunu anlaşılır tut.

Eksik bilgi varsa durma; makul varsayım yap ve belirt.