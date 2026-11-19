# <PROJE ADI>

<tek cümlelik amaç>

Bu depo, [opencode project boilerplate](docs/BOILERPLATE.md) ile kuruldu: mimar-merkezli
orkestrasyon, paralel rol dağıtımı, kanıt zorunluluğu ve hatalardan öğrenen hafıza.
Kurulum, doğrulama ve güncelleme adımları → [`docs/BOILERPLATE.md`](docs/BOILERPLATE.md).

## Progress-driven orchestration

Orchestra continues while acceptance work can advance, learns from failures, and blocks work when its obstacle cannot be resolved. See [durable progress and three-attempt blocking](docs/PROGRESS-ORCHESTRATION.md) and [routing, safe shared updates and verification](docs/ORCHESTRATION-HARDENING.md).
