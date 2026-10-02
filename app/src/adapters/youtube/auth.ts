/**
 * YouTube OAuth 2.0 sağlayıcısı — yetkilendirme kodu akışı, "installed app"
 * (gizli istemci) türü.
 *
 * ── SCOPE NEDEN İKİ TANE ───────────────────────────────────────────────────
 * `youtube.upload` yükleme için yeterli GÖRÜNÜR ama `videos.update` bu scope'u
 * KABUL ETMEZ. Durum değiştirmek için (`privacyStatus`, `publishAt`) ikinci
 * scope zorunludur:
 *   - `https://www.googleapis.com/auth/youtube.upload`
 *   - `https://www.googleapis.com/auth/youtube.force-ssl`
 * `force-ssl` olmadan `videos.update` 403/insufficientScope döner ve adaptörün
 * zamanlama/zor durum değiştirme yolu tamamen kullanılamaz hale gelir.
 * (Analitik bu pakette YOKTUR: `yt-analytics` kapsamı istenmez.)
 *
 * ── `prompt=consent` NEDEN ZORUNLU ─────────────────────────────────────────
 * Google `access_type=offline` için `refresh_token` döndürür, ancak KULLANICI
 * daha önce onay vermişse `prompt=consent` olmadan YENİ `refresh_token`
 * DÖNMEZ. Sessizce dönmezse uygulama ilk yenilemede refresh yeteneğini
 * kaybeder. Bu yüzden `prompt=consent` zorunludur.
 *
 * ── KANAL DOĞRULAMA ────────────────────────────────────────────────────────
 * Token gelir gelmez `channels?part=id,snippet&mine=true` çağrılır (1 kota
 * birimi). `externalId` = kanal `id`; `displayName` = `snippet.title`;
 * `username` = `snippet.customUrl` (yoksa `null` — uydurulmaz). Kanal
 * bulunamazsa `PermanentPublishError("auth")`: yetkisi olan bir hesap
 * bulunmuş olabilir ama kanalı yoktur.
 *
 * ── `refresh` VE `refreshToken: null` ──────────────────────────────────────
 * Google yenilemede çoğunlukla YENİ `refresh_token` DÖNDÜRMEZ. Sözleşme
 * `null` = "dönmedi, eskisini KORU" der. Uydurma bir yenisi üretmek, Google'ın
 * verdiği tek geçerli belirteci çöpe atmak demektir.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Platform } from "../../contract/index.js";
import type { AuthProvider, RefreshOutcome } from "../../ports/index.js";
import { PermanentPublishError } from "../../ports/index.js";
import type { Fetch } from "./http.js";
import { asPublishTransportError, createHttpClient, safeJsonParse } from "./http.js";
import { YOUTUBE_API, YOUTUBE_SCOPES } from "./publisher.js";

/** Yetkilendirme ucu. */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** Belirteç ucu (yetkilendirme kodu + yenileme aynı adreste). */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface YouTubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface YouTubeAuthOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (süre hesabı test edilemez olmasın). */
  now: () => number;
  fetch?: Fetch;
  timeoutMs?: number;
  /**
   * Beklenen `state`. Verilirse `exchangeCode` bunu karşılaştırır ve
   * uyuşmazlıkta KALICI hata verir. CSRF koruması burada uygulanır; verilmemesi
   * "koruma yok" demek değil, doğrulamanın çağıran tarafta yapıldığı anlamına
   * gelir (çağıran `generateOAuthState()` ile üretip saklar).
   */
  expectedState?: string;
  /** Test kancaları. Üretimde Google adresleri kullanılır. */
  authEndpoint?: string;
  tokenEndpoint?: string;
  apiBase?: string;
  /** Test için deterministik `state` üretimi. */
  randomBytes?: (size: number) => Uint8Array;
}

/**
 * CSRF `state` üretir (32 bayt → 64 karakter base64url).
 *
 * `randomBytes` enjekte edilebilir ki testte sabit değer üretilebilsin;
 * üretimde `node:crypto`dan gelir.
 */
export function generateOAuthState(randomBytesImpl?: (size: number) => Uint8Array): string {
  const source = randomBytesImpl ?? ((size: number) => new Uint8Array(randomBytes(size)));
  return Buffer.from(source(32)).toString("base64url");
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Sabit zamanlı `state` karşılaştırması. Uzunluk farkı da redittir. */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== "string" || received === "") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class YouTubeAuth implements AuthProvider {
  readonly platform: Platform = "youtube";

  private readonly now: () => number;
  private readonly expectedState: string | undefined;
  private readonly randomBytes: ((size: number) => Uint8Array) | undefined;
  private readonly authEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly apiBase: string;
  private readonly fetchImpl: Fetch | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly client: { send: (request: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Readonly<Record<string, string>>;
    body?: string | Uint8Array | null;
    timeoutMs?: number;
  }) => Promise<{ status: number; ok: boolean; headers: Readonly<Record<string, string>>; body: string; json: unknown }> };

  constructor(
    private readonly config: YouTubeOAuthConfig,
    options: YouTubeAuthOptions,
  ) {
    this.now = options.now;
    this.expectedState = options.expectedState;
    this.randomBytes = options.randomBytes;
    this.authEndpoint = options.authEndpoint ?? GOOGLE_AUTH_ENDPOINT;
    this.tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.apiBase = options.apiBase ?? YOUTUBE_API;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs;
    this.client = createHttpClient({
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      now: options.now,
    });
  }

  /**
   * Yetkilendirme adresi.
   *
   * `scopes` parametresi DİKKATE ALINMAZ: zorunlu scope kümesi ile BİRLEŞTİRİLİR
   * (eksik gelse bile `force-ssl` gönderilir). Çağıranın `youtube.upload`
   * gönderip `force-ssl`'yi unutması, adaptörün durum değiştirme yolunu
   * yayın anında bozardı.
   */
  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string {
    const merged = requiredScopes(scopes);
    const url = new URL(this.authEndpoint);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", merged.join(" "));
    url.searchParams.set("state", state);
    // Refresh token için ZORUNLU (yoksa yenilemede dönmez).
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    // Önceden verilmiş scope'ları koru (kısıtlamayı genişletmeden).
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  }

  /** CSRF `state` üretir (saklama ve doğrulama çağıranın işidir). */
  newState(): string {
    return generateOAuthState(this.randomBytes);
  }

  /**
   * Yetkilendirme kodunu belirteçe çevirir ve kanalı doğrular.
   *
   * `state` verilmiş `expectedState` ile eşleşmezse HİÇBİR AĞ ÇAĞRISI YAPILMAZ
   * ve kalıcı hata verilir: CSRF saldırısında kodu değiştiren saldırganın
   * aldığı belirteci bizim hesabımıza bağlaması engellenir.
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
    if (this.expectedState !== undefined && !stateMatches(this.expectedState, input.state)) {
      throw new PermanentPublishError(
        "OAuth `state` eşleşmedi. Yetkilendirme kodu reddedildi (CSRF koruması). " +
          "Kullanıcıyı yetkilendirme adresine YENİDEN yönlendirin.",
        "auth",
        "state_mismatch",
      );
    }

    const token = await this.postToken({
      grant_type: "authorization_code",
      code: input.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
    });

    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new PermanentPublishError(
        "Token yanıtında `access_token` yok. Yetkilendirme başarısız.",
        "auth",
        token.error ?? "no_access_token",
      );
    }

    const channel = await this.readChannel(accessToken);
    return {
      accessToken,
      // Google ilk yetkilendirmede `refresh_token` döner. Dönmezse null:
      // sözleşmede null = "koru", ama ilk yetkilendirmede elimizde korunacak
      // bir şey olmadığı için bu bir uyarı gerektiren durumdur; yine de
      // UYDURMA token üretilmez.
      refreshToken: typeof token.refresh_token === "string" && token.refresh_token !== ""
        ? token.refresh_token
        : null,
      expiresAt: expiryIso(token.expires_in, this.now()),
      externalId: channel.id,
      username: channel.username,
      displayName: channel.displayName,
      scopes: parseScopes(token.scope),
    };
  }

  /**
   * `grant_type=refresh_token`.
   *
   * `refreshToken: null` = Google YENİ token DÖNDÜRMEDİ → çağıran eskisini
   * KORUMALI. `accountChanged: false`: yenileme yanıtı hesap kimliği
   * (`channelId`) taşımaz, dolayısıyla değişiklik tespit EDİLEMEZ. Bu bir
   * bilinmezlik; `true` uydurmak (ya da `true` demek için ek çağrı yapmak)
   * hesap değişimini yakalayamaz. Çağıran, kimlik şüphesinde
   * `exchangeCode`/kanal doğrulamasını yeniden çalıştırır.
   */
  async refresh(refreshToken: string): Promise<RefreshOutcome> {
    const token = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new PermanentPublishError(
        "Yenileme yanıtında `access_token` yok.",
        "auth",
        token.error ?? "no_access_token",
      );
    }
    return {
      accessToken,
      refreshToken:
        typeof token.refresh_token === "string" && token.refresh_token !== ""
          ? token.refresh_token
          : null,
      expiresAt: expiryIso(token.expires_in, this.now()),
      accountChanged: false,
    };
  }

  // ── İç yardımcılar ──────────────────────────────────────────────────────

  private async postToken(fields: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    let response;
    try {
      response = await this.client.send({
        method: "POST",
        url: this.tokenEndpoint,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      throw asPublishTransportError(err, "OAuth token isteği yapılamadı");
    }
    const json = (response.json ?? {}) as TokenResponse;
    if (!response.ok || typeof json.error === "string") {
      const code = typeof json.error === "string" ? json.error : `http_${response.status}`;
      const description = typeof json.error_description === "string" ? json.error_description : response.body.slice(0, 300);
      throw new PermanentPublishError(
        `OAuth token isteği başarısız (${code}): ${description}. ` +
          "`invalid_grant` genellikle süresi dolmuş/geçersiz veya daha önce kullanılmış " +
          "yetkilendirme kodu demektir; kullanıcıdan yeniden yetkilendirme istenir.",
        "auth",
        code,
      );
    }
    return json;
  }

  private async readChannel(accessToken: string): Promise<{ id: string; displayName: string; username: string | null }> {
    let response;
    try {
      response = await this.client.send({
        method: "GET",
        url: `${this.apiBase}/channels?part=id,snippet&mine=true`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw asPublishTransportError(err, "Kanal doğrulaması yapılamadı");
    }
    if (!response.ok) {
      throw new PermanentPublishError(
        `Kanal doğrulaması başarısız (HTTP ${response.status}): ${response.body.slice(0, 300)}`,
        "auth",
        `channels_http_${response.status}`,
      );
    }
    const json = safeJsonParse(response.body);
    const items =
      json !== null && typeof json === "object" && Array.isArray((json as Record<string, unknown>)["items"])
        ? ((json as Record<string, unknown>)["items"] as unknown[])
        : [];
    const first = items[0];
    if (first === null || typeof first !== "object") {
      throw new PermanentPublishError(
        "Bu Google hesabına ait YouTube kanalı bulunamadı. `youtube.upload` scope'u " +
          "bir YouTube kanalı olmadan işe yaramaz; kanal oluşturulmalıdır.",
        "auth",
        "channel_not_found",
      );
    }
    const record = first as Record<string, unknown>;
    const snippet =
      record["snippet"] !== null && typeof record["snippet"] === "object"
        ? (record["snippet"] as Record<string, unknown>)
        : {};
    const id = typeof record["id"] === "string" ? record["id"] : "";
    if (id === "") {
      throw new PermanentPublishError("Kanal yanıtında `id` yok.", "auth", "channel_id_missing");
    }
    const displayName = typeof snippet["title"] === "string" ? snippet["title"] : id;
    const username = typeof snippet["customUrl"] === "string" && snippet["customUrl"] !== ""
      ? snippet["customUrl"]
      : null;
    return { id, displayName, username };
  }
}

/** Zorunlu scope kümesi + çağıranın ekledikleri (tekilleştirilmiş). */
export function requiredScopes(scopes: readonly string[] | null | undefined): string[] {
  const merged: string[] = [...YOUTUBE_SCOPES];
  for (const scope of scopes ?? []) {
    const trimmed = typeof scope === "string" ? scope.trim() : "";
    if (trimmed !== "" && !merged.includes(trimmed)) merged.push(trimmed);
  }
  return merged;
}

/** `expires_in` (saniye) → UTC ISO. Yoksa/bozuksa `null`. */
export function expiryIso(expiresIn: number | string | undefined, nowMs: number): string | null {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** `scope` metnini (boşlukla ayrılmış) diziye çevirir. */
export function parseScopes(scope: string | undefined): string[] {
  if (typeof scope !== "string") return [...YOUTUBE_SCOPES];
  const parts = scope.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== "");
  return parts.length > 0 ? parts : [...YOUTUBE_SCOPES];
}

/** Yapılandırma eksikse hangi alanlar eksik? Panel mesajı için. */
export function missingOAuthConfig(config: {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
}): string[] {
  const missing: string[] = [];
  if (typeof config.clientId !== "string" || config.clientId.trim() === "") missing.push("SP_GOOGLE_CLIENT_ID");
  if (typeof config.clientSecret !== "string" || config.clientSecret.trim() === "") missing.push("SP_GOOGLE_CLIENT_SECRET");
  if (typeof config.redirectUri !== "string" || config.redirectUri.trim() === "") missing.push("SP_GOOGLE_REDIRECT_URI");
  return missing;
}
