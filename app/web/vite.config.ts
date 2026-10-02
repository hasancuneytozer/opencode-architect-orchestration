/**
 * Arayüzün derleme/geliştirme ayarları.
 *
 * `npm run dev:web` komutu bu dosyayı kullanır: `vite --config web/vite.config.ts`.
 * Komut `app/` kökünden çalıştığı için Vite'in varsayılan `root` değeri (`process.cwd()`)
 * YANLIŞ olurdu — `index.html` `app/` altında aranır ve bulunamazdı. Bu yüzden
 * `root` burada `web/` olarak sabitleniyor.
 *
 * API istekleri tarayıcıdan `/api/...` adresine gider ve proxy ile yerel sunucuya
 * iletilir; böylece tarayıcı tarafında CORS'a dokunulmaz ve oturum çerezi
 * aynı kaynak (same-origin) sayılır.
 */
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Sunucu tarafından da servis edilebilsin: göreli yol.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5178,
    strictPort: false,
    /**
     * IPv4 döngüsüne açıkça bağlan.
     *
     * Varsayılan davranış `localhost`'i çözer ve çoğu Windows kurulumunda
     * yalnız IPv6 `::1` üzerinde dinler. O zaman tarayıcıya `127.0.0.1:5178`
     * yazılırsa "bağlanılamıyor" hatası alınır — API ise `127.0.0.1:4317`'de
     * dinliyor ve iki adres birbirini tutmuyor. `host` burada sabitlenerek
     * ikisi de aynı, tahmin edilebilir adresi kullanır.
     */
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  css: {
    /**
     * PostCSS yapılandırma dosyası ARANMAZ (satır içi nesne → arama kapalı).
     *
     * Neden: Tailwind v4 `@tailwindcss/vite` eklentisi olarak çalışır, postcss
     * yapılandırmasına ihtiyaç duymaz. Oysa varsayılan davranış config'i `web/`
     *den yukarı doğru arıyor ve `app/package.json`'a ulaşıyor. O dosya UTF-8 BOM
     * ile başladığı için `JSON.parse` patlıyor ve derleme CSS'i işlemeden
     * ölüyordu. BOM'a (`app/package.json` KORUMALI) dokunmadan buradan çözülüyor.
     */
    postcss: {},
  },
});