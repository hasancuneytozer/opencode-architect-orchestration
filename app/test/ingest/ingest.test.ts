/**
 * INGEST TESTLERİ — `IngestService` doğrudan, HTTP üzerinden değil.
 *
 * Neden ayrı dosya ve neden doğrudan servis: ingest'in kararları
 * (varlık mı içerik mi, kuyruğa giriyor mu, bulgu var mı) HTTP zarfından
 * bağımsızdır. `server.inject()` üzerinden gitmek her test için sunucu kurmak
 * demek; gerekçeleri de zarf içinde kaybolur. Burada `harness.ingest` çağrılır,
 * sonuç (`IngestResult`) doğrudan okunur.
 *
 * KURULUM `test/http/helpers.ts`'in ORTAK harness'idir — burada ikinci bir
 * kurulum yazılmaz. Aynı üç kural geçerli:
 *   1. Depo ve ffmpeg GERÇEK. "Doğrulama gerçekten ölçtü mü" sorusu sahte
 *      `MediaInfo` ile yanıtlanamaz; `testsrc` ile üretilmiş gerçek MP4'ler
 *      ffprobe'dan geçer.
 *   2. `MutableClock` ile saat enjekte edilir.
 *   3. Her test kendi geçici dizinini açar ve siler.
 *
 * ÜRETİMDE OLMASI GEREKEN, BURADA ZORUNLU OLAN İKİ KURAL:
 *   * HESAP KAYDI TEK BAŞINA YETMEZ — `credentials` kaydı da gerekir
 *     (`seedAccount` ikisini birlikte açar, bkz. `helpers.ts`).
 *   * Varlığın ÖLÇÜLERİ KALICI yazılmalıdır; `assets.info_json` dolmazsa
 *     yayın ön kontrolü `media_rejected` verir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_INGEST_BYTES,
  PRODUCT_ASPECT_CODE,
  IngestSourceError,
  IngestValidationError,
  storageKeyFor,
  type IngestResult,
} from "../../src/ingest/index.js";
import type { IngestRequest, Platform } from "../../src/contract/index.js";
import { createHarness, makeVideo, seedAccount, type Harness } from "../http/helpers.js";

let h: Harness;
let videoDir: string;

beforeEach(async () => {
  h = await createHarness();
  videoDir = mkdtempSync(join(tmpdir(), "sp-ingest-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  rmSync(videoDir, { recursive: true, force: true });
  await h.close();
});

/** Sözleşmenin zorunlu alanları. `autoSchedule` varsayılanı testte `true`'dur;
 * onay kapısı kendi testinde açıkça `false` verilir. */
function req(over: Partial<IngestRequest> = {}): IngestRequest {
  return {
    project: "test-projesi",
    platforms: ["instagram"] as Platform[],
    timezone: "Europe/Istanbul",
    tags: [],
    metadata: {},
    autoSchedule: true,
    ...over,
  };
}

/**
 * `fetch` sahtesi: gövdeyi `Response` olarak döndürür.
 *
 * Gövde `Uint8Array` olarak verilir: `Buffer` tip düzeyinde `BodyInit`
 * birliğine girmiyor, ama `new Uint8Array(buffer)` aynı baytlarla geçer ve
 * `ingest.ts`'in beklediği web `ReadableStream`'i üretir.
 */
function stubFetch(body: Buffer | string, init: { status?: number; contentLength?: number } = {}): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    seen.push(String(input));
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const headers: Record<string, string> = {};
    const declared = init.contentLength ?? bytes.length;
    headers["content-length"] = String(declared);
    return new Response(new Uint8Array(bytes), { status: init.status ?? 200, headers });
  });
  return seen;
}

function ingestOf(p: Promise<IngestResult>): Promise<IngestResult> {
  return p;
}

// ── 1. Kaynak türleri ──────────────────────────────────────────────────────

describe("kaynak türleri", () => {
  it("buffer kaynağı → varlık + içerik oluşur", async () => {
    const video = makeVideo(videoDir, "buffer.mp4");
    const body = readFileSync(video);

    const result = await h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "buffer",
      body,
      fileName: "klip.mp4",
    });

    expect(result.assetId).toBeTruthy();
    expect(result.contentId).toBeTruthy();
    expect(result.state).toBe("ready");
    expect(h.repos.contents.getById(result.contentId)?.assetId).toBe(result.assetId);
  });

  it("path kaynağı → varlık + içerik oluşur", async () => {
    const video = makeVideo(videoDir, "path.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: video });

    expect(result.state).toBe("ready");
    const asset = h.repos.assets.getById(result.assetId);
    expect(asset?.storageKey).toContain("uploads/");
    expect(asset?.originalName).toBe("path.mp4");
  });

  // Regresyon: `IngestRequestSchema`'nın "tam olarak biri zorunlu" refine'i
  // multipart/buffer beslemesinde gövdede kaynak alanı olmadığı için HEP
  // tetikleniyor ve geçerli bir yükleme 400 ile reddediliyordu. Kaynak kuralı
  // artık `source.kind`e göre kod içinde uygulanıyor.
  it("buffer kaynağı: gövdede kaynak alanı YOKKEN de kabul edilir", async () => {
    const video = makeVideo(videoDir, "buffer-alansiz.mp4");
    expect((req({ autoSchedule: false }) as Record<string, unknown>)["sourcePath"]).toBeUndefined();

    const result = await h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "buffer",
      body: readFileSync(video),
      fileName: "klip.mp4",
    });

    expect(result.state).toBe("ready");
    expect(h.repos.assets.getById(result.assetId)?.bytes).toBeGreaterThan(0);
  });

  it("url kaynağı (sahte fetch) → varlık + içerik oluşur", async () => {
    const video = makeVideo(videoDir, "url-kaynak.mp4");
    const seen = stubFetch(readFileSync(video));
    const result = await h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "url",
      url: "https://cdn.example.com/klip/uzak.mp4",
    });

    expect(seen).toEqual(["https://cdn.example.com/klip/uzak.mp4"]);
    expect(result.state).toBe("ready");
    const asset = h.repos.assets.getById(result.assetId);
    // Uzantı ALDI'dAN gelir, gövdeden değil: sahte gövde MP4 olsa bile
    // ad `.bin` ise anahtar `.bin` olur (tanımlı davranış).
    expect(asset?.storageKey.endsWith(".mp4")).toBe(true);
  });
});

// ── 2. "Aynı içerik = aynı varlık" kuralı ─────────────────────────────────

describe("tek varlık kuralı", () => {
  it("aynı dosya iki kez → TEK varlık, İKİ içerik", async () => {
    const video = makeVideo(videoDir, "ayni.mp4");
    const first = await ingestOf(h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: video }));
    const second = await ingestOf(h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: video }));

    expect(second.assetId).toBe(first.assetId);
    expect(second.contentId).not.toBe(first.contentId);
    expect(h.repos.assets.listFiltered({ limit: 100 }).length).toBe(1);
  });

  it("storageKey içerik adreslidir: aynı bayt → aynı anahtar, farklı ad yok", () => {
    const a = storageKeyFor(Buffer.from("ayni-icerik"), "bir.mp4");
    const b = storageKeyFor(Buffer.from("ayni-icerik"), "iki.mp4");
    const c = storageKeyFor(Buffer.from("farkli-icerik"), "bir.mp4");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Dosya adı DIŞINDA hiçbir şey anahtara girmez: `../../.env` geçemez.
    expect(a.endsWith("/dosya.mp4")).toBe(true);
  });
});

// ── 3. Onay kapısı ve kuyruk ────────────────────────────────────────────────

describe("onay ve kuyruk", () => {
  it("autoSchedule=false → HİÇ iş yok, requiresApproval açıkça true", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "onay-bekliyor.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: video });

    expect(result.requiresApproval).toBe(true);
    expect(result.jobIds).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("onay bekliyor");
    expect(h.repos.jobs.listByContent(result.contentId)).toEqual([]);
  });

  it("autoSchedule=true + aktif hesap → iş queued", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "kuyruga.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });

    expect(result.requiresApproval).toBe(false);
    expect(result.jobIds).toHaveLength(1);
    const job = h.repos.jobs.getById(result.jobIds[0] ?? "");
    expect(job?.state).toBe("queued");
    expect(job?.idempotencyKey).toMatch(/^ingest:/);
    expect(h.repos.contents.getById(result.contentId)?.state).toBe("scheduled");
  });

  it("hesap yok → iş yok, gerekçe boş DEĞİL", async () => {
    const video = makeVideo(videoDir, "hesapsiz.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });

    expect(result.jobIds).toEqual([]);
    expect(result.skipped[0]?.platform).toBe("instagram");
    expect(result.skipped[0]?.reason).toContain("hesap yok");
  });

  it("kuyruktaki iş zamanlayıcıyla GERÇEKTEN yayınlanır", async () => {
    // Uçtan uca kanıt: ingest → kuyruk → motor → sahte adaptör. Burada
    // `credentials` kaydı olmazsa iş `credential_missing` ile kuyrukta kalır
    // ve test "yayınlandı" yerine "kaldı" görür — sessiz bir sahte yeşil.
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "uygulama-sonu.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });
    expect(result.jobIds).toHaveLength(1);

    const tick = await h.schedulerCore?.runOnce();
    expect(tick?.published).toBe(1);
    expect(tick?.failed ?? 0).toBe(0);

    const job = h.repos.jobs.getById(result.jobIds[0] ?? "");
    expect(job?.state).toBe("published");
    expect(job?.permalink).toBeTruthy();
    expect(h.repos.contents.getById(result.contentId)?.state).toBe("published");
  });
});

// ── 4. Kapı: bulgular ──────────────────────────────────────────────────────

describe("doğrulama kapısı", () => {
  it("1 saniyelik video → duration_min hatası → taslak, kuyruk yok", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "cok-kisa.mp4", { seconds: 1 });
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });

    const finding = result.findings.find((f) => f.code === "duration_min");
    expect(finding?.severity).toBe("error");
    expect(result.state).toBe("draft");
    expect(result.jobIds).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("Medya doğrulaması");
  });

  it("yatay video → product_aspect_9_16 → taslak; mesaj iki yarımı da söyler", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "yatay-kapi.mp4", { width: 1920, height: 1080 });
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });

    const product = result.findings.find((f) => f.code === PRODUCT_ASPECT_CODE);
    expect(product?.severity).toBe("error");
    expect(product?.provisional).toBe(false);
    // Dürüstlük: mesaj hem platformun tutumunu hem bizinkini söyler.
    expect(String(product?.message)).toContain("platform kabul eder");
    expect(String(product?.message)).toContain("bu uygulama kabul etmiyor");

    expect(result.state).toBe("draft");
    expect(result.jobIds).toEqual([]);
    // Platform kuralı da AYNI anda kendi uyarısını üretir (katmanlar birleşik).
    expect(result.findings.some((f) => f.code === "aspect_ratio")).toBe(true);
  });

  it("9:16 dikey video → hazır ve ürün kuralı yok", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey-hazir.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: true }), { kind: "path", path: video });

    expect(result.findings.some((f) => f.code === PRODUCT_ASPECT_CODE)).toBe(false);
    expect(result.state).toBe("ready");
    expect(result.jobIds).toHaveLength(1);
  });

  it("probe ölçüleri varlık kaydına YAZILIR", async () => {
    // Regresyon: ölçüler yalnız bellekte kalırsa yayın ön kontrolü
    // `media_rejected` ile düşer ve HİÇBİR ŞEY yayınlanamaz.
    const video = makeVideo(videoDir, "olculer.mp4");
    const result = await h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: video });
    const asset = h.repos.assets.getById(result.assetId);

    expect(asset?.info.width).toBe(1080);
    expect(asset?.info.height).toBe(1920);
    expect(asset?.info.videoCodec).toBe("h264");
    expect(asset?.info.hasAudio).toBe(true);
    expect(asset?.info.durationSec).toBeGreaterThan(3);
  });
});

// ── 5. Kaynak reddi (güvenlik) ─────────────────────────────────────────────

describe("kaynak reddi", () => {
  // ── Katman 1: SÖZLEŞME. `SourcePathSchema` ham dizgede `..`/`~`/baştaki `.`
  // reddeder. Burada Düz yol yazılır: `join()` `..`'yi normalize edip düz yola
  // çevirdiği için önceki sürüm bu kuralı HİÇ TETİKLEMEDİ ve test yanlış
  // hatayı (IngestSourceError) bekliyordu.
  it("sourcePath içinde gezinme (..) → IngestValidationError (sözleşme katmanı)", async () => {
    await expect(
      h.ingest.ingest(req({ autoSchedule: false }), {
        kind: "path",
        path: "../../../gizli.env",
      }),
    ).rejects.toBeInstanceOf(IngestValidationError);
    // Dosya HİÇ OKUNMAZ: varlık ve içerik yok.
    expect(h.repos.assets.listFiltered({ limit: 100 })).toEqual([]);
    expect(h.repos.contents.listFiltered({ limit: 100 })).toEqual([]);
  });

  // ── Katman 2: `fs.realpath` ÇÖZÜMLEMESİ. `join()` burada bilinçli: yol
  // NORMALİZE EDİLMİŞ ve kök dışına çıkıyor, yani `..` dizgeleri kalmıyor ve
  // sözleşme katmanı GEÇER; reddeden tek yer çözümlenmiş yoldur.
  it("normalize edilmiş ama kök dışına çıkan yol → kaynak okunamadı (IngestSourceError)", async () => {
    const disarida = join(tmpdir(), "..", "..", "gizli.env");
    expect(disarida).not.toContain("..");
    await expect(
      h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: disarida }),
    ).rejects.toBeInstanceOf(IngestSourceError);
    expect(h.repos.assets.listFiltered({ limit: 100 })).toEqual([]);
  });

  it("var olmayan dosya → IngestSourceError (IngestValidationError DEĞİL)", async () => {
    const promise = h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "path",
      path: join(videoDir, "yok-boyle-bir-dosya.mp4"),
    });
    await expect(promise).rejects.toBeInstanceOf(IngestSourceError);
    await expect(promise).rejects.not.toBeInstanceOf(IngestValidationError);
  });

  it("kind:buffer iken gövdede sourcePath → IngestValidationError (sessizce yutulmaz)", async () => {
    // Karar ve gerekçe `IngestService.validate` yorumunda. Özet: akış kaynağı
    // esas olsa da gövdenin kaynak iddiası sessizce yutulmaz; çağıran "yol
    // okundu" sanıp bellekteki başka baytları yutmuş olur.
    const video = makeVideo(videoDir, "buffer-cipli.mp4");
    const promise = h.ingest.ingest(req({ autoSchedule: false, sourcePath: "/baska/yer.mp4" }), {
      kind: "buffer",
      body: readFileSync(video),
      fileName: "klip.mp4",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestValidationError);
    await expect(promise).rejects.toThrow(/buffer/);
    expect(h.repos.assets.listFiltered({ limit: 100 })).toEqual([]);
  });

  it("path kaynağı iken gövdede sourceUrl → IngestValidationError (çelişki)", async () => {
    const video = makeVideo(videoDir, "celiski.mp4");
    const promise = h.ingest.ingest(
      req({ autoSchedule: false, sourceUrl: "https://cdn.example.com/a.mp4" }),
      { kind: "path", path: video },
    );
    await expect(promise).rejects.toBeInstanceOf(IngestValidationError);
    await expect(promise).rejects.toThrow(/Çelişkili kaynak/);
  });

  it("url kaynağı iken gövdede sourcePath → IngestValidationError (çelişki)", async () => {
    const fetchSeen = stubFetch(Buffer.from("x"));
    const promise = h.ingest.ingest(req({ autoSchedule: false, sourcePath: "/baska/yer.mp4" }), {
      kind: "url",
      url: "https://cdn.example.com/klip.mp4",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestValidationError);
    // Çelişki İNDİRME ÖNCESİ yakalanır: ağa çıkılmaz.
    expect(fetchSeen).toEqual([]);
  });

  it("sourceUrl özel IP adresi → IngestValidationError (SSRF kapısı)", async () => {
    const fetchSeen = stubFetch(Buffer.from("x"));
    const promise = h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "url",
      url: "http://192.168.1.20/klip.mp4",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestValidationError);
    // Reddedilen adres için AĞA ÇIKILMAZ: SSRF kapısı indirmeden önce çalışır.
    expect(fetchSeen).toEqual([]);
  });

  it("sourceUrl localhost → IngestValidationError", async () => {
    const promise = h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "url",
      url: "http://localhost:4317/api/health",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestValidationError);
  });

  it("sourceUrl HTTP 404 → IngestSourceError", async () => {
    stubFetch("yok", { status: 404 });
    const promise = h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "url",
      url: "https://cdn.example.com/yok.mp4",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestSourceError);
    await expect(promise).rejects.toThrow(/HTTP 404/);
  });

  it("MAX_INGEST_BYTES aşımı (yerel dosya) → IngestSourceError", async () => {
    // Seyrek (sparse) dosya: mantıksal boyut 4 GB'ı aşar ama diskte bir şey
    // kaplamaz. `stat().size` sınırı aştığı için içerik OKUNMAZ.
    const big = join(videoDir, "dev.mp4");
    writeFileSync(big, "x");
    truncateSync(big, MAX_INGEST_BYTES + 1);

    const promise = h.ingest.ingest(req({ autoSchedule: false }), { kind: "path", path: big });
    await expect(promise).rejects.toBeInstanceOf(IngestSourceError);
    await expect(promise).rejects.toThrow(new RegExp(String(MAX_INGEST_BYTES)));
    expect(h.repos.assets.listFiltered({ limit: 100 })).toEqual([]);
  });

  it("MAX_INGEST_BYTES aşımı (bildirilen content-length) → IngestSourceError", async () => {
    stubFetch(Buffer.from("kucuk"), { contentLength: MAX_INGEST_BYTES + 1 });
    const promise = h.ingest.ingest(req({ autoSchedule: false }), {
      kind: "url",
      url: "https://cdn.example.com/dev.mp4",
    });
    await expect(promise).rejects.toBeInstanceOf(IngestSourceError);
    await expect(promise).rejects.toThrow(/çok büyük/);
  });
});