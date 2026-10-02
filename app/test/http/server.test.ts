/**
 * HTTP SUNUCU TESTLERİ.
 *
 * Kapsam: zarf, oturum, CSRF, log maskeleme, API anahtarı, Range, medya imzası,
 * ingest ucu ve panelin okuduğu alan adları.
 *
 * Sunucu `inject()` ile çağrılır — PORT AÇILMAZ.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_COOKIE } from "../../src/http/index.js";
import { PRODUCT_ASPECT_CODE } from "../../src/ingest/index.js";
import { signKey } from "../../src/media/index.js";
import type { ContentItem, ValidationFinding } from "../../src/contract/index.js";
import {
  createHarness,
  dataOf,
  errorOf,
  makeVideo,
  multipartBody,
  seedAccount,
  type Harness,
} from "./helpers.js";

const PAROLA = "test-parola-1234";

let h: Harness;
let videoDir: string;

beforeEach(async () => {
  h = await createHarness({ adminPassword: PAROLA });
  videoDir = mkdtempSync(join(tmpdir(), "sp-video-"));
});

afterEach(async () => {
  rmSync(videoDir, { recursive: true, force: true });
  await h.close();
});

/** Oturum açar ve `Cookie` başlığını döndürür. */
async function login(harness: Harness = h, password = PAROLA): Promise<string> {
  const res = await harness.server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost", host: "localhost" },
    payload: { password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`giriş başarısız (${res.statusCode}): ${res.payload}`);
  }
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
  return raw.split(";")[0] ?? "";
}

/** CSRF kapısını geçen istek başlıkları. */
function sameOrigin(cookie?: string): Record<string, string> {
  return { origin: "http://localhost", host: "localhost", ...(cookie ? { cookie } : {}) };
}

interface IngestBody {
  assetId: string;
  contentId: string;
  state: string;
  requiresApproval: boolean;
  jobIds: string[];
  findings: ValidationFinding[];
  skipped: Array<{ platform: string; reason: string }>;
}

/** 9:16 test videosunu multipart ile ingest'e gönderir. */
async function ingestVideo(
  harness: Harness,
  file: string,
  fields: Record<string, string> = {},
): Promise<IngestBody> {
  const { payload, headers } = multipartBody(
    { project: "ai-projesi", platforms: "instagram", ...fields },
    file,
  );
  const res = await harness.server.inject({
    method: "POST",
    url: "/api/v1/ingest",
    headers: { ...headers, "x-api-key": harness.apiKey ?? "" },
    payload,
  });
  if (res.statusCode !== 200) {
    throw new Error(`ingest başarısız (${res.statusCode}): ${res.payload}`);
  }
  return dataOf<IngestBody>(res.payload);
}

// ── 1. Zarf ───────────────────────────────────────────────────────────────

describe("zarf", () => {
  it("404 hatası { ok:false, error:{ code, message } } üretir", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/v1/olmayan-rota" });
    expect(res.statusCode).toBe(404);
    const err = errorOf(res.payload);
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("/api/v1/olmayan-rota");
  });

  it("oturumsuz korumalı rota 401 unauthorized verir", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).code).toBe("unauthorized");
  });

  it("geçersiz durum filtresi 400 validation_failed verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/content?state=olmayan-durum",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("yarım JSON gövdesi 400 bad_request verir (500 değil)", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json", ...sameOrigin() },
      payload: "{ bozuk",
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("bad_request");
  });

  it("başarılı yanıtlar { ok:true, data } zarfındadır", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/health" });
    expect(JSON.parse(res.payload).ok).toBe(true);
    expect(dataOf(res.payload)).toBeTruthy();
  });

  it("geçersiz gövde 400 doğrulama hatası verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { "content-type": "application/json", ...sameOrigin(cookie) },
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });
});

// ── 2. Oturum ─────────────────────────────────────────────────────────────

describe("oturum", () => {
  it("parola yokken login not_configured verir", async () => {
    const h2 = await createHarness({ adminPassword: null });
    try {
      const res = await h2.server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: sameOrigin(),
        payload: { password: "herhangi" },
      });
      expect(res.statusCode).toBe(503);
      expect(errorOf(res.payload).code).toBe("not_configured");
    } finally {
      await h2.close();
    }
  });

  it("parola yokken /api/v1/session authenticated:false ve not_configured der", async () => {
    const h2 = await createHarness({ adminPassword: null });
    try {
      const res = await h2.server.inject({ method: "GET", url: "/api/v1/session" });
      const data = dataOf<{ authenticated: boolean; reason?: string }>(res.payload);
      expect(data.authenticated).toBe(false);
      expect(data.reason).toBe("not_configured");
    } finally {
      await h2.close();
    }
  });

  it("parola yokken korumalı rota 401 verir", async () => {
    const h2 = await createHarness({ adminPassword: null });
    try {
      const res = await h2.server.inject({ method: "GET", url: "/api/v1/projects" });
      expect(res.statusCode).toBe(401);
    } finally {
      await h2.close();
    }
  });

  it("yanlış parola 401 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: sameOrigin(),
      payload: { password: "yanlis-parola" },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).code).toBe("unauthorized");
  });

  it("doğru parola 200 döner ve sp_session çerezi verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: sameOrigin(),
      payload: { password: PAROLA },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(dataOf<{ authenticated: boolean }>(res.payload).authenticated).toBe(true);
  });

  it("çerezsiz korumalı rota 401 verir", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("çerezle korumalı rota 200 döner", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(dataOf<unknown[]>(res.payload))).toBe(true);
  });

  it("/api/v1/session çerezsizken authenticated:false ve no_session der", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/v1/session" });
    const data = dataOf<{ authenticated: boolean; reason?: string }>(res.payload);
    expect(data.authenticated).toBe(false);
    expect(data.reason).toBe("no_session");
  });

  it("çerezle /api/v1/session authenticated:true der", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { cookie },
    });
    expect(dataOf<{ authenticated: boolean }>(res.payload).authenticated).toBe(true);
  });

  it("çıkış oturumu düşürür", async () => {
    const cookie = await login();
    const out = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: sameOrigin(cookie),
    });
    expect(out.statusCode).toBe(200);
    const after = await h.server.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("hız sınırı: çok sayıda hatalı denemeden sonra 429", async () => {
    let last = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await h.server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: sameOrigin(),
        payload: { password: `yanlis-${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

// ── 3. CSRF ───────────────────────────────────────────────────────────────

describe("CSRF", () => {
  it("Origin uyuşmadan approve 403 csrf_failed verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/content/bir-kimlik/approve",
      headers: { cookie, origin: "https://saldirgan.example", host: "localhost" },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.payload).code).toBe("csrf_failed");
  });

  it("Origin uyuyken onay rotası CSRF kapısını geçer (404'a düşer)", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/content/yok-boyle-bir-kimlik/approve",
      headers: sameOrigin(cookie),
    });
    // 404 = CSRF GEÇTİ, kayıt yok. 403 olsaydı kapı yanlış yerdeydi.
    expect(res.statusCode).toBe(404);
  });

  it("X-Api-Key taşıyan ingest isteği CSRF dışıdır", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: {
        "x-api-key": h.apiKey ?? "",
        "content-type": "application/json",
        origin: "https://kotu.example",
      },
      payload: { project: "p", platforms: ["instagram"] },
    });
    // 403 değil: kimlik doğrulama geçti, gövde doğrulamasında kaldı.
    expect(res.statusCode).not.toBe(403);
  });

  it("GET istekleri CSRF denetimine girmez", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://kotu.example" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("Origin yokken de POST reddedilir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: { name: "p" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── 4. Log sızıntısı ──────────────────────────────────────────────────────

describe("log maskeleme", () => {
  it("yanlış parola denemesinde pino çıktısı parolayı İÇERMEZ", async () => {
    const gizli = "COK-GIZLI-PAROLA-42";
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: sameOrigin(),
      payload: { password: gizli },
    });
    expect(res.statusCode).toBe(401);
    const log = h.logText();
    expect(log.length).toBeGreaterThan(0); // gerçekten log yazıldı
    expect(log).not.toContain(gizli);
  });

  it("doğru parola da loglanmaz", async () => {
    await login(h, PAROLA);
    expect(h.logText()).not.toContain(PAROLA);
  });

  it("ham ingest API anahtarı loglanmaz", async () => {
    const key = h.apiKey ?? "";
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": key, "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], sourcePath: "x.mp4" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.logText()).not.toContain(key);
  });

  it("çerez (oturum token'ı) loglanmaz", async () => {
    const cookie = await login();
    const token = cookie.split("=")[1] ?? "";
    await h.server.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    expect(h.logText()).not.toContain(token);
  });
});

// ── 5. API anahtarı ───────────────────────────────────────────────────────

describe("ingest API anahtarı", () => {
  const BAD_BODY = { project: "p", platforms: ["instagram"], sourcePath: "../../../.env" };

  it("anahtarsız istek 401 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": "application/json", ...sameOrigin() },
      payload: BAD_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).code).toBe("unauthorized");
  });

  it("yanlış anahtar 401 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": `sp_${"A".repeat(43)}`, "content-type": "application/json" },
      payload: BAD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("biçimsiz anahtar 401 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": "kisa", "content-type": "application/json" },
      payload: BAD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("iptal edilmiş anahtar 401 verir", async () => {
    const created = h.repos.apiKeys.list(10)[0];
    expect(created).toBeTruthy();
    expect(h.repos.apiKeys.revoke(String(created?.id))).toBe(true);
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: BAD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("doğru anahtar isteği kimlik doğrulamasından geçirir (400 döner)", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: BAD_BODY,
    });
    // Kimlik geçti, gövde reddedildi: 401 DEĞİL.
    expect(res.statusCode).toBe(400);
  });

  it("ham anahtar ikinci listelemede görünmez", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/ingest/keys",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(h.apiKey ?? "YOK");
    const keys = dataOf<Array<Record<string, unknown>>>(res.payload);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(keys[0] ?? {})).not.toContain("key");
    expect(String(keys[0]?.["prefix"] ?? "")).toMatch(/^sp_/);
  });

  it("panel anahtar üretebilir (201) ve ham değer yalnız bir kez döner", async () => {
    const cookie = await login();
    const made = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest/keys",
      headers: sameOrigin(cookie),
      payload: { project: "yeni-proje" },
    });
    expect(made.statusCode).toBe(201);
    const data = dataOf<{ key: string; id: string }>(made.payload);
    expect(data.key).toMatch(/^sp_/);

    const list = await h.server.inject({
      method: "GET",
      url: "/api/v1/ingest/keys",
      headers: { cookie },
    });
    expect(list.payload).not.toContain(data.key);
  });

  it("doğru anahtar son kullanım damgası yazar", async () => {
    const before = h.repos.apiKeys.list(10)[0];
    expect(before?.lastUsedAt).toBeNull();
    await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: BAD_BODY,
    });
    const after = h.repos.apiKeys.list(10)[0];
    expect(after?.lastUsedAt).toBeTruthy();
  });
});

// ── 6. Range ──────────────────────────────────────────────────────────────

const RANGE_KEY = "uploads/test/range-dosya.mp4";

/**
 * İmzalı medya adresi.
 *
 * `expires`/`sig` SORGÜ DİZGİSİ argümanıdır (başlık değil): rota
 * `request.query` okur. Bunu başlığa koymak 403'e yol açar ve imza kontrolü
 * hiç sınanmadan "imzasız" yolu test eder.
 */
function signedUrl(secret: string, key: string, ttlSec = 3_600): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  return `/api/v1/media/${key}?expires=${expires}&sig=${encodeURIComponent(signKey(secret, key, expires))}`;
}

describe("Range istekleri", () => {
  beforeEach(async () => {
    await h.putFile(RANGE_KEY, Buffer.alloc(5_000, 9));
  });

  it("bytes=0-99 → 206 + doğru Content-Range ve content-length: 100", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, RANGE_KEY),
      headers: { range: "bytes=0-99" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-99/5000");
    expect(res.headers["content-length"]).toBe("100");
    expect(res.rawPayload.length).toBe(100);
  });

  it("bytes=999999999- → 416 + Content-Range: bytes */5000", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, RANGE_KEY),
      headers: { range: "bytes=999999999-" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */5000");
  });

  it("bytes=4900- → son bayta kadar 206", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, RANGE_KEY),
      headers: { range: "bytes=4900-" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 4900-4999/5000");
    expect(res.headers["content-length"]).toBe("100");
  });

  it("çoklu aralık desteklenmez → 416", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, RANGE_KEY),
      headers: { range: "bytes=0-1,5-6" },
    });
    expect(res.statusCode).toBe(416);
  });

  it("Range yoksa 200 ve tam dosya döner", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, RANGE_KEY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("5000");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.rawPayload.length).toBe(5_000);
  });
});

// ── 7. Medya imzası ────────────────────────────────────────────────────────

const SIG_KEY = "uploads/imza/deneme.mp4";

describe("imzalı medya", () => {
  beforeEach(async () => {
    await h.putFile(SIG_KEY, Buffer.from("imzalı medya içeriği"));
  });

  it("imzasız adres 403 forbidden verir", async () => {
    const res = await h.server.inject({ method: "GET", url: `/api/v1/media/${SIG_KEY}` });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.payload).code).toBe("forbidden");
  });

  it("bozuk imza 403 verir", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3_600;
    const res = await h.server.inject({
      method: "GET",
      url: `/api/v1/media/${SIG_KEY}?expires=${expires}&sig=bozuk-imza`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("geçerli imza 200 döner ve oturum gerekmez", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: signedUrl(h.mediaSecret, SIG_KEY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("imzalı medya");
  });

  it("süresi dolmuş imza 403 verir", async () => {
    const expires = Math.floor(Date.now() / 1000) - 10;
    const res = await h.server.inject({
      method: "GET",
      url: `/api/v1/media/${SIG_KEY}?expires=${expires}&sig=${signKey(h.mediaSecret, SIG_KEY, expires)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("başka anahtarın imzası 403 verir", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3_600;
    const res = await h.server.inject({
      method: "GET",
      url: `/api/v1/media/${SIG_KEY}?expires=${expires}&sig=${signKey(h.mediaSecret, "uploads/imza/baska.mp4", expires)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("süresiz adres (expires yok) 403 verir", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: `/api/v1/media/${SIG_KEY}?sig=${signKey(h.mediaSecret, SIG_KEY, 9999999999)}`,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── 8–14. Ingest ucundan uca ───────────────────────────────────────────────

describe("ingest uçtan uca", () => {
  it("9:16 video + multipart + X-Api-Key → varlık ve içerik oluşur", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey.mp4");
    const data = await ingestVideo(h, video);

    expect(h.repos.assets.getById(data.assetId)).toBeTruthy();
    const content = h.repos.contents.getById(data.contentId);
    expect(content).toBeTruthy();
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.requiresApproval).toBe(true);
    expect(content?.state).not.toBe("published");
    expect(data.jobIds).toEqual([]);
  });

  it("kapak karesi üretilir", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "kapakli.mp4");
    const data = await ingestVideo(h, video);
    const asset = h.repos.assets.getById(data.assetId);
    expect(asset?.coverKey).toBeTruthy();
    expect(h.store.resolveKey(String(asset?.coverKey))).toBeTruthy();
  });

  it("autoSchedule=true → kuyruk işi oluşur (queued) ve idempotencyKey vardır", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey-2.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.requiresApproval).toBe(false);
    expect(data.jobIds.length).toBe(1);

    const job = h.repos.jobs.getById(data.jobIds[0] ?? "");
    expect(job?.state).toBe("queued");
    expect(job?.idempotencyKey).toMatch(/^ingest:/);
  });

  it("hesap yoksa kuyruk boş kalır ve gerekçe döner", async () => {
    const video = makeVideo(videoDir, "hesapsiz.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.jobIds).toEqual([]);
    expect(data.skipped[0]?.reason).toContain("hesap yok");
  });

  it("onay kapısı: requiresApproval ve onay yokken scheduler işi skipped yapar", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey-3.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.jobIds.length).toBe(1);
    // Onayı geri al: içerik onay bekliyor, iş kuyrukta.
    h.repos.contents.update(data.contentId, { approvedAt: null, approvedBy: null });
    h.repos.contents.update(data.contentId, { requiresApproval: true });

    const tick = await h.schedulerCore?.runOnce();
    expect(tick?.claimed).toBeGreaterThanOrEqual(1);
    expect(tick?.published).toBe(0);
    expect(tick?.skipped).toBeGreaterThanOrEqual(1);
    const skippedDetail = (tick?.details ?? []).find((d) => d.outcome === "skipped");
    expect(skippedDetail?.reason ?? "").toContain("approval_pending");
  });

  it("onay → publish-now → sahte adaptörde published + permalink dolu", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey-4.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.jobIds.length).toBe(1);

    const detail = await h.publisher?.publishNow(data.jobIds[0] ?? "");
    expect(detail?.state).toBe("published");
    expect(detail?.permalink).toBeTruthy();
    const job = h.repos.jobs.getById(data.jobIds[0] ?? "");
    expect(job?.state).toBe("published");
    expect(job?.permalink).toBeTruthy();
  });

  it("yatay video (1920x1080) → taslak + kuyruk yok + gerekçe dönüyor", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "yatay.mp4", { width: 1920, height: 1080 });
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.state).toBe("draft");
    expect(data.jobIds).toEqual([]);
    expect(data.skipped.length).toBeGreaterThan(0);
    expect(data.skipped[0]?.reason).toContain("Medya doğrulaması");

    const content = h.repos.contents.getById(data.contentId) as ContentItem;
    expect(content.state).toBe("draft");
    expect(h.repos.jobs.listByContent(content.id)).toEqual([]);
  });

  it("yatay video: bulgu ürün kuralıdır ve mesaj İKİ yarımı da söyler", async () => {
    // `validateMedia` yatay videoyu Instagram için UYARI olarak geçirir
    // (zorunlu aralık 0.01:1–10:1). Taslağa düşüren bizim ÜRÜN kararımızdır;
    // bu yüzden bulgu `aspect_ratio` DEĞİL `product_aspect_9_16` kodudur.
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "yatay-urun-kurali.mp4", { width: 1920, height: 1080 });
    const data = await ingestVideo(h, video, { autoSchedule: "true" });

    const product = data.findings.find((f) => f.code === PRODUCT_ASPECT_CODE);
    expect(product).toBeDefined();
    expect(product?.severity).toBe("error");
    // `provisional: false`: bu bizim kuralımız, doğrulanmamış platform sınırı DEĞİL.
    expect(product?.provisional).toBe(false);

    // DÜRÜSTLÜK: mesaj hem "platform kabul eder" hem "bu uygulama kabul
    // etmiyor" demeli. Tek yarısı olsaydı kural keyfî sertlik gibi görünürdü.
    const message = String(product?.message);
    expect(message).toContain("platform kabul eder");
    expect(message).toContain("bu uygulama kabul etmiyor");
    expect(message).toContain("1920x1080");

    // Platform kuralı AYNI anda kendi uyarısını korur (katmanlar birleşti).
    const platformAspect = data.findings.find((f) => f.code === "aspect_ratio");
    expect(platformAspect?.severity).toBe("warning");
  });

  it("9:16 dikey video ürün kuralı ÜRETMEZ", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "dikey-urun-kurali-yok.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    expect(data.findings.some((f) => f.code === PRODUCT_ASPECT_CODE)).toBe(false);
    expect(data.state).toBe("ready");
  });

  it("aynı içerik ikinci kez gelirse yeni varlık açılmaz", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "ayni.mp4");
    const first = await ingestVideo(h, video);
    const second = await ingestVideo(h, video);
    expect(second.assetId).toBe(first.assetId);
    expect(second.contentId).not.toBe(first.contentId);
    expect(h.repos.assets.listFiltered({ limit: 100 }).length).toBe(1);
  });

  it("path traversal sourcePath → 400, dosya okunmuyor", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], sourcePath: "../../../.env" },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
    expect(h.repos.assets.listFiltered({ limit: 100 })).toEqual([]);
  });

  it("SSRF: cloud metadata adresi → 400", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: {
        project: "p",
        platforms: ["instagram"],
        sourceUrl: "http://169.254.169.254/latest/meta-data/",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("SSRF: localhost da reddedilir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], sourceUrl: "http://localhost:4317/api/health" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sourcePath ve sourceUrl aynı anda → 400", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: {
        project: "p",
        platforms: ["instagram"],
        sourcePath: "a.mp4",
        sourceUrl: "https://example.com/a.mp4",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("platforms yoksa 400 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "p", platforms: [], sourcePath: "a.mp4" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("geçersiz JSON alanı 400 verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], tags: "{ bozuk" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("JSON ingest (multipart değil) sourcePath ile çalışır", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "json-kaynak.mp4");
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "json-projesi", platforms: ["instagram"], sourcePath: video },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf<IngestBody>(res.payload);
    expect(h.repos.assets.getById(data.assetId)).toBeTruthy();
  });

  it("olmayan dosya 400 validation_failed verir", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "x-api-key": h.apiKey ?? "", "content-type": "application/json" },
      payload: { project: "p", platforms: ["instagram"], sourcePath: join(videoDir, "yok.mp4") },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });
});

// ── 15–17. Panel sözleşmesi ────────────────────────────────────────────────

describe("panel sözleşmesi", () => {
  it("/api/v1/setup boş .env'de eksik anahtarları listeler", async () => {
    // "Boş .env" senaryosu: ne master key ne parola. Anahtarları olan bir
    // kurulumda `SP_MASTER_KEY` problem listesinde görünmez.
    const h2 = await createHarness({ adminPassword: null, masterKey: null });
    try {
      const res = await h2.server.inject({ method: "GET", url: "/api/v1/setup" });
      expect(res.statusCode).toBe(200);
      const data = dataOf<{
        mode: string;
        problems: Array<{ code: string; envKeys: string[] }>;
        platforms: Array<{ platform: string; missing: string[]; reviewNeeded: boolean }>;
      }>(res.payload);

      expect(data.mode).toBe("mock");
      const codes = data.problems.map((p) => p.code);
      expect(codes).toContain("master_key_missing");
      expect(codes).toContain("admin_password_missing");
      expect(codes).toContain("instagram_credentials_missing");
      expect(codes).toContain("tiktok_credentials_missing");
      expect(codes).toContain("youtube_credentials_missing");

      const envKeys = data.problems.flatMap((p) => p.envKeys);
      expect(envKeys).toContain("SP_MASTER_KEY");
      expect(envKeys).toContain("SP_ADMIN_PASSWORD");
      expect(envKeys).toContain("SP_META_APP_ID");
      expect(envKeys).toContain("SP_GOOGLE_CLIENT_ID");
      expect(data.platforms.length).toBe(3);
    } finally {
      await h2.close();
    }
  });

  it("/api/v1/setup her platform için reviewNeeded alanını döndürür", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/v1/setup" });
    const data = dataOf<{ platforms: Array<{ platform: string; reviewNeeded: boolean; missing: string[] }> }>(
      res.payload,
    );
    expect(data.platforms.length).toBe(3);
    for (const p of data.platforms) {
      expect(typeof p.reviewNeeded).toBe("boolean");
      expect(p.missing.length).toBeGreaterThan(0); // sağlayıcı sırları yok
    }
  });

  it("needs_reauth hesabı reviewNeeded:true işaretler", async () => {
    h.repos.accounts.create({
      platform: "instagram",
      externalId: "needs-reauth-1",
      displayName: "Eski hesap",
      username: "eski",
      status: "needs_reauth",
    });
    const res = await h.server.inject({ method: "GET", url: "/api/v1/setup" });
    const data = dataOf<{
      platforms: Array<{ platform: string; reviewNeeded: boolean }>;
      problems: Array<{ code: string }>;
    }>(res.payload);
    expect(data.platforms.find((p) => p.platform === "instagram")?.reviewNeeded).toBe(true);
    expect(data.problems.map((p) => p.code)).toContain("instagram_reauth_required");
  });

  it("/api/health sırlar yokken mode: 'mock' döner", async () => {
    const h2 = await createHarness({ adminPassword: null, masterKey: null });
    try {
      const res = await h2.server.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const data = dataOf<{ ok: boolean; mode: string; db: string; version: string; scheduler: { running: boolean } }>(
        res.payload,
      );
      expect(data.ok).toBe(true);
      expect(data.db).toBe("ok");
      expect(data.mode).toBe("mock");
      expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.scheduler.running).toBe(false);
    } finally {
      await h2.close();
    }
  });

  it("/api/health yapılandırılmış testte de mock kalır (canlı adaptör yok)", async () => {
    const res = await h.server.inject({ method: "GET", url: "/api/health" });
    expect(dataOf<{ mode: string }>(res.payload).mode).toBe("mock");
  });

  it("perPlatform anahtarları tam platform adlarıdır (ig/tt/yt DEĞİL)", async () => {
    const key = "uploads/rapor/dikey.mp4";
    const assetId = await h.seedAssetWithFile(key, Buffer.alloc(2_048, 4), VALID_INFO(key));
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/report`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf<{ perPlatform: Record<string, ValidationFinding[]> }>(res.payload);
    // Uzun anahtar panelin okuduğu anahtardır; kısaltma hatasını kilitler.
    expect(Object.keys(data.perPlatform).sort()).toEqual(["instagram", "tiktok", "youtube"]);
    expect(data.perPlatform.instagram).toBeDefined();
    expect(data.perPlatform.tiktok).toBeDefined();
    expect(data.perPlatform.youtube).toBeDefined();
  });

  it("varlık listesi oturumla açılır", async () => {
    const key = "uploads/liste/klip.mp4";
    await h.seedAssetWithFile(key, Buffer.alloc(2_048, 5), VALID_INFO(key));
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/assets",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((dataOf<unknown[]>(res.payload) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("jobs listesi geçersiz platform filtresinde 400 verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/jobs?platform=olmayan",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("published iş yeniden kuyruğa alınamaz (409 conflict)", async () => {
    seedAccount(h.repos, "instagram");
    const key = "uploads/retry/klip.mp4";
    const asset = h.repos.assets.create({
      storageKey: key,
      originalName: "klip.mp4",
      bytes: 100,
      mimeType: "video/mp4",
      info: VALID_INFO(key),
    });
    const project = h.repos.projects.ensure("retry-projesi", null);
    const content = h.repos.contents.create({ projectId: project.id, assetId: asset.id });
    const account = h.repos.accounts.listByPlatform("instagram")[0];
    const job = h.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: String(account?.id ?? ""),
      scheduledAt: new Date().toISOString(),
      idempotencyKey: "retry-testi",
    });
    h.repos.jobs.markState(job.id, "published", { permalink: "https://example.invalid/x" });
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: `/api/v1/jobs/${job.id}/retry`,
      headers: sameOrigin(cookie),
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.payload).code).toBe("conflict");
  });

  it("scheduler yoksa tick 503 not_configured verir", async () => {
    const h2 = await createHarness({ withoutPublisher: true });
    try {
      const loginRes = await h2.server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: sameOrigin(),
        payload: { password: PAROLA },
      });
      const raw = String(loginRes.headers["set-cookie"] ?? "").split(";")[0] ?? "";
      const res = await h2.server.inject({
        method: "POST",
        url: "/api/v1/scheduler/tick",
        headers: sameOrigin(raw),
      });
      expect(res.statusCode).toBe(503);
      expect(errorOf(res.payload).code).toBe("not_configured");
    } finally {
      await h2.close();
    }
  });

  it("scheduler status çalışır ve çalışma bilgisini verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/scheduler",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf<{ tickMs: number; running: boolean; nextTickAt: string | null }>(res.payload);
    expect(data.tickMs).toBeGreaterThan(0);
    expect(data.running).toBe(false);
    expect(data.nextTickAt).toBeNull();
  });
});

// ── Onay akışı ────────────────────────────────────────────────────────────

describe("onay akışı", () => {
  it("ingest (onay bekliyor) → approve işleri kuyruğa alır", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "onay.mp4");
    const data = await ingestVideo(h, video);
    expect(data.requiresApproval).toBe(true);
    expect(h.repos.jobs.listByContent(data.contentId)).toEqual([]);

    const cookie = await login();
    const approved = await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/approve`,
      headers: sameOrigin(cookie),
    });
    expect(approved.statusCode).toBe(200);
    const approvedData = dataOf<{ jobIds: string[]; approvedAt: string | null }>(approved.payload);
    expect(approvedData.approvedAt).toBeTruthy();
    expect(approvedData.jobIds.length).toBe(1);
    expect(h.repos.jobs.getById(approvedData.jobIds[0] ?? "")?.state).toBe("queued");
  });

  it("approve ikinci kez çağrılsa da mükerrer iş üretmez", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "cift-onay.mp4");
    const data = await ingestVideo(h, video);
    const cookie = await login();
    await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/approve`,
      headers: sameOrigin(cookie),
    });
    const second = await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/approve`,
      headers: sameOrigin(cookie),
    });
    expect(second.statusCode).toBe(200);
    expect(h.repos.jobs.listByContent(data.contentId).length).toBe(1);
  });

  it("publish-now onaylı kuyruğu çalıştırır", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "simdi.mp4");
    const data = await ingestVideo(h, video);
    const cookie = await login();
    await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/approve`,
      headers: sameOrigin(cookie),
    });
    const res = await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/publish-now`,
      headers: sameOrigin(cookie),
    });
    expect(res.statusCode).toBe(200);
    const body = dataOf<{ requested: number }>(res.payload);
    expect(body.requested).toBe(1);
    expect(h.repos.jobs.listByContent(data.contentId)[0]?.state).toBe("published");
  });

  it("yok edilen içerik 404 verir", async () => {
    const cookie = await login();
    const res = await h.server.inject({
      method: "GET",
      url: "/api/v1/content/yok",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("cancel yayınlanmış işi iptal etmez", async () => {
    seedAccount(h.repos, "instagram");
    const video = makeVideo(videoDir, "iptal.mp4");
    const data = await ingestVideo(h, video, { autoSchedule: "true" });
    await h.publisher?.publishNow(data.jobIds[0] ?? "");
    const cookie = await login();
    const res = await h.server.inject({
      method: "POST",
      url: `/api/v1/content/${data.contentId}/cancel`,
      headers: sameOrigin(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(h.repos.jobs.listByContent(data.contentId)[0]?.state).toBe("published");
  });
});

/** Testlerin kullandığı geçerli `MediaInfo` (9:16, sesli). */
function VALID_INFO(path: string) {
  return {
    path,
    bytes: 2_048,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 12,
    bitrate: 4_000_000,
    hasAudio: true,
  };
}