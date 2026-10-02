/**
 * `web/src/lib/accounts.ts` — panelin SAF mantığı.
 *
 * Kapsam: bağlan düğmesinin kararı, dönüş bildiriminin metin eşlemesi, eksik
 * `.env` anahtarları ve hesap durumu tonu.
 *
 * ── ASIL GÜVENLİK TESTİ `returnNotice` BLOĞUDUR ─────────────────────────────
 * Geri çağırma `/#/accounts?error=<kısa kod>` biçiminde döner ve o kod
 * SALDIRGAN TARAFINDAN SEÇİLEBİLİR. Bu yüzden metin üretimi "eşleme tablosu"
 * ile sınırlıdır: bilinmeyen kod genel mesaja düşer ve KODUN KENDİSİ ne gövdeye
 * ne de DOM'a girer. React kaçış yapıyor olsa bile (yapıyor) bu bir React
 * özelliği değil, bir UYGULAMA KARARIDIR — test de tam olarak o kararı kilitler.
 *
 * ── Neden `Date.now()` YOK ──────────────────────────────────────────────────
 * Bu modül `window`/`fetch`/`Date.now` kullanmaz; "bugün" değişse de testler
 * kırılmaz.
 */
import { describe, expect, it } from "vitest";

import type { Account, Platform } from "../../src/contract/index.js";
import type { PlatformSetup } from "../../web/src/api/types.js";
import {
  GENERIC_RETURN_ERROR,
  canConnect,
  connectLabel,
  connectStateFor,
  isConnectablePlatform,
  isSafeRedirectUrl,
  missingKeysFor,
  returnNotice,
  statusTone,
} from "../../web/src/lib/accounts.js";
import { ACCOUNT_STATUS_META, PLATFORM_META } from "../../web/src/lib/labels.js";

const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube"];

function setupFor(
  platform: Platform,
  missing: string[],
  extra: Partial<PlatformSetup> = {},
): PlatformSetup {
  return {
    platform,
    configured: missing.length === 0,
    missing,
    hasAccounts: false,
    docAnchor: "KIMLIK-KURULUMU.md",
    ...extra,
  };
}

function account(platform: Platform, status: Account["status"]): Account {
  return {
    id: `${platform}-${status}`,
    platform,
    externalId: `${platform}-1`,
    displayName: "Test Hesabı",
    username: "test",
    status,
    label: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

// ── `canConnect` ───────────────────────────────────────────────────────────

describe("canConnect", () => {
  it("HER platform için yapılandırılmışsa true", () => {
    for (const platform of PLATFORMS) {
      expect(canConnect(platform, true), platform).toBe(true);
    }
  });

  it("HER platform için yapılandırılmamışsa false (düğme devre dışı)", () => {
    for (const platform of PLATFORMS) {
      expect(canConnect(platform, false), platform).toBe(false);
    }
  });

  it("sözleşmedeki üç platformun tamamı bağlanabilir", () => {
    for (const platform of PLATFORMS) {
      expect(isConnectablePlatform(platform), platform).toBe(true);
    }
  });

  it("sözleşmede olmayan platform KAPALI (bilinmeyen değer açmaz)", () => {
    expect(isConnectablePlatform("myspace")).toBe(false);
    expect(isConnectablePlatform("")).toBe(false);
    // `PLATFORM_META`'nın kalıntı anahtarları da açmaz.
    expect(isConnectablePlatform("toString")).toBe(false);
  });

  it("canConnect, yapılandırılmamış platformda false kalır", () => {
    expect(canConnect("youtube", false)).toBe(false);
  });
});

// ── `connectLabel` — DÖRT durum ────────────────────────────────────────────

describe("connectLabel — dört düğme etiketi", () => {
  it("1) yapılandırılmamış → \"Yapılandırılmamış\"", () => {
    for (const platform of PLATFORMS) {
      expect(connectLabel(platform, { configured: false, status: null }), platform).toBe(
        "Yapılandırılmamış",
      );
    }
  });

  it("1b) yapılandırılmamış → etiket BAĞLI HESAP OLSA BİLE değişmez", () => {
    expect(connectLabel("youtube", { configured: false, status: "active" })).toBe(
      "Yapılandırılmamış",
    );
    expect(connectLabel("youtube", { configured: false, status: "needs_reauth" })).toBe(
      "Yapılandırılmamış",
    );
  });

  it("2) bağlı hesap yok → \"Bağlan\"", () => {
    for (const platform of PLATFORMS) {
      expect(connectLabel(platform, { configured: true, status: null }), platform).toBe("Bağlan");
    }
  });

  it("3) needs_reauth → \"Yeniden bağlan\"", () => {
    for (const platform of PLATFORMS) {
      expect(connectLabel(platform, { configured: true, status: "needs_reauth" }), platform).toBe(
        "Yeniden bağlan",
      );
    }
  });

  it("4) aktif hesap → \"Yönet\"", () => {
    for (const platform of PLATFORMS) {
      expect(connectLabel(platform, { configured: true, status: "active" }), platform).toBe(
        "Yönet",
      );
    }
  });

  it("dört etiket BİRBİRİNDEN FARKLIDIR (karıştırılabilir durum kalmaz)", () => {
    const labels = [
      connectLabel("youtube", { configured: false, status: null }),
      connectLabel("youtube", { configured: true, status: null }),
      connectLabel("youtube", { configured: true, status: "needs_reauth" }),
      connectLabel("youtube", { configured: true, status: "active" }),
    ];
    expect(new Set(labels).size).toBe(4);
    expect(labels).toEqual(["Yapılandırılmamış", "Bağlan", "Yeniden bağlan", "Yönet"]);
  });

  it("devre dışı hesap → \"Yönet\" (bilinçli kapatma, yeniden bağlama değil)", () => {
    expect(connectLabel("tiktok", { configured: true, status: "disabled" })).toBe("Yönet");
  });
});

// ── `connectStateFor` ──────────────────────────────────────────────────────

describe("connectStateFor — platformun en kötü durumu", () => {
  it("başka platformun hesabı dikkate alınmaz", () => {
    const state = connectStateFor("youtube", true, [account("instagram", "needs_reauth")]);
    expect(state).toEqual({ configured: true, status: null });
  });

  it("needs_reauth, active'den ÖNCE gelir (dikkat çeken durum kazanır)", () => {
    const state = connectStateFor("youtube", true, [
      account("youtube", "active"),
      account("youtube", "needs_reauth"),
    ]);
    expect(state.status).toBe("needs_reauth");
    expect(connectLabel("youtube", state)).toBe("Yeniden bağlan");
  });

  it("needs_reauth yoksa aktif hesap seçilir", () => {
    const state = connectStateFor("tiktok", true, [account("tiktok", "active")]);
    expect(connectLabel("tiktok", state)).toBe("Yönet");
  });

  it("configured bayrağı aynen geçer", () => {
    expect(connectStateFor("instagram", false, []).configured).toBe(false);
  });

  it("girdi dizisini DEĞİŞTİRMEZ", () => {
    const input = [account("youtube", "active"), account("youtube", "needs_reauth")];
    const copy = [...input];
    connectStateFor("youtube", true, input);
    expect(input).toEqual(copy);
  });
});

// ── `returnNotice` — dönüş bildirimi ───────────────────────────────────────

describe("returnNotice — başarı", () => {
  it("ok=1 → başarı, Türkçe metin", () => {
    const notice = returnNotice("?linked=youtube&ok=1");
    expect(notice.kind).toBe("success");
    expect(notice.text).toContain("YouTube");
    expect(notice.text).toContain("bağlandı");
  });

  it("tam hash de kabul edilir (sorgu hash'in İÇİNDE)", () => {
    expect(returnNotice("#/accounts?linked=tiktok&ok=1").kind).toBe("success");
    expect(returnNotice("#/accounts?linked=tiktok&ok=1").text).toContain("TikTok");
  });

  it("bilinmeyen platform yine başarıdır ama AD UYDURMAZ", () => {
    const notice = returnNotice("?linked=<script>alert(1)</script>&ok=1");
    expect(notice.kind).toBe("success");
    expect(notice.text).not.toContain("script");
    expect(notice.text).not.toContain("alert");
  });

  it("başarı metnine token/secret GİREMEZ (yalnız platform etiketi + sabit cümle)", () => {
    const notice = returnNotice("?linked=youtube&ok=1");
    expect(notice.text).not.toMatch(/access_token|refresh_token|secret|ya29\.|AIza/i);
  });

  it("parametre yoksa kind null", () => {
    expect(returnNotice("")).toEqual({ kind: null, text: "" });
    expect(returnNotice("#/accounts")).toEqual({ kind: null, text: "" });
    expect(returnNotice("?other=1")).toEqual({ kind: null, text: "" });
  });
});

describe("returnNotice — hata", () => {
  it("access_denied → Türkçe, sınıflandırılmış mesaj", () => {
    const notice = returnNotice("?linked=youtube&error=access_denied");
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe(
      "Hesap bağlanmadı: yetki vermediniz. Bağlanmak istiyorsanız yeniden deneyin.",
    );
    // Ham kod gövdeye GİRMEZ — kullanıcı anlaşılır bir cümle görür.
    expect(notice.text).not.toContain("access_denied");
  });

  it("sunucunun ürettiği kısa kodların tamamı tanınıyor (unknown → genel)", () => {
    // `src/http/server.ts` → `shortErrorCode`: auth_failed, invalid_request,
    // rate_limited, policy, unknown. Sunucu başka bir kod üretirse genel mesaj
    // devreye girer; hiçbir kod ham olarak gövdeye sızmaz.
    const classified = ["auth_failed", "invalid_request", "rate_limited", "policy"];
    for (const code of classified) {
      const notice = returnNotice(`?error=${code}`);
      expect(notice.kind, code).toBe("error");
      expect(notice.text, code).not.toBe(GENERIC_RETURN_ERROR);
      expect(notice.text, code).not.toContain(code);
    }
    expect(returnNotice("?error=unknown").text).toBe(GENERIC_RETURN_ERROR);
  });

  it("BİLİNMEYEN kod → genel mesaj ve kodun kendisi metne GİRMEZ", () => {
    const notice = returnNotice("?error=teknik_hata_12345");
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe(GENERIC_RETURN_ERROR);
    expect(notice.text).not.toContain("teknik_hata_12345");
    expect(notice.text.toLocaleLowerCase("tr")).toContain("bağlantı tamamlanamadı");
  });

  it("SALDIRGI: <script> benzeri hata değeri gövdeye GİRMEZ", () => {
    const payload = "?error=<script>alert(1)</script>";
    const notice = returnNotice(payload);
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe(GENERIC_RETURN_ERROR);
    expect(notice.text).not.toContain("<script");
    expect(notice.text).not.toContain("</script>");
    expect(notice.text).not.toContain("alert");
  });

  it("SALDIRGI: yüzde kodlanmış ve tırnaklı varyantlar da sızmaz", () => {
    for (const payload of [
      "?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
      "?error=auth_failed%22%3E%3Cscript%3E",
      "?error=<img src=x onerror=alert(1)>",
      "?error=\"><svg onload=alert(1)>",
    ]) {
      const notice = returnNotice(payload);
      expect(notice.kind, payload).toBe("error");
      expect(notice.text, payload).not.toContain("<");
      expect(notice.text, payload).not.toContain(">");
      expect(notice.text, payload).not.toContain("alert");
      expect(notice.text, payload).not.toContain("svg");
    }
  });

  it("SALDIRGI: `error` parametresi tabloya YAKIN bir kodla da ham metin giremez", () => {
    // `__proto__` / `constructor` gibi anahtarlar tabloyu ziyaret edemez.
    for (const payload of ["?error=__proto__", "?error=constructor", "?error=toString"]) {
      expect(returnNotice(payload).text, payload).toBe(GENERIC_RETURN_ERROR);
    }
  });

  it("boş `error` değeri de sessizce yutulmaz, genel hata gösterilir", () => {
    expect(returnNotice("?error=").kind).toBe("error");
    expect(returnNotice("?error=").text).toBe(GENERIC_RETURN_ERROR);
    expect(returnNotice("?error").kind).toBe("error");
  });

  it("ok=1 ile birlikte error varsa HATA kazanır (güvenli taraf)", () => {
    const notice = returnNotice("?linked=youtube&ok=1&error=access_denied");
    expect(notice.kind).toBe("error");
    expect(notice.text).not.toContain("bağlandı");
  });

  it("ok=0 → hata (başarı sayılmaz)", () => {
    const notice = returnNotice("?linked=youtube&ok=0");
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe(GENERIC_RETURN_ERROR);
  });

  it("başarı metninde olduğu gibi hata metninde de ham kod YOK", () => {
    const notice = returnNotice("#/accounts?linked=instagram&error=invalid_request");
    expect(notice.kind).toBe("error");
    expect(notice.text).toContain("yeniden başlat");
    expect(notice.text).not.toContain("invalid_request");
  });
});

// ── `missingKeysFor` ───────────────────────────────────────────────────────

describe("missingKeysFor — yalnız o platformun anahtarları", () => {
  it("YouTube eksikleri YouTube için döner", () => {
    const setup = setupFor("youtube", ["SP_GOOGLE_CLIENT_ID", "SP_GOOGLE_CLIENT_SECRET"]);
    expect(missingKeysFor("youtube", setup)).toEqual([
      "SP_GOOGLE_CLIENT_ID",
      "SP_GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("başka platform SORULDUĞUNDA boş dizi (yanlış karta anahtar taşmaz)", () => {
    const setup = setupFor("youtube", ["SP_GOOGLE_CLIENT_ID"]);
    expect(missingKeysFor("instagram", setup)).toEqual([]);
    expect(missingKeysFor("tiktok", setup)).toEqual([]);
  });

  it("platform eşleşmesi `configured` bayrağından değil `platform` ALANINDAN yapılır", () => {
    const setup = setupFor("tiktok", [], { configured: false });
    expect(missingKeysFor("tiktok", setup)).toEqual([]);
    expect(missingKeysFor("instagram", setup)).toEqual([]);
  });

  it("rapor yoksa ya da null ise çökmez", () => {
    expect(missingKeysFor("youtube", null)).toEqual([]);
    expect(missingKeysFor("youtube", undefined)).toEqual([]);
  });

  it("tekrar eden ve boş anahtarlar ayrıklaştırılır", () => {
    const setup = setupFor("instagram", ["SP_META_APP_ID", "  ", "SP_META_APP_ID", " SP_META_APP_SECRET "]);
    expect(missingKeysFor("instagram", setup)).toEqual([
      "SP_META_APP_ID",
      "SP_META_APP_SECRET",
    ]);
  });
});

// ── `statusTone` ───────────────────────────────────────────────────────────

describe("statusTone — üç hesap durumu", () => {
  it("active → yeşil (ok)", () => {
    expect(statusTone("active")).toBe("ok");
  });

  it("needs_reauth → kırmızı (danger)", () => {
    expect(statusTone("needs_reauth")).toBe("danger");
  });

  it("disabled → soluk (muted)", () => {
    expect(statusTone("disabled")).toBe("muted");
  });

  it("ton etiket tablosuyla Aynı kaynaktan gelir (kopma yok)", () => {
    for (const status of ["active", "needs_reauth", "disabled"] as const) {
      expect(statusTone(status)).toBe(ACCOUNT_STATUS_META[status].tone);
    }
  });

  it("sözleşmede olmayan durum → çökmez, soluk gösterir", () => {
    expect(statusTone("bilinmeyen")).toBe("muted");
    expect(statusTone("")).toBe("muted");
  });

  it("her durum RÖZET METNİ de taşır — renk tek başına anlam taşımaz", () => {
    for (const status of ["active", "needs_reauth", "disabled"] as const) {
      const meta = ACCOUNT_STATUS_META[status];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.help.length).toBeGreaterThan(0);
    }
  });
});

// ── `isSafeRedirectUrl` ────────────────────────────────────────────────────

describe("isSafeRedirectUrl — location.href güvenliği", () => {
  it("https ve http kabul edilir", () => {
    expect(isSafeRedirectUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
    expect(isSafeRedirectUrl("http://127.0.0.1:4317/api/v1/auth/youtube/callback")).toBe(true);
  });

  it("aynı kaynaklı yol kabul edilir", () => {
    expect(isSafeRedirectUrl("/api/v1/auth/youtube/callback?code=1")).toBe(true);
  });

  it("javascript: ve data: REDDEDİLİR (kod çalıştırma yolu)", () => {
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeRedirectUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("protokol-göreli dış adres reddedilir", () => {
    expect(isSafeRedirectUrl("//evil.example/steal")).toBe(false);
  });

  it("bozuk/boş adres reddedilir (undefined yazılmaz)", () => {
    expect(isSafeRedirectUrl("")).toBe(false);
    expect(isSafeRedirectUrl("   ")).toBe(false);
    expect(isSafeRedirectUrl("accounts.google.com")).toBe(false);
  });
});

// ── Tablo bütünlüğü ────────────────────────────────────────────────────────

describe("etiket ve platform tabloları", () => {
  it("sözleşmedeki üç platformun tamamı PLATFORM_META'da", () => {
    expect(Object.keys(PLATFORM_META).sort()).toEqual([...PLATFORMS].sort());
  });
});
