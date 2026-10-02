/**
 * Instagram OAuth — **Facebook Login for Business** (Graph API OAuth).
 *
 * ── NEDEN BU YOL ────────────────────────────────────────────────────────────
 * İki giriş yolu var. `Business Login for Instagram` (`graph.instagram.com`)
 * daha kısadır ama (a) resumable upload YOKTUR, (b) public medya URL'i zorunludur.
 * `Facebook Login` yolunda resumable upload vardır; bu da uygulamamızın
 * `requiresPublicMediaUrl: false` olmasıyla örtüşür. **Bir Facebook Page ve o
 * sayfaya bağlı bir Instagram PROFESYONEL hesap zorunludur.**
 *
 * ── ÜÇ ADIM ────────────────────────────────────────────────────────────────
 *   1) `GET /{v}/oauth/access_token` (code ile) → kısa ömürlü token (~1 saat)
 *   2) `GET /{v}/oauth/access_token?grant_type=fb_exchange_token` → 60 günlük
 *      long-lived token. **BU ADIM ATLANIRSA** uygulama 1 saatte bir kullanıcı
 *      yeniden yetkilendirme ister; panelde oturum sürekli düşer.
 *   3) `GET /me/accounts` → sayfa id; `GET /{page-id}?fields=
 *      instagram_business_account` → IG user id + kullanıcı adı.
 *
 * ── `externalId` NEDEN IG USER ID ───────────────────────────────────────────
 * Yayın uçları `{ig-user-id}/media` ve `{ig-user-id}/media_publish` biçiminde.
 * Sayfa id'si ile çağırmak "Unsupported get_request" döner. `linkedPageId`
 * ayrıca dönülür çünkü resumable yol bir Page'e bağlıdır ve ileride silme/
 * yorum gibi işlerde gerekir.
 *
 * ── `refresh` VE `refreshToken: null` ──────────────────────────────────────
 * Graph API **refresh token YAYINLAMAZ**. Bu yüzden:
 * - `refresh(refreshToken)`, `refresh_token_enc` alanında duran belirteci
 *   `fb_exchange_token` olarak uzatmayı DENER. Bugüne kadar hiçbir Graph API
 *   sürümü bunu reddetmediği için yol açık bırakılmıştır, AMA bu bir OAuth
 *   refresh grant'i DEĞİLDİR ve canlıda doğrulanmamıştır.
 * - Dönen `refreshToken` **her zaman `null`** olur. Sözleşmede `null` = "yeni
 *   refresh token DÖNMEDİ, eskisini KORU". Meta yenileme belirteci üretmediği
 *   için `null` DOĞRU cevaptır; eski belirteci `refreshTokenEnc` içinde tutan
 *   çağıran onu korur.
 * - Uzatma reddedilirse `PermanentPublishError("auth")` → motor `needs_reauth`
 *   yoluna düşer. Bu, kullanıcıya yeniden yetkilendirme demektir.
 */
import type { Platform } from "../../contract/index.js";
import type { AuthProvider, RefreshOutcome } from "../../ports/index.js";
import { PermanentPublishError } from "../../ports/index.js";
import type { Fetch, InstagramHttpClient } from "./http.js";
import { asPublishTransportError, createHttpClient, safeJsonParse } from "./http.js";
import {
  INSTAGRAM_GRAPH_BASE,
  INSTAGRAM_OAUTH_DIALOG_BASE,
  INSTAGRAM_SCOPES,
} from "./publisher.js";
import { GRAPH_API_VERSION } from "../../media/specs/instagram.js";

export interface InstagramOAuthConfig {
  /** Meta uygulama id'si (Facebook App ID). */
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface InstagramAuthOptions {
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
  /** Test kancaları. Üretimde Meta adresleri kullanılır. */
  graphBase?: string;
  dialogBase?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Graph API'de sayısal/string karışabilir; yalnız SONRASI GEÇERLİ sayıları al. */
export function expiryIso(expiresIn: number | string | undefined, nowMs: number): string | null {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** Zorunlu scope kümesi + çağıranın ekledikleri (tekilleştirilmiş). */
export function requiredScopes(scopes: readonly string[] | null | undefined): string[] {
  const merged: string[] = [...INSTAGRAM_SCOPES];
  for (const scope of scopes ?? []) {
    const trimmed = typeof scope === "string" ? scope.trim() : "";
    if (trimmed !== "" && !merged.includes(trimmed)) merged.push(trimmed);
  }
  return merged;
}

/** `/me/accounts` gövdesinden **yayına bağlı** ilk sayfayı seçer. */
export function pickPageWithInstagram(json: unknown): {
  pageId: string;
  pageName: string | null;
  igUserId: string;
  igUsername: string | null;
  igName: string | null;
} | null {
  const root = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (root === null) return null;
  const data = Array.isArray(root["data"]) ? (root["data"] as unknown[]) : [];
  // Birden çok sayfa yönetiliyorsa İLK `instagram_business_account` taşıyan
  // sayfa seçilir. "Hangisi?" sorusu bu sınıfta sorulmaz: `linkedPageId` kayıtta
  // saklanır ve gelecekte seçilebilir hale gelir. KÖR SEÇİM YAPILMAZ —
  // bağlı IG hesabı olmayan sayfa "yayına hazır" sayılmaz.
  for (const item of data) {
    const record =
      item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (record === null) continue;
    const pageId = typeof record["id"] === "string" ? record["id"] : "";
    if (pageId === "") continue;
    const igRaw =
      record["instagram_business_account"] !== null && typeof record["instagram_business_account"] === "object"
        ? (record["instagram_business_account"] as Record<string, unknown>)
        : null;
    if (igRaw === null) continue;
    const igUserId = typeof igRaw["id"] === "string" ? igRaw["id"] : "";
    if (igUserId === "") continue;
    const pageName = typeof record["name"] === "string" ? record["name"] : null;
    const igUsername = typeof igRaw["username"] === "string" ? igRaw["username"] : null;
    const igName = typeof igRaw["name"] === "string" ? igRaw["name"] : null;
    return { pageId, pageName, igUserId, igUsername, igName };
  }
  return null;
}

export class InstagramAuth implements AuthProvider {
  readonly platform: Platform = "instagram";

  private readonly now: () => number;
  private readonly expectedState: string | undefined;
  private readonly graphBase: string;
  private readonly dialogBase: string;
  private readonly client: InstagramHttpClient;

  constructor(
    private readonly config: InstagramOAuthConfig,
    options: InstagramAuthOptions,
  ) {
    this.now = options.now;
    this.expectedState = options.expectedState;
    this.graphBase = options.graphBase ?? INSTAGRAM_GRAPH_BASE;
    this.dialogBase = options.dialogBase ?? INSTAGRAM_OAUTH_DIALOG_BASE;
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
   * Çağıranın `instagram_content_publish`'i gönderip `pages_read_engagement`'i
   * unutması, IG hesabı çözümlenemeyen bir yetkilendirmeye yol açar ve hata
   * ekranı boş bir "sayfa bulunamadı" mesajı gösterir.
   */
  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string {
    const merged = requiredScopes(scopes);
    const url = new URL(
      `${this.dialogBase}/${GRAPH_API_VERSION}/dialog/oauth`,
    );
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", merged.join(","));
    url.searchParams.set("response_type", "code");
    return url.toString();
  }

  /**
   * Yetkilendirme kodunu long-lived belirteçe çevirir ve IG hesabını çözer.
   *
   * `state` verilmiş `expectedState` ile eşleşmezse HİÇBİR AĞ ÇAĞRISI YAPILMAZ.
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
    linkedPageId?: string | null;
  }> {
    if (this.expectedState !== undefined && this.expectedState !== input.state) {
      throw new PermanentPublishError(
        "OAuth `state` eşleşmedi. Yetkilendirme kodu reddedildi (CSRF koruması). " +
          "Kullanıcıyı yetkilendirme adresine YENİDEN yönlendirin.",
        "auth",
        "state_mismatch",
      );
    }

    const short = await this.readToken({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    });

    // 2. adım: long-lived'e çevir. ATLANIRSA uygulama ~1 saatte düşer.
    const long = await this.readToken({
      grant_type: "fb_exchange_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: short.accessToken,
    });

    const account = await this.readInstagramAccount(long.accessToken);
    return {
      accessToken: long.accessToken,
      // Graph API refresh token YAYINLAMAZ. Sözleşmede `null` = "koru"; elimizde
      // korunacak ayrı bir belirteç olmadığı için `null` DOĞRU cevaptır ve
      // UYDURMA token üretilmez.
      refreshToken: null,
      expiresAt: expiryIso(long.expiresIn, this.now()),
      externalId: account.igUserId,
      username: account.igUsername,
      displayName: account.igName ?? account.pageName ?? account.igUserId,
      scopes: [...INSTAGRAM_SCOPES],
      linkedPageId: account.pageId,
    };
  }

  /**
   * Belirteç uzatma (OAuth refresh grant'i DEĞİLDİR).
   *
   * Graph API'de `refresh_token` yoktur; `refresh_token_enc` alanında duran şey
   * bizim sakladığımız long-lived belirteçtir. Meta `fb_exchange_token`
   * değişimini kısa ömürlü belirteç için belgeler, uzun ömürlüyü reddedebilir.
   * Bu yüzden:
   *   - başarılıysa `refreshToken: null` DÖNER (Meta yenisi üretmedi → eskisi
   *     korunur),
   *   - başarısızsa kalıcı `auth` hatası → yeniden yetkilendirme gerekir.
   * `accountChanged: false`: uzatma yanıtı hesap kimliği taşımaz, dolayısıyla
   * değişiklik tespit EDİLEMEZ; `true` uydurmak sessiz bir güvenlik iddiası olurdu.
   */
  async refresh(refreshToken: string): Promise<RefreshOutcome> {
    if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
      throw new PermanentPublishError(
        "Meta Graph API refresh token YAYINLAMAZ; yenilenecek belirteç boş. " +
          "Kullanıcıdan yeniden yetkilendirme istenir.",
        "auth",
        "no_stored_token",
      );
    }
    const token = await this.readToken({
      grant_type: "fb_exchange_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: refreshToken,
    });
    return {
      accessToken: token.accessToken,
      refreshToken: null,
      expiresAt: expiryIso(token.expiresIn, this.now()),
      accountChanged: false,
    };
  }

  // ── İç yardımcılar ──────────────────────────────────────────────────────

  private async readToken(
    fields: Record<string, string>,
  ): Promise<{ accessToken: string; expiresIn: number | string | undefined }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    let response;
    try {
      response = await this.client.send({
        method: "GET",
        url: `${this.graphBase}/${GRAPH_API_VERSION}/oauth/access_token?${params.toString()}`,
      });
    } catch (err) {
      throw asPublishTransportError(err, "OAuth token isteği yapılamadı");
    }
    const json = (response.json ?? {}) as TokenResponse;
    if (!response.ok || typeof json.error === "string" || typeof json.access_token !== "string") {
      const code = typeof json.error === "string" ? json.error : `http_${response.status}`;
      const description =
        typeof json.error_description === "string"
          ? json.error_description
          : response.body.slice(0, 300);
      throw new PermanentPublishError(
        `OAuth token isteği başarısız (${code}): ${description}. ` +
          "`invalid_grant` genellikle süresi dolmuş/geçersiz veya daha önce kullanılmış " +
          "yetkilendirme kodu demektir; kullanıcıdan yeniden yetkilendirme istenir.",
        "auth",
        code,
      );
    }
    return { accessToken: json.access_token, expiresIn: json.expires_in };
  }

  /**
   * `/me/accounts` → `instagram_business_account` → IG user id.
   *
   * İKİ ADIM NEDEN GEREKLİ: `/me/accounts` sayfa listesini döner; IG hesabı
   * sayfa nesnesinin İÇİNDE (`instagram_business_account`) gelir ve bazı App
   * Review sürümlerinde alan `me` yanıtında YOKTUR. Bu yüzden gövde alan
   * istenmez, ikinci çağrı `/{page-id}?fields=instagram_business_account` ile
   * yapılır. Aynı sayıda iki istek, tek istekten daha güvenilir.
   */
  private async readInstagramAccount(accessToken: string): Promise<{
    igUserId: string;
    igUsername: string | null;
    igName: string | null;
    pageId: string;
    pageName: string | null;
  }> {
    const accounts = await this.graphGet(accessToken, "/me/accounts", "Sayfa listesi okunamadı");
    const picked = pickPageWithInstagram(accounts);
    if (picked !== null) {
      return {
        igUserId: picked.igUserId,
        igUsername: picked.igUsername,
        igName: picked.igName,
        pageId: picked.pageId,
        pageName: picked.pageName,
      };
    }

    // Gövdede `instagram_business_account` yoksa: sayfa listesinde sayfa var mı?
    const pages = pageIds(accounts);
    if (pages.length === 0) {
      throw new PermanentPublishError(
        "Bu kullanıcının yönettiği Facebook Page bulunamadı. Facebook Login " +
          "yolunda bir sayfa ZORUNLUDUR (resumable upload yalnız sayfaya bağlı " +
          "Instagram profesyonel hesabı üzerinden çalışır).",
        "auth",
        "no_page",
      );
    }
    // Sayfa var ama IG alanı yok → her sayfayı tek tek dene (sayfa listesi
    // gövdesi alanı taşımayan App Review sürümlerinde bu gerekebilir).
    for (const pageId of pages) {
      const page = await this.graphGet(
        accessToken,
        `/${encodeURIComponent(pageId)}`,
        "Sayfa okunamadı",
        "instagram_business_account",
      );
      const fromPage = pickPageWithInstagram({ data: [{ id: pageId, ...asObject(page) }] });
      if (fromPage !== null) {
        return {
          igUserId: fromPage.igUserId,
          igUsername: fromPage.igUsername,
          igName: fromPage.igName,
          pageId: fromPage.pageId,
          pageName: fromPage.pageName,
        };
      }
    }
    throw new PermanentPublishError(
      "Sayfalar bulundu ama HİÇBİRİ Instagram'a bağlı değil. Content Publishing " +
        "API yalnız PROFESYONEL (Business/Creator) bir Instagram hesabıyla çalışır; " +
        "kişisel hesapta API yayını yapılamaz.",
      "auth",
      "no_instagram_business_account",
    );
  }

  private async graphGet(
    accessToken: string,
    path: string,
    what: string,
    fields?: string,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("access_token", accessToken);
    if (fields !== undefined) params.set("fields", fields);
    let response;
    try {
      response = await this.client.send({
        method: "GET",
        url: `${this.graphBase}/${GRAPH_API_VERSION}${path}?${params.toString()}`,
      });
    } catch (err) {
      throw asPublishTransportError(err, what);
    }
    if (!response.ok) {
      throw new PermanentPublishError(
        `${what} (HTTP ${response.status}): ${response.body.slice(0, 300)}`,
        "auth",
        `graph_http_${response.status}`,
      );
    }
    return response.json ?? safeJsonParse(response.body);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `/me/accounts` gövdesindeki sayfa id'leri (sıra korunur). */
export function pageIds(json: unknown): string[] {
  const root = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (root === null) return [];
  const data = Array.isArray(root["data"]) ? (root["data"] as unknown[]) : [];
  const out: string[] = [];
  for (const item of data) {
    const record = asObject(item);
    const id = typeof record["id"] === "string" ? record["id"] : "";
    if (id !== "") out.push(id);
  }
  return out;
}

/** Yapılandırma eksikse hangi alanlar eksik? Panel mesajı için. */
export function missingOAuthConfig(config: {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
}): string[] {
  const missing: string[] = [];
  if (typeof config.clientId !== "string" || config.clientId.trim() === "") missing.push("SP_META_APP_ID");
  if (typeof config.clientSecret !== "string" || config.clientSecret.trim() === "") {
    missing.push("SP_META_APP_SECRET");
  }
  if (typeof config.redirectUri !== "string" || config.redirectUri.trim() === "") {
    missing.push("SP_META_REDIRECT_URI");
  }
  return missing;
}