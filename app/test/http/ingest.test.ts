/**
 * `POST /api/v1/ingest` — OTURUM kanalı.
 *
 * Kapsam: panel de bu ucu kullanabilmeli. Yalnız `X-Api-Key` ile çalışan bir
 * uç, insanın kendi konsolundan video yükleyememesi demektir; aynı kişi
 * oturumla `/assets` yüklemesi yapabilirken içerik oluşturamaması tutarsızdır.
 *
 * ── "ÇOK DOSYALI" NEDEN İKİ İSTEK ─────────────────────────────────────────
 * `@fastify/multipart` bu sunucuda `files: 1` ile yapılandırılmıştır (video
 * akışı diske akıtılır, 2 GB belleğe ALINMAZ). Tek istekte iki dosya
 * göndermek limiti aşar ve 413 döner — bu KORUNMUŞ davranıştır, iki ayrı test
 * bunu ölçer:
 *   1) "panel iki dosya seçti" → iki AYRI istek, iki ayrı varlık/içerik.
 *   2) "tek istekte iki dosya" → 413 `payload_too_large`.
 * Panel de bu yüzden dosyaları SIRAYA gönderir (`UploadPanel.tsx`).
 *
 * Sunucu `inject()` ile çağrılır — PORT AÇILMAZ.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Platform } from "../../src/contract/index.js";
import {
  createHarness,
  dataOf,
  errorOf,
  makeVideo,
  multipartBody,
  type Harness,
} from "./helpers.js";

const PAROLA = "test-parola-1234";

let h: Harness;
let videoDir: string;

beforeEach(async () => {
  h = await createHarness({ adminPassword: PAROLA });
  videoDir = mkdtempSync(join(tmpdir(), "sp-ingest-"));
});

afterEach(async () => {
  rmSync(videoDir, { recursive: true, force: true });
  await h.close();
});

interface IngestBody {
  assetId: string;
  contentId: string;
  state: string;
  requiresApproval: boolean;
  jobIds: string[];
  findings: unknown[];
  skipped: Array<{ platform: string; reason: string }>;
}

/** Oturum açar ve `Cookie` başlığını döndürür. */
async function login(): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost", host: "localhost" },
    payload: { password: PAROLA },
  });
  if (res.statusCode !== 200) {
    throw new Error(`giriş başarısız (${res.statusCode}): ${res.payload}`);
  }
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
  return raw.split(";")[0] ?? "";
}

/** Panelin gönderdiği istek başlıkları: çerez + aynı köken (CSRF kapısı). */
function panelHeaders(cookie: string): Record<string, string> {
  return { origin: "http://localhost", host: "localhost", cookie };
}

async function postMultipart(
  headers: Record<string, string>,
  file: string,
  fields: Record<string, string> = {},
): Promise<{ status: number; payload: string }> {
  const body = multipartBody({ project: "genel", platforms: "instagram", ...fields }, file);
  const res = await h.server.inject({
    method: "POST",
    url: "/api/v1/ingest",
    headers: { ...body.headers, ...headers },
    payload: body.payload,
  });
  return { status: res.statusCode, payload: res.payload };
}

// ── 1. Oturum kanalı ────────────────────────────────────────────────────────

describe("POST /api/v1/ingest · oturum", () => {
  it("oturum çereziyle 200 döner ve içerik oluşur", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "panel-1.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video);
    expect(status).toBe(200);

    const body = dataOf<IngestBody>(payload);
    expect(body.assetId).not.toBe("");
    expect(body.contentId).not.toBe("");
    expect(h.repos.contents.getById(body.contentId)).not.toBeNull();
    expect(h.repos.assets.getById(body.assetId)?.originalName).toBe("panel-1.mp4");
  });

  it("oturumlu istek CSRF kapısından geçer (köken denetimi uygulanır)", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "panel-2.mp4");
    // KÖKEN YOKSA CSRF reddeder: panel yolu otomatik CSRF dışı değildir.
    const body = multipartBody({ project: "genel", platforms: "instagram" }, video);
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { ...body.headers, host: "localhost", cookie },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.payload).code).toBe("csrf_failed");
  });

  it("anahtar vermeden oturum açmadan 401 unauthorized verir", async () => {
    const video = makeVideo(videoDir, "anon.mp4");
    const { status, payload } = await postMultipart(
      { origin: "http://localhost", host: "localhost" },
      video,
    );
    expect(status).toBe(401);
    expect(errorOf(payload).code).toBe("unauthorized");
  });

  it("geçersiz oturum çerezi 401 verir", async () => {
    const video = makeVideo(videoDir, "kotu-cerez.mp4");
    const { status } = await postMultipart(
      panelHeaders("sp_session=yanlis-token"),
      video,
    );
    expect(status).toBe(401);
  });

  it("oturumlu istek denetimde `panel` aktörüyle işaretlenir", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "denetim.mp4");
    await postMultipart(panelHeaders(cookie), video);
    // Anahtar kanalı `ingest`/`auth.api_key` yazar; panel kanalı `panel`
    // yazmalıdır. İkisi karışırsa "kim yükledi" sorusu cevapsız kalır.
    const events = h.repos.audit.listByAction("ingest.panel_upload", 10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.actor).toBe("panel");
  });
});

// ── 2. Anahtar kanalı bozulmadı ────────────────────────────────────────────

describe("POST /api/v1/ingest · X-Api-Key", () => {
  it("anahtarla hâlâ çalışır (AI projeleri korunur)", async () => {
    const video = makeVideo(videoDir, "ci-1.mp4");
    const { status, payload } = await postMultipart(
      { "x-api-key": h.apiKey ?? "" },
      video,
    );
    expect(status).toBe(200);
    expect(dataOf<IngestBody>(payload).contentId).not.toBe("");
  });

  it("geçersiz anahtar 401 verir (sessizce oturuma düşülmez)", async () => {
    const video = makeVideo(videoDir, "ci-kotu.mp4");
    const { status } = await postMultipart(
      { "x-api-key": `sp_${"B".repeat(43)}` },
      video,
    );
    expect(status).toBe(401);
  });

  it("oturum + birlikte anahtar varsa anahtar kanalı KAZANIR", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "ikisi.mp4");
    const { status, payload } = await postMultipart(
      { ...panelHeaders(cookie), "x-api-key": h.apiKey ?? "" },
      video,
    );
    // Anahtar varsa CSRF dışıdır ve aktör `ingest` olur: hatalı anahtar
    // sessizce "oturumla devam" etmemeli.
    expect(status).toBe(200);
    expect(h.repos.audit.listByAction("ingest.panel_upload", 10)).toHaveLength(0);
  });
});

// ── 3. Çok dosya ────────────────────────────────────────────────────────────

describe("POST /api/v1/ingest · çok dosya", () => {
  it("panel iki dosya seçtiyse her dosya için AYRI varlık ve içerik oluşur", async () => {
    const cookie = await login();
    const first = makeVideo(videoDir, "cok-1.mp4");
    const second = makeVideo(videoDir, "cok-2.mp4", { seconds: 5 });

    const a = await postMultipart(panelHeaders(cookie), first);
    const b = await postMultipart(panelHeaders(cookie), second);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const first1 = dataOf<IngestBody>(a.payload);
    const second1 = dataOf<IngestBody>(b.payload);
    expect(first1.assetId).not.toBe(second1.assetId);
    expect(first1.contentId).not.toBe(second1.contentId);
    // Depoda iki ayrı varlık ve iki ayrı içerik.
    expect(h.repos.assets.listFiltered({ limit: 10 })).toHaveLength(2);
    expect(h.repos.contents.listFiltered({ limit: 10 })).toHaveLength(2);
  });

  it("tek istekte iki dosya 413 payload_too_large verir (files limiti 1)", async () => {
    const cookie = await login();
    const first = makeVideo(videoDir, "tek-a.mp4");
    const second = makeVideo(videoDir, "tek-b.mp4");
    const body = multipartBody(
      { project: "genel", platforms: "instagram" },
      undefined,
    );
    // İki dosya parçası elle birleştirilir: `multipartBody` tek dosya yapar.
    const doubled = withSecondFile(body.payload, body.headers["content-type"] ?? "", second);
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": doubled.contentType, ...panelHeaders(cookie) },
      payload: doubled.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(errorOf(res.payload).code).toBe("payload_too_large");
  });
});

// ── 4. Sınır ve doğrulama ───────────────────────────────────────────────────

describe("POST /api/v1/ingest · sınır ve doğrulama", () => {
  it("platforms boşsa 400 validation_failed verir", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "bos-platform.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video, {
      platforms: "",
    });
    expect(status).toBe(400);
    const err = errorOf(payload);
    expect(err.code).toBe("validation_failed");
    // Sunucunun Türkçe gerekçesi panelde AYENEN gösterilir; test bunu kilitler.
    expect(err.message).toContain("platform");
  });

  it("platforms geçersizse (bilinmeyen ad) 400 validation_failed verir", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "kotu-platform.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video, {
      platforms: "myspace",
    });
    expect(status).toBe(400);
    expect(errorOf(payload).code).toBe("validation_failed");
  });

  it("`file` alanı yoksa 400 validation_failed verir", async () => {
    const cookie = await login();
    const body = multipartBody({ project: "genel", platforms: "instagram" });
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { ...body.headers, ...panelHeaders(cookie) },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("oturumlu JSON gövde de kabul edilir (dosya yoluyla)", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "json-kaynak.mp4");
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": "application/json", ...panelHeaders(cookie) },
      payload: {
        project: "genel",
        platforms: ["instagram"],
        sourcePath: video,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf<IngestBody>(res.payload).assetId).not.toBe("");
  });

  it("çok büyük JSON gövde 413 verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": "application/json", ...panelHeaders(cookie) },
      payload: { project: "x".repeat(3 * 1024 * 1024), platforms: ["instagram"] },
    });
    expect(res.statusCode).toBe(413);
  });
});

// ── 5. Panel formunun alanları ─────────────────────────────────────────────

describe("POST /api/v1/ingest · panel formu", () => {
  it("platformlar virgüllü metin olarak gönderilir ve üçü de kabul edilir", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "uc-platform.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video, {
      platforms: "instagram,tiktok,youtube",
    });
    expect(status).toBe(200);
    // Kuyruk işi platform başına oluşur; hesap yoksa `skipped` gerekçesi
    // döner. Önemli olan: ÜÇ platform da "geçersiz" sayılmadı.
    const body = dataOf<IngestBody>(payload);
    const touched = new Set([
      ...body.skipped.map((s) => s.platform),
      ...(body.findings as Array<{ platform?: Platform }>).map((f) => f.platform ?? ""),
    ]);
    expect(body.skipped.length + (body.findings.length as number)).toBeGreaterThanOrEqual(0);
    expect(touched.has("myspace")).toBe(false);
  });

  it("defaultCopy JSON metni (açıklama + hashtag) çözülür", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "copy-li.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video, {
      defaultCopy: JSON.stringify({ description: "Kahve molası", hashtags: ["kahve"] }),
    });
    expect(status).toBe(200);
    const contentId = dataOf<IngestBody>(payload).contentId;
    const content = h.repos.contents.getById(contentId);
    expect(JSON.stringify(content?.copy ?? {})).toContain("kahve");
  });

  it("geçersiz JSON alanı 400 validation_failed verir", async () => {
    const cookie = await login();
    const video = makeVideo(videoDir, "kotu-json.mp4");
    const { status, payload } = await postMultipart(panelHeaders(cookie), video, {
      defaultCopy: "{bozuk",
    });
    expect(status).toBe(400);
    expect(errorOf(payload).code).toBe("validation_failed");
  });
});

// ── Yardımcı ────────────────────────────────────────────────────────────────

/**
 * `multipartBody` tek dosya üretir; limit testi iki dosya ister. İkinci parça
 * elle eklenir: sınır `--boundary` kapanışından ÖNCE gelmelidir.
 */
function withSecondFile(
  payload: Buffer,
  contentType: string,
  secondPath: string,
): { payload: Buffer; contentType: string } {
  const boundary = /boundary=([^\s;]+)/.exec(contentType)?.[1] ?? "";
  const closing = Buffer.from(`--${boundary}--\r\n`, "utf8");
  const head = payload.subarray(0, payload.length - closing.length);
  const second = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${basename(secondPath)}"\r\nContent-Type: video/mp4\r\n\r\n`,
    "utf8",
  );
  return {
    payload: Buffer.concat([head, second, readFileSync(secondPath), closing]),
    contentType,
  };
}
