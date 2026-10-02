/**
 * TikTok OAuth testleri.
 *
 * HİÇBİR TEST AĞA ÇIKMAZ: taşıma `fixtures.ts`'teki sahte işlevdir.
 *
 * Beş kanıt sütunu:
 *   1) YETKİLENDİRME ADRESİ — `client_key`, `response_type=code`, `state`,
 *      YÜZDELİK KODLANMIŞ virgüllü kapsamlar.
 *   2) REDIRECT URI KURALI — yalnız https, fragment yok, <512 karakter.
 *   3) KOD DEĞİŞİMİ — gövde `application/x-www-form-urlencoded`, `open_id` →
 *      `externalId`, `refresh_token` aynen geçer.
 *   4) YENİLEME — dönen `refresh_token` **AYNEN** iletilir; yoksa `null`
 *      (koru), uydurma değer üretilmez.
 *   5) CSRF — `state` uyuşmazlığında HİÇBİR ağ çağrısı yapılmaz.
 */
import { describe, expect, it } from "vitest";
import {
  TIKTOK_AUTHORIZE_BASE,
  TIKTOK_SCOPES,
  TIKTOK_TOKEN_BASE,
} from "../../../src/adapters/tiktok/publisher.js";
import {
  TikTokAuth,
  expiryIso,
  parseScopes,
  redirectUriProblem,
  requiredScopes,
} from "../../../src/adapters/tiktok/auth.js";
import { NOW_MS, transport, type RecordedCall } from "./fixtures.js";

const REDIRECT = "https://app.example.test/oauth/tiktok/callback";
const CONFIG = { clientKey: "aw1234567890", clientSecret: "s3cret", redirectUri: REDIRECT };

const TOKEN_OK = {
  code: 0,
  message: "success",
  data: {
    access_token: "TT_ACCESS_24h",
    refresh_token: "TT_REFRESH_365d_FIRST",
    expires_in: 86_400,
    refresh_expires_in: 31_536_000,
    open_id: "oc_9f8e7d6c5b4a3210",
    scope: "video.publish,user.info.basic",
    display_name: "Marka Hesabı",
    avatar_url: "https://p16.example.test/avatar.jpg",
  },
};

function auth(responses: Parameters<typeof transport>[0], over: { expectedState?: string } = {}) {
  const { fn, calls } = transport(responses);
  const provider = new TikTokAuth(CONFIG, {
    now: () => NOW_MS,
    fetch: fn,
    ...(over.expectedState === undefined ? {} : { expectedState: over.expectedState }),
  });
  return { provider, calls };
}

function form(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body ?? "").entries());
}

// ── 1) Yetkilendirme adresi ─────────────────────────────────────────────────

describe("authorizeUrl", () => {
  const url = new URL(
    new TikTokAuth(CONFIG, { now: () => NOW_MS, fetch: transport([]).fn }).authorizeUrl(
      "state-abc",
      REDIRECT,
      [],
    ),
  );

  it("doğru kök ve yol", () => {
    expect(url.origin).toBe(TIKTOK_AUTHORIZE_BASE);
    expect(url.pathname).toBe("/v2/auth/authorize/");
  });

  it("client_key, response_type=code ve state taşır", () => {
    expect(url.searchParams.get("client_key")).toBe(CONFIG.clientKey);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("kapsamlar virgüllü ve URL-KODLANMIŞ gelir", () => {
    expect(url.search).toContain("video.publish%2Cuser.info.basic");
    expect(url.searchParams.get("scope")).toBe(TIKTOK_SCOPES.join(","));
  });

  it("çağıranın eklediği kapsam zorunlu kümenin sonuna eklenir", () => {
    const merged = requiredScopes(["video.list", "video.publish"]);
    expect(merged).toEqual(["video.publish", "user.info.basic", "video.list"]);
  });
});

// ── 2) Redirect URI kuralı ──────────────────────────────────────────────────

describe("redirectUriProblem", () => {
  it("https, fragment'siz, 512 karakterden kısa adresler geçerli", () => {
    expect(redirectUriProblem(REDIRECT)).toBeNull();
  });

  it("http adresleri REDDEDİLİR (localhost dahil)", () => {
    expect(redirectUriProblem("http://localhost:3000/cb")).toContain("https");
    expect(redirectUriProblem("http://app.example.test/cb")).toContain("https");
  });

  it("fragment içeren adres reddedilir", () => {
    expect(redirectUriProblem(`${REDIRECT}#x`)).toContain("fragment");
  });

  it("512 karakterden uzun adres reddedilir", () => {
    expect(redirectUriProblem(`https://app.example.test/${"a".repeat(520)}`)).toContain("512");
  });

  it("boş/geçersiz adres reddedilir", () => {
    expect(redirectUriProblem("")).toContain("boş");
    expect(redirectUriProblem(null)).toContain("boş");
    expect(redirectUriProblem("https://")).toContain("URL");
  });

  it("geçersiz redirect URI authorizeUrl'de KALICI hata verir", () => {
    const provider = new TikTokAuth(CONFIG, { now: () => NOW_MS, fetch: transport([]).fn });
    expect(() => provider.authorizeUrl("s", "http://localhost/cb", [])).toThrow(
      /redirect URI geçersiz/,
    );
  });
});

// ── 3) Kod değişimi ─────────────────────────────────────────────────────────

describe("exchangeCode", () => {
  it("token ucuna form-encoded authorization_code gönderir", async () => {
    const { provider, calls } = auth([{ status: 200, body: TOKEN_OK }]);
    await provider.exchangeCode({ code: "AUTH_CODE", state: "s", redirectUri: REDIRECT });
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${TIKTOK_TOKEN_BASE}/v2/oauth/token/`);
    expect(call.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(form(call)).toEqual({
      grant_type: "authorization_code",
      client_key: CONFIG.clientKey,
      client_secret: CONFIG.clientSecret,
      code: "AUTH_CODE",
      redirect_uri: REDIRECT,
    });
  });

  it("open_id externalId olur", async () => {
    const { provider } = auth([{ status: 200, body: TOKEN_OK }]);
    const result = await provider.exchangeCode({ code: "c", state: "s", redirectUri: REDIRECT });
    expect(result.externalId).toBe("oc_9f8e7d6c5b4a3210");
    expect(result.displayName).toBe("Marka Hesabı");
    expect(result.username).toBeNull();
  });

  it("refresh_token (365 gün) aynen geçer, expiresAt = now + 24 saat", async () => {
    const { provider } = auth([{ status: 200, body: TOKEN_OK }]);
    const result = await provider.exchangeCode({ code: "c", state: "s", redirectUri: REDIRECT });
    expect(result.refreshToken).toBe("TT_REFRESH_365d_FIRST");
    expect(result.accessToken).toBe("TT_ACCESS_24h");
    expect(result.expiresAt).toBe(new Date(NOW_MS + 86_400_000).toISOString());
  });

  it("kapsamlar virgülle ayrılmış metinden gelir", async () => {
    const { provider } = auth([{ status: 200, body: TOKEN_OK }]);
    const result = await provider.exchangeCode({ code: "c", state: "s", redirectUri: REDIRECT });
    expect(result.scopes).toEqual(["video.publish", "user.info.basic"]);
    expect(parseScopes("video.publish, user.info.basic")).toEqual([
      "video.publish",
      "user.info.basic",
    ]);
    expect(parseScopes(null)).toEqual([]);
  });

  it("open_id yoksa kalıcı auth hatası", async () => {
    const { provider } = auth([{ status: 200, body: { code: 0, data: { access_token: "x" } } }]);
    await expect(
      provider.exchangeCode({ code: "c", state: "s", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "missing_open_id" });
  });

  it("invalid_grant kalıcı auth hatası verir", async () => {
    const { provider } = auth([
      {
        status: 400,
        body: { error: "invalid_grant", error_description: "code expired", log_id: "L1" },
      },
    ]);
    await expect(
      provider.exchangeCode({ code: "c", state: "s", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ name: "PermanentPublishError", kind: "auth", logId: "L1" });
  });

  it("state uyuşmazlığında HİÇBİR ağ çağrısı yapılmaz", async () => {
    const { provider, calls } = auth([{ status: 200, body: TOKEN_OK }], { expectedState: "dogru" });
    await expect(
      provider.exchangeCode({ code: "c", state: "baska", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "state_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("geçersiz redirect URI ile token isteği ATILMAZ", async () => {
    const { provider, calls } = auth([{ status: 200, body: TOKEN_OK }]);
    await expect(
      provider.exchangeCode({ code: "c", state: "s", redirectUri: "http://localhost/cb" }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(0);
  });
});

// ── 4) Yenileme ─────────────────────────────────────────────────────────────

describe("refresh", () => {
  const ROTATED = {
    code: 0,
    data: {
      access_token: "TT_ACCESS_24h_NEW",
      refresh_token: "TT_REFRESH_ROTATED",
      expires_in: 86_400,
      open_id: "oc_9f8e7d6c5b4a3210",
    },
  };

  it("grant_type=refresh_token gönderilir", async () => {
    const { provider, calls } = auth([{ status: 200, body: ROTATED }]);
    await provider.refresh("TT_REFRESH_365d_FIRST");
    expect(form(calls[0] as RecordedCall)).toEqual({
      grant_type: "refresh_token",
      client_key: CONFIG.clientKey,
      client_secret: CONFIG.clientSecret,
      refresh_token: "TT_REFRESH_365d_FIRST",
    });
  });

  it("dönen refresh_token AYEN iletilir (eski geçersizleşir)", async () => {
    const { provider } = auth([{ status: 200, body: ROTATED }]);
    const outcome = await provider.refresh("TT_REFRESH_365d_FIRST");
    expect(outcome.refreshToken).toBe("TT_REFRESH_ROTATED");
    expect(outcome.refreshToken).not.toBe("TT_REFRESH_365d_FIRST");
    expect(outcome.accessToken).toBe("TT_ACCESS_24h_NEW");
    expect(outcome.expiresAt).toBe(new Date(NOW_MS + 86_400_000).toISOString());
  });

  it("yanıtta refresh_token yoksa null (koru) — uydurma üretilmez", async () => {
    const { provider } = auth([
      { status: 200, body: { code: 0, data: { access_token: "NEW", expires_in: 86_400 } } },
    ]);
    const outcome = await provider.refresh("TT_REFRESH_365d_FIRST");
    expect(outcome.refreshToken).toBeNull();
  });

  it("accountChanged karşılaştırılacak hedef olmadığı için false", async () => {
    const { provider } = auth([{ status: 200, body: ROTATED }]);
    expect((await provider.refresh("TT_REFRESH_365d_FIRST")).accountChanged).toBe(false);
  });

  it("boş refresh token kalıcı auth hatası verir (ağ çağrısı yok)", async () => {
    const { provider, calls } = auth([{ status: 200, body: ROTATED }]);
    await expect(provider.refresh("   ")).rejects.toMatchObject({
      kind: "auth",
      providerCode: "no_stored_token",
    });
    expect(calls).toHaveLength(0);
  });

  it("invalid_grant yenilemede de kalıcı auth hatası", async () => {
    const { provider } = auth([
      { status: 400, body: { error: "invalid_grant", error_description: "expired" } },
    ]);
    await expect(provider.refresh("OLD")).rejects.toMatchObject({ kind: "auth" });
  });
});

// ── 5) Yardımcılar ──────────────────────────────────────────────────────────

describe("expiryIso", () => {
  it("saniye değerini ISO'ya çevirir", () => {
    expect(expiryIso(3600, NOW_MS)).toBe("2026-08-24T13:00:00.000Z");
  });

  it("metin biçimindeki sayıyı da kabul eder", () => {
    expect(expiryIso("3600", NOW_MS)).toBe("2026-08-24T13:00:00.000Z");
  });

  it("geçersiz/eksik değerde null döner (uydurma yok)", () => {
    expect(expiryIso(undefined, NOW_MS)).toBeNull();
    expect(expiryIso(0, NOW_MS)).toBeNull();
    expect(expiryIso("abc", NOW_MS)).toBeNull();
  });
});
