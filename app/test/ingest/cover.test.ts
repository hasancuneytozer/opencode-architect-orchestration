/**
 * KAPAK ÜRETİMİ TESTLERİ — `src/ingest/cover.ts` + iki giriş noktası.
 *
 * ── BU DOSYA NEDEN VAR ──────────────────────────────────────────────────────
 * Kapak üretimi bir zamanlar yalnız `IngestService` yolunda çalışıyordu.
 * `POST /api/v1/assets` (panelde "dosyayı yükle, sonra içerik oluştur" akışı)
 * `uploadAsset`'ı `transcoder` VERMEDEN çağırıyordu; `AssetOnlyDeps.transcoder`
 * opsiyonel olduğu için derleme hatası vermiyor, varlık `coverKey: null` ile
 * oluşuyor ve `GET /api/v1/assets/:id/cover` 404 döndürüyordu. Panelin kütüphane
 * ızgarası ve platform kapak seçimi bu görüntüyü kullandığı için HER yükleme
 * kapaksız görünüyordu. Sessiz bir eksiğin KAPANDIĞINI yalnız bu test gösterir.
 *
 * ── KURULUM ────────────────────────────────────────────────────────────────
 * `test/http/helpers.ts`'in ORTAK harness'i: `FsMediaStore` ve ffmpeg GERÇEK
 * (`testsrc` ile üretilmiş gerçek MP4 → gerçek `ffprobe` → gerçek kare).
 * Sahte `MediaInfo` ile "kapak JPEG çıktı mı" sorusu yanıtlanamaz.
 *
 * ── BİR VİDEO, ALTI TEST (maliyet kuralı) ───────────────────────────────────
 * Video `beforeAll`'da BİR kez üretilir ve tüm testlerde paylaşılır.
 * `makeVideo` her çağrıda ffmpeg ile 1080×1920 bir MP4 kodlar (~3 sn) ve tam
 * koşuda altı kez yapmak vitest'in 30 sn'lik test bütçesini aşıyordu
 * (`test/media/validate.test.ts`nin `beforeAll`'ı da aynı yüzden zaman aşımına
 * uğruyordu). Çözünürlük bilerek DÜŞÜK seçildi: bu dosyada ölçülen şey
 * platform doğrulaması DEĞİL, ffmpeg'in gerçek bir dosyadan kare alıp JPEG
 * yazabilmesi. Her test kendi veritabanı ve depo dizinini alır (`beforeEach`),
 * bu yüzden video paylaşımı testler arası durum taşımaz.
 *
 * ── KAPAK ZORUNLU DEĞİLDİR (kilitlenen davranış) ────────────────────────────
 * Kapak bir TÜRETİLMİŞ görseldir; dosyanın kendisi kaybolmamalıdır. Bu yüzden
 * `grabCover` patladığında varlık YİNE oluşur, `coverKey` `null` kalır ve neden
 * DENETİME yazılır. Sessizce yutulan hata "kapak neden yok?" sorusunu
 * yanıtlanamaz hale getirirdi.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Asset } from "../../src/contract/index.js";
import { uploadAsset } from "../../src/ingest/index.js";
import { getSpec } from "../../src/media/index.js";
import type { Transcoder } from "../../src/ports/index.js";
import {
  createHarness,
  dataOf,
  makeVideo,
  multipartBody,
  type Harness,
} from "../http/helpers.js";

const PAROLA = "test-parola-1234";

/** Tüm testlerin ortak kaynağı (bkz. dosya başı). */
let videoPath = "";
let videoBody: Buffer = Buffer.alloc(0);

let h: Harness;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "sp-cover-"));
  videoPath = makeVideo(dir, "paylasim.mp4", { width: 360, height: 640, seconds: 3 });
  videoBody = readFileSync(videoPath);
  // `makeVideo` dosyayı bu dizine yazdı; dizini dosya yolundan türetiyoruz ki
  // `afterAll` onu silsin.
  videoPath = join(dir, "paylasim.mp4");
});

afterAll(() => {
  rmSync(join(videoPath, ".."), { recursive: true, force: true });
});

beforeEach(async () => {
  h = await createHarness({ adminPassword: PAROLA });
});

afterEach(async () => {
  await h.close();
});

/** JPEG SOI baytları: `FF D8` (start of image). */
function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Varlığın denetim izindeki olay adları (yeniden eskiye). */
function auditActions(assetId: string): string[] {
  return h.repos.audit.listForTarget("asset", assetId).map((r) => r.action);
}

/** `transcoder`'ı testte kıran ama arayüzü eksiksiz sahte. */
function brokenTranscoder(reason: string): Transcoder {
  return {
    grabCover: () => Promise.reject(new Error(reason)),
    toFeedReady: () => Promise.reject(new Error("bu testte toFeedReady çağrılmaz")),
  };
}

/** `uploadAsset` için gerçek bağımlılık paketi (tek yerden, sapma görünür). */
function deps(over: { transcoder?: Transcoder } = {}) {
  return {
    assets: h.repos.assets,
    store: h.store,
    probe: h.ffmpeg,
    audit: h.repos.audit,
    getSpec,
    ...(over.transcoder === undefined ? {} : { transcoder: over.transcoder }),
  };
}

// ── 1. DOĞRUDAN `uploadAsset` ──────────────────────────────────────────────

describe("uploadAsset — kapak üretimi", () => {
  it("coverKey DOLU gelir ve kapak dosyası depoda GERÇEKTEN var", async () => {
    const result = await uploadAsset(deps({ transcoder: h.ffmpeg }), {
      body: videoBody,
      fileName: "paylasim.mp4",
    });

    expect(result.reused).toBe(false);
    // Dönen nesne bayttan KOPYA olduğu için `asset.ts` kaydı yeniden okur;
    // HTTP gövdesi de aynı yüzden dolu `coverKey` görür.
    expect(result.asset.coverKey).toBeTruthy();
    const coverKey = String(result.asset.coverKey);
    expect(await h.store.exists(coverKey)).toBe(true);
    expect(coverKey.startsWith("covers/")).toBe(true);
    expect(coverKey.endsWith(".jpg")).toBe(true);
    // `assets.cover_key` SÜTUNU da yazıldı (yalnız dönen nesne değil).
    expect(h.repos.assets.getById(result.asset.id)?.coverKey).toBe(coverKey);
    expect(auditActions(result.asset.id)).toContain("asset.cover");
  });

  it("kapak dosyası JPEG sihirli baytlarıyla (FFD8) başlar", async () => {
    const result = await uploadAsset(deps({ transcoder: h.ffmpeg }), {
      body: videoBody,
      fileName: "paylasim.mp4",
    });

    const bytes = await h.store.read(String(result.asset.coverKey));
    expect(bytes.length).toBeGreaterThan(200);
    expect(isJpeg(bytes)).toBe(true);
    // Yalnız uzantıya güvenmiyoruz: içerik gerçekten JPEG (son baytlar FF D9).
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
  });

  it("grabCover PATLADIĞINDA varlık yine oluşur, coverKey null kalır, neden denetime yazılır", async () => {
    const result = await uploadAsset(
      deps({ transcoder: brokenTranscoder("ffmpeg kareyi alamadı (test)") }),
      { body: videoBody, fileName: "paylasim.mp4" },
    );

    // İş ÇÖKMEDİ: kapak türetilmiş bir görseldir, dosya kaybolmamalıdır.
    expect(result.asset.storageKey).toBeTruthy();
    expect(result.asset.coverKey).toBeNull();
    expect(h.repos.assets.getById(result.asset.id)).toBeTruthy();
    expect(await h.store.exists(result.asset.storageKey)).toBe(true);
    // Neden kayıp değil. Ad, `cover.ts`'in `actionBase + ".cover_failed"`
    // birleştirmesi nedeniyle `asset.cover.cover_failed`'dır (başarı olayı
    // düz `asset.cover`).
    const actions = auditActions(result.asset.id);
    expect(actions).toContain("asset.cover.cover_failed");
    expect(actions).toContain("asset.uploaded");
    const failed = h.repos.audit
      .listForTarget("asset", result.asset.id)
      .find((r) => r.action === "asset.cover.cover_failed");
    expect(String(failed?.detail["message"] ?? "")).toContain("ffmpeg kareyi alamadı");
  });

  it("transcoder HİÇ verilmezse kapak üretilmez ama cover_skipped denetimi yazılır", async () => {
    // `AssetOnlyDeps.transcoder` opsiyoneldir. Bu dal KORUNMAktadır: sunucu
    // beklenmedik biçimde kapak üretemiyorsa varlık yine de oluşur ama neden
    // denetimde görünür. Sesi bastırmak, "kapak neden yok?" sorusunu
    // yanıtlanamaz hale getirirdi.
    const result = await uploadAsset(deps(), { body: videoBody, fileName: "paylasim.mp4" });

    expect(result.asset.coverKey).toBeNull();
    expect(auditActions(result.asset.id)).toContain("asset.cover_skipped");
  });

  it("AYNI video iki kez yüklenince kapak anahtarı AYNI kalır (içerik adresli)", async () => {
    // Kapak anahtarı `sha256(kapak baytları)`'dır. Aynı dosya ikinci kez
    // yüklendiğinde ikinci bir kapak ÜRETİLMEZ, mevcut varlık döner; ıslak diskte
    // kopya kalmaz ve `coverKey` değişmez (aksi halde panel her yüklemede
    // yeni bir görsel adresi görürdü).
    const built = deps({ transcoder: h.ffmpeg });

    const first = await uploadAsset(built, { body: videoBody, fileName: "paylasim.mp4" });
    const second = await uploadAsset(built, { body: videoBody, fileName: "paylasim.mp4" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.asset.coverKey).toBe(first.asset.coverKey);
    expect(second.asset.coverKey).toBeTruthy();
  });
});

// ── 2. ÜRETİM YOLU: `POST /api/v1/assets` (multipart) ──────────────────────

describe("POST /api/v1/assets — kapak ÜRETİMDE oluşuyor", () => {
  async function login(harness: Harness = h): Promise<string> {
    const res = await harness.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost", host: "localhost" },
      payload: { password: PAROLA },
    });
    if (res.statusCode !== 200) {
      throw new Error(`giriş başarısız (${res.statusCode}): ${res.payload}`);
    }
    const raw = res.headers["set-cookie"];
    return (Array.isArray(raw) ? raw.join(";") : String(raw ?? "")).split(";")[0] ?? "";
  }

  it("multipart yükleme → coverKey dolu, GET /assets/:id/cover 200 + JPEG (FFD8)", async () => {
    const cookie = await login();
    const { payload, headers } = multipartBody({}, videoPath);

    // ⚠️ BU, `src/http/server.ts`'in `uploadAsset` çağrısına `transcoder`
    // geçmesinin ÜRETİM KANITIDIR: sunucu `transcoder`'ı geçmiyorsa gövde
    // `coverKey: null` döner ve kapak rotası 404 verir.
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...headers, ...sameOrigin(cookie) },
      payload,
    });
    expect(res.statusCode).toBe(201);

    const asset = dataOf<Asset>(res.payload);
    expect(asset.coverKey).toBeTruthy();
    const coverKey = String(asset.coverKey);
    expect(await h.store.exists(coverKey)).toBe(true);

    const cover = await h.server.inject({
      method: "GET",
      url: `/api/v1/assets/${asset.id}/cover`,
      headers: { cookie },
    });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/jpeg");
    // Gövde GERÇEK JPEG'tir (dosya adına değil, bayta bakıyoruz).
    const body = cover.rawPayload;
    expect(body.length).toBeGreaterThan(200);
    expect(isJpeg(body)).toBe(true);
  });
});

/** CSRF kapısını geçen istek başlıkları. */
function sameOrigin(cookie: string): Record<string, string> {
  return { origin: "http://localhost", host: "localhost", cookie };
}
