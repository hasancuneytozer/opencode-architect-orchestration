import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // ffmpeg ile video üreten `beforeAll`/`beforeEach` blokları CPU'a bağlı.
    // Varsayılan 30 sn, 44 dosya paralel koşarken (ya da `npm run dev` açıkken)
    // bu bloklarda aşılıyor ve "Hook timed out" hataları kod hatası gibi
    // görünüyordu. Ölçüldü: paralel koşuda 6 test düşüyor, aynı kod seri
    // koşuda 1611/1611 geçiyor. Süre, işin gerçek maliyetini yansıtacak şekilde.
    hookTimeout: 120_000,
    pool: "forks",
    // Aynı sebeple dosyalar aynı anda koşmasın: her biri kendi geçici
    // dizininde ffmpeg çalıştırıyor, paralellik diski ve CPU'yu tıkar.
    // `npm test` güvenilir bir kapı olmalı; ara sıra kırmızı vermemeli.
    fileParallelism: false,
  },
});
