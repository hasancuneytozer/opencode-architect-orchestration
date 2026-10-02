/**
 * TikTok OAuth 2.0 — Content Posting API kimlik akışı.
 *
 * ── DOĞRULANMIŞ UÇLAR (resmî doküman, 24 Ağustos 2026) ──────────────────────
 *   Yetkilendirme: `https://www.tiktok.com/v2/auth/authorize/`
 *     `?client_key=&response_type=code&scope=video.publish,user.info.basic
 *       &redirect_uri=&state=`
 *     - kapsamlar VİRGÜLLE ayrılır (boşluk değil),
 *     - `state` CSRF için ZORUNLUDUR,
 *     - `redirect_uri` STATİK olmalı, `https` ile başlamalı, fragment içermemeli,
 *       512 karakterden kısa olmalı; en fazla 10 tane kayıtlı olabilir.
 *   Token: `POST https://open.tiktokapis.com/v2/oauth/token/`
 *     `grant_type=authorization_code&client_key=&client_secret=&code=&redirect_uri=`
 *     → `access_token` (**24 saat**), `refresh_token` (**365 gün**), `open_id`,
 *       `scope`, `display_name`, `avatar_url`.
 *
 * ── `externalId` NEDEN `open_id` ────────────────────────────────────────────
 * `video/query`, `creator_info` ve `status/fetch` uçları hesabı `open_id` ile
 * değil, yalnız taşıyıcı belirteçle çağırılır; `open_id` bizim KALICI hesap
 * kimliğimizdir ve `accounts.external_id` sütununda durur. `union_id` farklı ve
 * çoklu uygulama arasında paylaşılan bir kimliktir; bizim tek uygulamamız var.
 *
 * ── `refresh` VE DÖNEN `refresh_token` ───────────────────────────────────────
 * TikTok yenileme cevabında `refresh_token` **dönmek ZORUNDADIR ve girdiğinden
 * FARKLI olabilir**. Eski belirteç hemen geçersizleşir. Bu yüzden:
 *   - Dönen değer `RefreshOutcome.refreshToken` olarak **AYNEN** geçirilir.
 *   - Alan YOKSA `null` döner (sözleşme: "yenisi dönmedi, eskisini koru") —
 *     UYDURMA bir yenisi ASLA üretilmez.
 *   - Çağıran (`credentials` deposu) dönen değeri `refreshTokenEnc` içine yazar;
 *     `null` dönen durumda eskiyi korur.
 *
 * ── `accountChanged: false` NEDEN ───────────────────────────────────────────
 * Port imzası `refresh(refreshToken)` der; karşılaştırılacak eski `open_id`
 * çağrıya GİRMEZ. TikTok'un cevabı `open_id` taşısa bile elimizde onunla
 * karşılaştıracağımız bir hedef yoktur. `true` uydurmak sessiz bir güvenlik
 * iddiası olurdu; `false` dürüsttür ve "tespit edilemedi" demektir. Port
 * ileride hedef alanı alırsa bu tek satır gerçek bir kontrole dönüşür.
 */
import type { Platform } from "../../contract/index.js";
import type { AuthProvider, RefreshOutcome } from "../../ports/index.js";
import { PermanentPublishError } from "../../ports/index.js";
import type { Fetch, TikTokHttpClient } from "./http.js";
import { asPublishTransportError, createHttpClient } from "./http.js";
import { TIKTOK_AUTHORIZE_BASE, TIKTOK_SCOPES, TIKTOK_TOKEN_BASE } from "./publisher.js";

export interface TikTokOAuthConfig {
  /** TikTok uygulama anahtarı (OAuth'ta `client_key`). */
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TikTokAuthOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (süre hesabı test edilemez olmasın). */
  now: () => number;
  fetch?: Fetch;
  timeoutMs?: number;
  /**
   * Beklenen `state`. Verilirse `exchangeCode` karşılaştırır ve uyuşmazlıkta
   * KALICI hata verir (CSRF koruması). Verilmemesi "koruma yok" demek değil,
   * doğrulamanın çağıran tarafta yapıldığı anlamına gelir.
   */
  expectedState?: string;
  /** Test kancaları. Üretimde TikTok adresleri kullanılır. */
  tokenBase?: string;
  authorizeBase?: string;
}

/** TikTok `expires_in` çoğu zaman sayıdır ama metin de gelebilir. */
export function expiryIso(expiresIn: number | string | undefined, nowMs: number): string | null {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** Zorunlu scope kümesi + çağıranın ekledikleri (tekilleştirilmiş). */
export function requiredScopes(scopes: readonly string[] | null | undefined): string[] {
  const merged: string[] = [...TIKTOK_SCOPES];
  for (const scope of scopes ?? []) {
    const trimmed = typeof scope === "string" ? scope.trim() : "";
    if (trimmed !== "" && !merged.includes(trimmed)) merged.push(trimmed);
  }
  return merged;
}

/** `data.scope` metnini listeye çevirir. */
export function parseScopes(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Redirect URI kuralları. **Yerelde çalışan `http://localhost` KABUL EDİLMEZ**:
 * TikTok kayıtta yalnız `https` ister; gevşek bir kontrol "panelde kayıtlı"
 * dediği hâlde token isteğinin reddedilmesine yol açar. Sıkı kontrol, hatanın
 * kaynağını (kayıt defteri) doğrudan gösterir.
 */
export function redirectUriProblem(uri: string | null | undefined): string | null {
  if (typeof uri !== "string" || uri.trim() === "") return "Redirect URI boş.";
  const value = uri.trim();
  if (value.length >= 512) return "Redirect URI 512 karakterden kısa olmalı.";
  if (value.includes("#")) return "Redirect URI fragment (#...) içeremez.";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Redirect URI geçerli bir URL değil.";
  }
  if (parsed.protocol !== "https:") return "Redirect URI `https` ile başlamalı.";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_expires_in?: number | string;
  open_id?: string;
  scope?: string;
  display_name?: string;
  avatar_url?: string;
  error?: string;
  error_description?: string;
  code?: number | string;
  message?: string;
  log_id?: string;
}

export class TikTokAuth implements AuthProvider {
  readonly platform: Platform = "tiktok";

  private readonly now: () => number;
  private readonly expectedState: string | undefined;
  private readonly tokenBase: string;
  private readonly authorizeBase: string;
  private readonly client: TikTokHttpClient;

  constructor(
    private readonly config: TikTokOAuthConfig,
    options: TikTokAuthOptions,
  ) {
    this.now = options.now;
    this.expectedState = options.expectedState;
    this.tokenBase = options.tokenBase ?? TIKTOK_TOKEN_BASE;
    this.authorizeBase = options.authorizeBase ?? TIKTOK_AUTHORIZE_BASE;
    this.client = createHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
  }

  /**
   * Yetkilendirme adresi.
   *
   * `scopes` parametresi DİKKATE ALINMAZ: zorunlu scope kümesi ile BİRLEŞTİRİLİR.
   * Çağıranın `video.publish`'i gönderip `user.info.basic`'i unutması, hesabın
   * görünen adının boş kalmasına yol açar. Kapsamlar virgülle birleşir ve
   * `URLSearchParams` tarafından YÜZDELİK KODLANIR (`%2C`) — bu doğru biçimdir.
   *
   * Redirect URI geçersizse HİÇBİR AĞ ÇAĞRISI YAPILMAZ; kalıcı hata verilir.
   */
  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string {
    const problem = redirectUriProblem(redirectUri);
    if (problem !== null) {
      throw new PermanentPublishError(
        `TikTok redirect URI geçersiz: ${problem} Paneldeki redirect URI ile TikTok "Linked " +
          "App" kaydı aynı olmalıdır.`,
        "validation",
        "invalid_redirect_uri",
      );
    }
    const merged = requiredScopes(scopes);
    const url = new URL(`${this.authorizeBase}/v2/auth/authorize/`);
    url.searchParams.set("client_key", this.config.clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", merged.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  /**
   * Yetkilendirme kodunu belirteçe çevirir.
   *
   * `state` verilmiş `expectedState` ile eşleşmezse HİÇBİR AĞ ÇAĞRISI YAPILMAZ.
   * Gövde `application/x-www-form-urlencoded`dir (JSON DEĞİL) — bu dokümanın
   * özgün biçimidir.
   */
  async exchangeCode(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    externalId: string;
    username: string | null;
    displayName: string;
    scopes: string[];
  }> {
    if (this.expectedState !== undefined && this.expectedState !== input.state) {
      throw new PermanentPublishError(
        "OAuth `state` eşleşmedi. Yetkilendirme kodu reddedildi (CSRF koruması). " +
          "Kullanıcıyı yetkilendirme adresine YENİDEN yönlendirin.",
        "auth",
        "state_mismatch",
      );
    }
    const uriProblem = redirectUriProblem(input.redirectUri);
    if (uriProblem !== null) {
      throw new PermanentPublishError(
        `TikTok redirect URI geçersiz: ${uriProblem}`,
        "validation",
        "invalid_redirect_uri",
      );
    }

    const token = await this.postToken({
      grant_type: "authorization_code",
      client_key: this.config.clientKey,
      client_secret: this.config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    });

    const openId = typeof token.open_id === "string" ? token.open_id.trim() : "";
    if (openId === "") {
      throw new PermanentPublishError(
        "Token yanıtında `open_id` yok. Hesap kimliği çözülemediği için kayıt " +
          "tamamlanamaz; kullanıcıdan yeniden yetkilendirme istenir.",
        "auth",
        "missing_open_id",
        typeof token.log_id === "string" ? token.log_id : null,
      );
    }

    // TikTok her yanıtta `scope` döndürür. Alan yoksa istenen küme döner ve bu
    // sapma aşağıda `NOTES.md`'de yazılıdır — sessizce boş liste döndürmek
    // panelde "hiçbir yetki yok" gibi görünür.
    const granted = parseScopes(token.scope);
    const displayName =
      typeof token.display_name === "string" && token.display_name.trim() !== ""
        ? token.display_name.trim()
        : openId;

    return {
      accessToken: token.access_token as string,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
      expiresAt: expiryIso(token.expires_in, this.now()),
      externalId: openId,
      // `user.info.basic` kullanıcı adı DÖNDÜRMEZ (yalnız `open_id`,
      // `union_id`, `display_name`, `avatar_url`, sayaçlar). null DOĞRU cevaptır.
      username: null,
      displayName,
      scopes: granted.length > 0 ? granted : requiredScopes([]),
    };
  }

  /**
   * Belirteç uzatma (`grant_type=refresh_token`).
   *
   * Dönen `refresh_token` **AYNEN** geçirilir. Girdiğinden farklı olabilir ve
   * farklıysa ESKİSİ GEÇERSİZLEŞİR; alan yoksa `null` ("koru") döner. Yeni
   * bir değer UYDURULMAZ — sözleşmede `null` "koru" demektir ve çağıran eskiyi
   * saklar.
   */
  async refresh(refreshToken: string): Promise<RefreshOutcome> {
    if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
      throw new PermanentPublishError(
        "TikTok refresh token boş. Yenilenecek belirteç yok; kullanıcıdan yeniden " +
          "yetkilendirme istenir.",
        "auth",
        "no_stored_token",
      );
    }
    const token = await this.postToken({
      grant_type: "refresh_token",
      client_key: this.config.clientKey,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
    });
    return {
      accessToken: token.access_token as string,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
      expiresAt: expiryIso(token.expires_in, this.now()),
      accountChanged: false,
    };
  }

  // ── İç yardımcılar ──────────────────────────────────────────────────────

  private async postToken(fields: Record<string, string>): Promise<TokenResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    let response;
    try {
      response = await this.client.send({
        method: "POST",
        url: `${this.tokenBase}/v2/oauth/token/`,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: params.toString(),
      });
    } catch (err) {
      throw asPublishTransportError(err, "OAuth token isteği yapılamadı");
    }

    // Token cevabı ZARFLIDIR: `{ code: 0, message: "success", data: { ... } }`.
    // Hata alanları (`error`, `error_description`, `code`, `message`, `log_id`)
    // KÖKTEDİR; başarı alanları `data` İÇİNDEDİR. İkisini tek nesnede
    // birleştiriyoruz: kök alanlar önce, `data` sonra yazılır (data kazanır).
    const root = asRecord(response.json) ?? {};
    const data = asRecord(root["data"]) ?? {};
    const json = { ...root, ...data } as TokenResponse;
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!response.ok || accessToken === "") {
      const code =
        typeof root["error"] === "string"
          ? (root["error"] as string)
          : root["code"] !== undefined && root["code"] !== null
            ? String(root["code"])
            : `http_${response.status}`;
      const description =
        typeof root["error_description"] === "string"
          ? (root["error_description"] as string)
          : typeof root["message"] === "string"
            ? (root["message"] as string)
            : response.body.slice(0, 300);
      throw new PermanentPublishError(
        `OAuth token isteği başarısız (${code}): ${description}. ` +
          "`invalid_grant` genellikle süresi dolmuş/geçersiz veya daha önce kullanılmış " +
          "yetkilendirme kodu, `invalid_client` ise yanlış client_key/client_secret " +
          "demektir. İkisi de kullanıcıdan yeniden yetkilendirme ister.",
        "auth",
        code,
        typeof root["log_id"] === "string" ? root["log_id"] : null,
        response.status,
      );
    }
    return json;
  }
}

/** Yapılandırma eksikse hangi alanlar eksik? Panel mesajı için. */
export function missingOAuthConfig(config: {
  clientKey: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
}): string[] {
  const missing: string[] = [];
  if (typeof config.clientKey !== "string" || config.clientKey.trim() === "") {
    missing.push("SP_TIKTOK_CLIENT_KEY");
  }
  if (typeof config.clientSecret !== "string" || config.clientSecret.trim() === "") {
    missing.push("SP_TIKTOK_CLIENT_SECRET");
  }
  if (typeof config.redirectUri !== "string" || config.redirectUri.trim() === "") {
    missing.push("SP_TIKTOK_REDIRECT_URI");
  }
  return missing;
}
