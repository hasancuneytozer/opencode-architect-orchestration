/**
 * HESAP BAĞLAMA (OAUTH) TESTLERİ.
 *
 * Kapsam: `GET /api/v1/auth/:platform/start` ve `/callback`.
 *
 * ── HİÇBİR TEST AĞA ÇIKMAZ ──────────────────────────────────────────────────
 * Sağlayıcı (`AuthProvider`) SAHTEDİR: `authorizeUrl` yalnız bir dize kurar,
 * `exchangeCode` hazır cevap döner. `fetch` hiçbir yerde çağrılmaz — test
 * gerçekten Google'a gitmez. Doğrulama kuralı: bu dosyada `globalThis.fetch`
 * YOK.
 *
 * ── EN KRİTİK TEST: BİLİNMEYEN `state` ──────────────────────────────────────
 * `state` CSRF korumasıdır. Bilinmeyen `state` ile gelen bir geri çağırma
 * saldırının taşıdığı yetkilendirme kodunu kurumuzun hesabına bağlar. Bu
 * yüzden "bilinmiyor → 400" ve "state TEK KULLANIMLIK → ikinci çağrı 400"
 * testleri dosyanın omurgasıdır; biri kırılırsa güvenlik açığı vardır.
 *
 * `createHarness` `authProviders`/`cipher` GEÇİRMEZ (ortak kurulum
 * `test/http/helpers.ts` KORUMALIDIR). Bu yüzden bu dosya `harness.repos`
 * üzerine `buildServer` ile kendi sunucusunu kurar ve `harness`'in saatini,
 * veritabanını ve deposunu paylaşır: port açılmaz, ikinci bir veritabanı
 * dosyası oluşmaz.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/http/index.js";
import { loadConfig } from "../../src/config/index.js";
import type { Platform } from "../../src/contract/index.js";
import { PermanentPublishError } from "../../src/ports/index.js";
import type { AuthProvider } from "../../src/ports/index.js";
import {
  createHarness,
  errorOf,
  type Harness,
} from "./helpers.js";

const PAROLA = "test-parola-1234";

let h: Harness;

// ── Sahte sağlayıcı ────────────────────────────────────────────────────────

interface ExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  externalId: string;
  username: string | null;
  displayName: string;
  scopes: string[];
  linkedPageId?: string | null;
}

interface FakeProviderCalls {
  authorizeUrl: Array<{ state: string; redirectUri: string; scopes: string[] }>;
  exchangeCode: Array<{ code: string; state: string; redirectUri: string }>;
}

/**
 * `AuthProvider` sahtesi. `authorizeUrl` gerçek sağlayıcılarla AYNI biçimde
 * davranır: `state`'i adrese koyar. Test bu sayede `state`'i URL'den okuyup
 * geri çağırmaya gönderebilir — `state`'i elle uydurmak, "biz ürettiğimiz
 * `state` ile dönüyoruz mu" sorusunu test edemezdi.
 */
class FakeProvider implements AuthProvider {
  readonly calls: FakeProviderCalls = { authorizeUrl: [], exchangeCode: [] };
  /** `exchangeCode` sonucu. Çağrı sayısına göre değiştirilebilir. */
  result: ExchangeResult | null = null;
  /** Verilirse `exchangeCode` bu hatayı fırlatır (ağ çağrısı YOK). */
  failWith: Error | null = null;

  constructor(readonly platform: Platform) {}

  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string {
    this.calls.authorizeUrl.push({ state, redirectUri, scopes });
    const url = new URL(`https://sahte.test/${this.platform}/authorize`);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<ExchangeResult> {
    this.calls.exchangeCode.push({ ...input });
    if (this.failWith !== null) throw this.failWith;
    if (this.result === null) throw new Error("test: exchangeCode sonucu ayarlanmamış");
    return this.result;
  }
}

function baseResult(over: Partial<ExchangeResult> = {}): ExchangeResult {
  return {
    accessToken: "gizli-erisim-belirteci",
    refreshToken: "gizli-yenileme-belirteci",
    expiresAt: "2030-01-01T00:00:00.000Z",
    externalId: "kanal-123",
    username: "kanal",
    displayName: "Kanalım",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    ...over,
  };
}

// ── Kurulum ────────────────────────────────────────────────────────────────

interface Ctx {
  server: Awaited<ReturnType<typeof buildServer>>["server"];
  /** Oturum açar ve `sp_session` çerezini döndürür. */
  login(): Promise<string>;
  providerFor(platform: Platform): FakeProvider;
}

/**
 * `harness` üzerine hesap bağlama bağımlılıklarıyla ikinci bir sunucu kurar.
 *
 * Neden `createHarness`'ın sunucusu değil: `helpers.ts` korumalı ve
 * `buildServer`'a `authProviders`/`cipher` geçmiyor. Yeni sunucu AYNI veritabanı
 * dosyasını, AYNI `repos`'u ve AYNI `MutableClock`'u kullanır — bu yüzden
 * `harness.close()` temizlik yaparken ikinci sunucuyu ayrıca kapatmamız yeter.
 */
async function createOAuthCtx(opts: {
  /** Bu platformların `.env` anahtarları TANIMLANMAZ. */
  withoutKeys?: Platform[];
  /** Sağlayıcı HARİTADA BULUNMAZ (anahtarlar dolu olsa bile). */
  withoutProvider?: Platform[];
  /** Yalnız yönlendirme adresi eksik (client id/secret dolu). */
  withoutRedirectUri?: Platform[];
  withoutCipher?: boolean;
  platforms?: Platform[];
} = {}): Promise<Ctx> {
  const platforms = opts.platforms ?? ["youtube"];
  const without = new Set(opts.withoutKeys ?? []);
  const noProvider = new Set(opts.withoutProvider ?? []);
  const noRedirect = new Set(opts.withoutRedirectUri ?? []);
  const providers = new Map<Platform, AuthProvider>();
  const fakes = new Map<Platform, FakeProvider>();
  for (const platform of platforms) {
    const fake = new FakeProvider(platform);
    fakes.set(platform, fake);
    // Anahtarları eksik ya da sağlayıcısı montajlanmamış platformun
    // sağlayıcısı HARİTADA BULUNMAZ. Bu tam olarak `main.ts` davranışıdır:
    // `isConfigured` false ise sağlayıcı kurulmaz ve `/start` 503 döner.
    if (!without.has(platform) && !noProvider.has(platform)) providers.set(platform, fake);
  }

  // Yapılandırma `testConfig` ile üretilemez (`helpers.ts` korumalı ve
  // platform anahtarlarını kabul etmiyor). Aynı `AppConfig` ÜRETİCİSİ
  // (`loadConfig`) kullanılır; yalnız `SP_*` sağlayıcı anahtarları eklenir.
  const env: Record<string, string> = {
    NODE_ENV: "test",
    SP_DATA_DIR: h.dir,
    SP_STORAGE_DIR: `${h.dir}/storage`,
    SP_DATABASE_FILE: `${h.dir}/data/publisher.db`,
    SP_MASTER_KEY: h.config.masterKey ?? "",
    SP_ADMIN_PASSWORD: PAROLA,
    SP_TIMEZONE: "Europe/Istanbul",
    SP_SCHEDULER_TICK_MS: "15000",
    SP_LOG_LEVEL: "silent",
  };
  if (!without.has("youtube")) {
    env["SP_GOOGLE_CLIENT_ID"] = "google-id.apps.googleusercontent.com";
    env["SP_GOOGLE_CLIENT_SECRET"] = "google-secret";
  }
  if (!without.has("youtube") && !noRedirect.has("youtube")) {
    env["SP_GOOGLE_REDIRECT_URI"] = "https://ornek.test/api/v1/auth/youtube/callback";
  }
  if (!without.has("instagram")) {
    env["SP_META_APP_ID"] = "meta-app-id";
    env["SP_META_APP_SECRET"] = "meta-secret";
    env["SP_META_REDIRECT_URI"] = "https://ornek.test/auth/meta/callback";
  }
  if (!without.has("tiktok")) {
    env["SP_TIKTOK_CLIENT_KEY"] = "tiktok-key";
    env["SP_TIKTOK_CLIENT_SECRET"] = "tiktok-secret";
    env["SP_TIKTOK_REDIRECT_URI"] = "https://ornek.test/api/v1/auth/tiktok/callback";
  }
  const config = loadConfig(env);

  const built = await buildServer({
    config,
    db: h.db,
    repos: h.repos,
    store: h.store,
    probe: h.ffmpeg,
    ingest: h.ingest,
    publisher: h.publisher,
    scheduler: h.scheduler,
    clock: h.clock,
    mediaSecret: h.mediaSecret,
    logsEnabled: false,
    authProviders: providers,
    // `cipher: null` → callback 503 döner ve hesap OLUŞTURMAZ. Testin konusu
    // tam olarak bu: `test/http/helpers.ts` `cipher`'ı geçemediği için burada
    // doğrudan verilir.
    cipher: opts.withoutCipher === true ? null : h.cipher,
  });

  const server = built.server;
  // `buildServer` her çağrıda KENDİ oturum deposu kurar; aynı dosyadaki ikinci
  // sunucu birincinin çerezini kabul etmez. Test sonunda hepsi kapanır.
  servers.push(server);

  return {
    server,
    providerFor(platform) {
      const fake = fakes.get(platform);
      if (!fake) throw new Error(`test: ${platform} sağlayıcısı kurulmadı`);
      return fake;
    },
    async login() {
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "https://ornek.test", host: "ornek.test" },
        payload: { password: PAROLA },
      });
      if (res.statusCode !== 200) {
        throw new Error(`giriş başarısız (${res.statusCode}): ${res.payload}`);
      }
      const raw = res.headers["set-cookie"];
      const joined = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
      return joined.split(";")[0] ?? "";
    },
  };
}

const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  h = await createHarness({ adminPassword: PAROLA });
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close().catch(() => undefined);
  }
  await h.close();
});

// ── Yardımcılar ────────────────────────────────────────────────────────────

/** `start` → 200 zarfı ve `url`. */
async function start(
  ctx: Ctx,
  platform: Platform,
  cookie: string,
): Promise<{ url: string; status: number }> {
  const res = await ctx.server.inject({
    method: "GET",
    url: `/api/v1/auth/${platform}/start`,
    headers: { host: "ornek.test", cookie },
  });
  if (res.statusCode !== 200) {
    throw new Error(`start beklenmeyen durum (${res.statusCode}): ${res.payload}`);
  }
  const body = JSON.parse(res.payload) as { ok: boolean; data?: { url?: string } };
  return { url: String(body.data?.url ?? ""), status: res.statusCode };
}

interface CallbackResponse {
  statusCode: number;
  location: string;
  payload: string;
}

async function callback(
  ctx: Ctx,
  platform: Platform,
  query: { code?: string; state?: string },
  cookie: string,
): Promise<CallbackResponse> {
  const search = new URLSearchParams();
  if (query.code !== undefined) search.set("code", query.code);
  if (query.state !== undefined) search.set("state", query.state);
  const url = `/api/v1/auth/${platform}/callback${search.size > 0 ? `?${search}` : ""}`;
  const res = await ctx.server.inject({
    method: "GET",
    url,
    headers: { host: "ornek.test", cookie },
  });
  return {
    statusCode: res.statusCode,
    location: String(res.headers["location"] ?? ""),
    payload: res.payload,
  };
}

/** Tam başarılı akış: oturum → start → callback. `state` URL'den okunur. */
async function link(
  ctx: Ctx,
  platform: Platform,
  cookie: string,
): Promise<{ location: string; status: number }> {
  const { url } = await start(ctx, platform, cookie);
  const state = new URL(url).searchParams.get("state") ?? "";
  const done = await callback(ctx, platform, { code: "yetki-kodu", state }, cookie);
  return { location: done.location, status: done.statusCode };
}

// ── start ucu ──────────────────────────────────────────────────────────────

describe("GET /api/v1/auth/:platform/start", () => {
  it("oturumsuz istek 401 döner", async () => {
    const ctx = await createOAuthCtx();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/youtube/start",
      headers: { host: "ornek.test" },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).code).toBe("unauthorized");
  });

  it("sağlayıcı bağlı değilse 503 döner ve EKSİK ANAHTAR ADINI söyler", async () => {
    // `youtube` sağlayıcısı haritada AMA yapılandırma anahtarları eksik:
    // kullanıcı "hangi anahtarı yazmalıyım" sorusunun cevabını almalı.
    const ctx = await createOAuthCtx({ withoutKeys: ["youtube"] });
    const cookie = await ctx.login();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/youtube/start",
      headers: { host: "ornek.test", cookie },
    });
    expect(res.statusCode).toBe(503);
    const error = errorOf(res.payload);
    expect(error.code).toBe("not_configured");
    // Eksik anahtar ADLARI mesajda geçmeli (kurulum raporunun kendisiyle aynı).
    expect(error.message).toContain("SP_GOOGLE_CLIENT_ID");
  });

  it("bilinmeyen platform 400 validation_failed döner", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/bluesky/start",
      headers: { host: "ornek.test", cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("oturumla 200 döner ve `url` yetkilendirme adresidir", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const { url, status } = await start(ctx, "youtube", cookie);
    expect(status).toBe(200);
    expect(url).toContain("authorize");
    // Zarf sözlüğü `state`'in adrese girdiğini kanıtlar.
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBeTruthy();
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://ornek.test/api/v1/auth/youtube/callback",
    );
  });

  it("üretilen `state` sağlayıcıya aynen iletilir (saklama ile gönderme eşleşir)", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const sent = new URL(url).searchParams.get("state");
    const calls = ctx.providerFor("youtube").calls.authorizeUrl;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe(sent);
  });

  it("her `start` FARKLI bir `state` üretir (tekrar kullanılabilir değil)", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const first = await start(ctx, "youtube", cookie);
    const second = await start(ctx, "youtube", cookie);
    const a = new URL(first.url).searchParams.get("state");
    const b = new URL(second.url).searchParams.get("state");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("analitik kapsamları yetkilendirme adresine eklenir (ölçüm aksi hâlde hep `no_scope`)", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const scope = new URL(url).searchParams.get("scope") ?? "";
    expect(scope).toContain("yt-analytics.readonly");
  });

  it("yönlendirme adresi tanımlı değilse 503 döner (boş adres üretilmez)", async () => {
    // Anahtar tamamen tanımlanmadığında `config.youtube.redirectUri === null`
    // olur. Bu sunucu KENDİ oturum deposuna sahip olduğu için giriş de ona
    // yapılır (çerez `buildServer` başına benzersizdir).
    const ctx = await createOAuthCtx({ withoutRedirectUri: ["youtube"] });
    const cookie = await ctx.login();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/youtube/start",
      headers: { host: "ornek.test", cookie },
    });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res.payload).code).toBe("not_configured");
    expect(errorOf(res.payload).message).toContain("SP_GOOGLE_REDIRECT_URI");
    // Sağlayıcıya UĞRAMADI: geçersiz adres hiç üretilmedi.
    expect(ctx.providerFor("youtube").calls.authorizeUrl).toHaveLength(0);
  });

  it("anahtarlar dolu ama sağlayıcı bağlı değilse mesaj bunu DÜRÜSTÇE söyler", async () => {
    // `main.ts` yalnız `isConfigured` doğruysa sağlayıcıyı haritaya koyar.
    // Sağlayıcı yokken mesaj "eksik anahtar" DİLMEZ: kullanıcı .env'i kontrol
    // edip dakikalar harcar, oysa sorun başka yerde.
    const ctx = await createOAuthCtx({ withoutProvider: ["youtube"] });
    const cookie = await ctx.login();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/youtube/start",
      headers: { host: "ornek.test", cookie },
    });
    expect(res.statusCode).toBe(503);
    const message = errorOf(res.payload).message;
    expect(message).toContain("bağlı değil");
    expect(message).toContain("Eksik anahtar yok");
  });
});

// ── callback: CSRF kapıları ────────────────────────────────────────────────

describe("GET /api/v1/auth/:platform/callback — CSRF", () => {
  it("BİLİNMEYEN `state` → 400 ve HESAP OLUŞMAZ (en kritik kapı)", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    // `start` bile çağrılmadı: saldırgan kendi kodunu kendi `state`'iyle
    // gönderiyor.
    const res = await callback(ctx, "youtube", { code: "saldirgan-kodu", state: "bilinmeyen" }, cookie);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
    // Sağlayıcıya HİÇ UĞRAMADI: CSRF kabul edilseydi burada kod değişimi olurdu.
    expect(ctx.providerFor("youtube").calls.exchangeCode).toHaveLength(0);
    expect(h.repos.accounts.listByPlatform("youtube", 10)).toHaveLength(0);
  });

  it("`state` TEK KULLANIMLIK: aynı `state` ile ikinci çağrı 400", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";

    const first = await callback(ctx, "youtube", { code: "kod", state }, cookie);
    expect(first.statusCode).toBe(303);

    const second = await callback(ctx, "youtube", { code: "kod", state }, cookie);
    expect(second.statusCode).toBe(400);
    expect(errorOf(second.payload).code).toBe("validation_failed");
  });

  it("süresi dolmuş `state` → 400 (10 dakika kuralı)", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";

    // `MutableClock` ileri sarılır: 10 dakika + 1 ms.
    h.clock.advance(10 * 60_000 + 1);
    const res = await callback(ctx, "youtube", { code: "kod", state }, cookie);
    expect(res.statusCode).toBe(400);
    expect(ctx.providerFor("youtube").calls.exchangeCode).toHaveLength(0);
    expect(h.repos.accounts.listByPlatform("youtube", 10)).toHaveLength(0);
  });

  it("süresi dolmamış `state` (tam 10 dakika) kabul edilir", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";
    h.clock.advance(10 * 60_000 - 5_000);
    const res = await callback(ctx, "youtube", { code: "kod", state }, cookie);
    expect(res.statusCode).toBe(303);
  });

  it("`state`'i BAŞLATICISINDAN FARKLI oturum → 400", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const starter = await ctx.login();
    const { url } = await start(ctx, "youtube", starter);
    const state = new URL(url).searchParams.get("state") ?? "";

    // Farklı bir oturum: aynı parola, farklı çerez. CSRF'nin ikinci yarısı.
    const other = await ctx.login();
    expect(other).not.toBe(starter);

    const res = await callback(ctx, "youtube", { code: "kod", state }, other);
    expect(res.statusCode).toBe(400);
    expect(ctx.providerFor("youtube").calls.exchangeCode).toHaveLength(0);
  });

  it("oturumsuz geri çağırma 401 döner", async () => {
    const ctx = await createOAuthCtx();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/youtube/callback?code=k&state=s",
      headers: { host: "ornek.test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("`code` yoksa 400 validation_failed", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";
    const res = await callback(ctx, "youtube", { state }, cookie);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("`state` yoksa 400 validation_failed", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const res = await callback(ctx, "youtube", { code: "kod" }, cookie);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });

  it("`state` başka platforma aitse 400", async () => {
    const ctx = await createOAuthCtx({ platforms: ["youtube", "instagram"] });
    ctx.providerFor("instagram").result = baseResult({ externalId: "ig-1" });
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";
    const res = await callback(ctx, "instagram", { code: "kod", state }, cookie);
    expect(res.statusCode).toBe(400);
    expect(ctx.providerFor("instagram").calls.exchangeCode).toHaveLength(0);
  });
});

// ── callback: hesap + belirteç kaydı ────────────────────────────────────────

describe("GET /api/v1/auth/:platform/callback — hesap kaydı", () => {
  it("başarılı akış hesap + kimlik kaydı açar ve 303 ile panele döner", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();

    const { status, location } = await link(ctx, "youtube", cookie);
    expect(status).toBe(303);
    // Panel hash rotası: `web/src/lib/router.ts` `location.hash` okur.
    expect(location.startsWith("/#/accounts?")).toBe(true);
    expect(location).toContain("linked=youtube");
    expect(location).toContain("ok=1");

    const accounts = h.repos.accounts.listByPlatform("youtube", 10);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.externalId).toBe("kanal-123");
    expect(accounts[0]?.displayName).toBe("Kanalım");
    expect(accounts[0]?.status).toBe("active");

    const credential = h.repos.credentials.getByAccountId(accounts[0]!.id);
    expect(credential).not.toBeNull();
    expect(credential?.providerUserId).toBe("kanal-123");
    expect(credential?.tokenExpiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(credential?.scopes).toEqual(["https://www.googleapis.com/auth/youtube.upload"]);
  });

  it("erişim belirteci DÜZ METİN SAKLANMAZ: kutu açılınca token çıkar", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult({ accessToken: "duz-metin-token" });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    const accounts = h.repos.accounts.listByPlatform("youtube", 10);
    const credential = h.repos.credentials.getByAccountId(accounts[0]!.id);
    const sealed = credential?.accessTokenEnc ?? "";
    expect(sealed).not.toBe("");
    // Sütunda token metni YOK.
    expect(sealed).not.toContain("duz-metin-token");
    // Kutu biçimi sözleşmesi: `v1:<nonce>:<tag>:<ciphertext>`.
    expect(sealed.split(":")).toHaveLength(4);
    // Yalnız doğru anahtarla açılır ve içinden token çıkar.
    expect(h.cipher?.open(sealed)).toBe("duz-metin-token");
  });

  it("yenileme belirteci de şifreli saklanır", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult({ refreshToken: "duz-refresh" });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);
    const accounts = h.repos.accounts.listByPlatform("youtube", 10);
    const credential = h.repos.credentials.getByAccountId(accounts[0]!.id);
    expect(credential?.refreshTokenEnc ?? "").not.toContain("duz-refresh");
    expect(h.cipher?.open(credential!.refreshTokenEnc!)).toBe("duz-refresh");
  });

  it("`redirect_uri` başlangıçta gönderilenle AYNI olmak zorundadır", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    const fake = ctx.providerFor("youtube");
    expect(fake.calls.authorizeUrl[0]?.redirectUri).toBe(
      "https://ornek.test/api/v1/auth/youtube/callback",
    );
    expect(fake.calls.exchangeCode[0]?.redirectUri).toBe(
      "https://ornek.test/api/v1/auth/youtube/callback",
    );
  });

  it("MÜKERRER HESAP OLUŞMAZ: aynı `externalId` ikinci kez bağlanırsa GÜNCELLER", async () => {
    const ctx = await createOAuthCtx();
    const fake = ctx.providerFor("youtube");
    fake.result = baseResult({ displayName: "İlk Ad", username: "ilk" });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    fake.result = baseResult({ displayName: "Yeni Ad", username: "yeni" });
    const second = await link(ctx, "youtube", cookie);
    expect(second.status).toBe(303);

    const accounts = h.repos.accounts.listByPlatform("youtube", 10);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.displayName).toBe("Yeni Ad");
    expect(accounts[0]?.username).toBe("yeni");
    // Kimlik kaydı da güncellendi (tek satır, upsert).
    expect(h.repos.credentials.listByPlatform("youtube")).toHaveLength(1);
  });

  it("`refreshToken: null` dönünce ESKİ yenileme belirteci KORUNUR", async () => {
    const ctx = await createOAuthCtx();
    const fake = ctx.providerFor("youtube");
    fake.result = baseResult({ refreshToken: "ilk-refresh" });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    const accountId = h.repos.accounts.listByPlatform("youtube", 10)[0]!.id;
    const before = h.repos.credentials.getByAccountId(accountId)?.refreshTokenEnc;

    // Meta her zaman, Google çoğu zaman `null` döner: "yenisi yok, koru".
    fake.result = baseResult({ refreshToken: null, accessToken: "yeni-token" });
    await link(ctx, "youtube", cookie);

    const after = h.repos.credentials.getByAccountId(accountId);
    expect(after?.refreshTokenEnc).toBe(before);
    // Erişim belirteci yine de yenilendi.
    expect(h.cipher?.open(after!.accessTokenEnc)).toBe("yeni-token");
  });

  it("`expiresAt: null` dönünce alan null yazılır (uydurma tarih yok)", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult({ expiresAt: null });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);
    const accountId = h.repos.accounts.listByPlatform("youtube", 10)[0]!.id;
    expect(h.repos.credentials.getByAccountId(accountId)?.tokenExpiresAt).toBeNull();
  });

  it("denetime `account.linked` yazılır ama TOKEN YAZILMAZ", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult({ accessToken: "gizli-token" });
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    // Denetim deposunun KENDİ okuma yüzeyi kullanılır (doğrudan SQL değil):
    // sütun adları (`detail_json`) gövde sözleşmesidir ve test onu da
    // kilitlememeli.
    const rows = h.repos.audit.listByAction("account.linked", 10);
    expect(rows).toHaveLength(1);
    const accountId = h.repos.accounts.listByPlatform("youtube", 10)[0]!.id;
    expect(rows[0]?.targetId).toBe(accountId);
    expect(rows[0]?.detail).toMatchObject({ platform: "youtube" });
    // Token DENETİMDE YOK. Hem ayrı alan hem de tüm JSON metni denetlenir.
    expect(JSON.stringify(rows[0]?.detail ?? {})).not.toContain("gizli-token");
  });

  it("denetime `state` YAZILMAZ (CSRF sırrı loglanmaz)", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").result = baseResult();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";
    await callback(ctx, "youtube", { code: "kod", state }, cookie);

    const rows = h.repos.audit.listByAction("auth.start", 10);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.detail ?? {})).not.toContain(state);
  });
});

// ── callback: şifre çözücü ve hata yolu ─────────────────────────────────────

describe("GET /api/v1/auth/:platform/callback — hata yolu", () => {
  it("`cipher` null ise 503 döner ve HESAP KAYDI OLUŞTURULMAZ", async () => {
    const ctx = await createOAuthCtx({ withoutCipher: true });
    const fake = ctx.providerFor("youtube");
    fake.result = baseResult();
    const cookie = await ctx.login();
    const { url } = await start(ctx, "youtube", cookie);
    const state = new URL(url).searchParams.get("state") ?? "";

    const res = await callback(ctx, "youtube", { code: "kod", state }, cookie);
    expect(res.statusCode).toBe(503);
    const error = errorOf(res.payload);
    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("SP_MASTER_KEY");

    // EN ÖNEMLİ KISIM: şifrelenemeyen belirteçle hesap açılmaz.
    expect(h.repos.accounts.listByPlatform("youtube", 10)).toHaveLength(0);
    // Sağlayıcıya da gidilmedi: kod değişimi yapılmadı.
    expect(fake.calls.exchangeCode).toHaveLength(0);
  });

  it("sağlayıcı hata verirse 303 döner ve Location'da KISA KOD vardır", async () => {
    const ctx = await createOAuthCtx();
    const fake = ctx.providerFor("youtube");
    fake.failWith = new PermanentPublishError("invalid_grant: kod süresi dolmuş", "auth", "invalid_grant");
    const cookie = await ctx.login();

    const { status, location } = await link(ctx, "youtube", cookie);
    expect(status).toBe(303);
    expect(location).toContain("linked=youtube");
    expect(location).toContain("error=");
    expect(h.repos.accounts.listByPlatform("youtube", 10)).toHaveLength(0);
  });

  it("hata Location'ında TOKEN veya SECRET YOKTUR", async () => {
    const ctx = await createOAuthCtx();
    const fake = ctx.providerFor("youtube");
    fake.failWith = new PermanentPublishError(
      "token değişimi başarısız: gizli-hata-metni",
      "auth",
      "invalid_grant",
    );
    const cookie = await ctx.login();
    const { location } = await link(ctx, "youtube", cookie);

    // Sağlayıcının hata metni URL'de olmamalı: proxy günlüğü ve tarayıcı
    // geçmişine sızar.
    expect(location).not.toContain("gizli-hata-metni");
    expect(location).not.toContain("invalid_grant");
    expect(location).not.toContain("token");
    expect(location).not.toContain("secret");
    // Yalnız kısa kod: `error=` değeri `auth_failed` gibi bir makine kodu.
    // `URL` yerine elle ayrıştırılır: `/#/accounts?...` bir HASH rotasıdır ve
    // `new URL()` sorguyu `searchParams` içinde değil, hash'in içinde bulur.
    const query = location.slice(location.indexOf("?") + 1);
    const error = new URLSearchParams(query).get("error") ?? "";
    expect(error).toMatch(/^[a-z_]+$/);
  });

  it("hata durumunda denetime `account.link_failed` yazılır", async () => {
    const ctx = await createOAuthCtx();
    ctx.providerFor("youtube").failWith = new PermanentPublishError("çöktü", "auth", "invalid_grant");
    const cookie = await ctx.login();
    await link(ctx, "youtube", cookie);

    const rows = h.repos.audit.listByAction("account.link_failed", 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("bilinmeyen platform callback'te 400 döner", async () => {
    const ctx = await createOAuthCtx();
    const cookie = await ctx.login();
    const res = await ctx.server.inject({
      method: "GET",
      url: "/api/v1/auth/twitch/callback?code=k&state=s",
      headers: { host: "ornek.test", cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).code).toBe("validation_failed");
  });
});