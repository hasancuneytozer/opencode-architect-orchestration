/**
 * Hesaplar sayfasının SAF mantığı. I/O YOK: `fetch` yok, `window` yok, `Date.now`
 * yok. Bu yüzden `test/web/accounts.test.ts` dosyası tarayıcısız çalışabilir.
 *
 * ── Neden dönüş bildirimi HAM KODU GÖSTERMEZ ────────────────────────────────
 * OAuth geri çağırması tarayıcının adres çubuğunda açılır; sunucu bu yüzden
 * hatayı `/#/accounts?linked=<platform>&error=<kısa kod>` biçiminde, YALNIZCA
 * kısa kodla bildirir (bkz. `src/http/server.ts` → `shortErrorCode`). Bu kod
 * (a) kullanıcıya hiçbir şey anlatmaz, (b) saldırgan tarafından KENDİSİ
 * seçilebilir — `/#/accounts?error=<script>…` bir bağlantıdır ve bir panel
 * geliştiricisi ya da destek ekibi tıklar.
 *
 * Bu yüzden `returnNotice` metni **yalnız eşleme tablosundan** üretir: girdi
 * hiçbir dalda `text` içine `concat`/araya girmez, sadece `hasOwnProperty` ile
 * anahtar olarak kullanılır. React kaçış yapıyor olsa bile (yapıyor) güvenlik
 * React'e bırakılmaz — DOM'a giden metin kaynağı burada KAPALI bir kümeydir.
 * Bilinmeyen kod `GENERIC_RETURN_ERROR` alır; kod ne gövdeye girer ne de
 * loglanır (log sunucunun işidir, `account.link_failed` denetim kaydı).
 *
 * Başarı metni de aynı gerekçeyle yalnız `PLATFORM_META`'dan üretilir: dönüş
 * URL'sine token/secret giremez, girmezdi.
 */
import type { Account, Platform } from "../../../src/contract/index.js";
import type { PlatformSetup } from "../api/types.js";
import { ACCOUNT_STATUS_META, PLATFORM_META } from "./labels.js";
import type { Tone } from "./labels.js";

/** Bir platformun "şu an bağlanabilir mi" durumu. */
export interface ConnectState {
  /** Sunucu bu platformu yapılandırılmış sayıyor mu? (`GET /v1/setup`) */
  configured: boolean;
  /** Bağlı hesabın durumu; bağlı hesap YOKSA `null`. */
  status: Account["status"] | null;
}

/**
 * `PLATFORM_META`'nın anahtarları = bağlanabilir platformlar.
 *
 * Neden `PLATFORM_META` ve elle bir liste değil: sözleşmeye yeni bir platform
 * eklenirse tablo genişler ve buradaki karar kendiliğinden açılır. Sözleşmede
 * olmayan bir değer `false` döner — yani kapı AÇILMAK yerine KAPANIR.
 */
export function isConnectablePlatform(platform: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_META, platform);
}

/**
 * Bağlan düğmesi etkin mi?
 *
 * `configured === false` ise sunucu `503` döner; düğmeyi canlı bırakmak
 * kullanıcıya çalışmayan bir yol sunmaktır. Düğme GİZLENMEZ — nedeni
 * (`missingKeysFor`) yanında yazılır (bkz. `Setup.tsx` deseni).
 */
export function canConnect(platform: Platform, configured: boolean): boolean {
  return configured === true && isConnectablePlatform(platform);
}

/**
 * Dört düğme etiketi. Öncelik sırası SABİTTİR:
 *
 *  1. yapılandırılmamış → "Yapılandırılmamış"  (akış yok, devre dışı)
 *  2. `needs_reauth`  → "Yeniden bağlan"      (dikkat gerektirir)
 *  3. kayıt var       → "Yönet"               (aktif ya da bilinçli kapatılmış)
 *  4. kayıt yok       → "Bağlan"
 *
 * `disabled` bilinçli bir kapatmadır; "Bağlan" demek yanlış olurdu (yeniden
 * bağlamak o hesabı açmaz), o yüzden 3. dallanır.
 */
export function connectLabel(platform: Platform, state: ConnectState): string {
  if (!state.configured || !isConnectablePlatform(platform)) return "Yapılandırılmamış";
  if (state.status === "needs_reauth") return "Yeniden bağlan";
  if (state.status !== null) return "Yönet";
  return "Bağlan";
}

/** Durum önceliği: en dikkat gerektiren en önce. */
const STATUS_PRIORITY: ReadonlyArray<Account["status"]> = ["needs_reauth", "active", "disabled"];

/**
 * Bir platformun `ConnectState`'ini hesap listesinden üretir.
 *
 * Aynı platformda birden çok hesap olabilir (aynı kullanıcı, ikinci bir kanal).
 * Düğme etiketi EN KÖTÜ duruma göre seçilir: bir `needs_reauth` varsa panel
 * "Yeniden bağlan" der, çünkü o hesap yayın yapamıyor.
 */
export function connectStateFor(
  platform: Platform,
  configured: boolean,
  accounts: ReadonlyArray<Pick<Account, "platform" | "status">>,
): ConnectState {
  const mine = accounts.filter((account) => account.platform === platform);
  let status: Account["status"] | null = null;
  for (const candidate of STATUS_PRIORITY) {
    if (mine.some((account) => account.status === candidate)) {
      status = candidate;
      break;
    }
  }
  const first = mine[0];
  if (status === null && first !== undefined) {
    // Sözleşmede olmayan bir durum: kayıt var → "Yönet" (çökme, "Bağlan" değil).
    status = first.status;
  }
  return { configured, status };
}

/** Hesap durumunun rozet tonu. Kaynak `ACCOUNT_STATUS_META` (tek doğruluk). */
export function statusTone(status: string): Tone {
  const meta = ACCOUNT_STATUS_META[status as Account["status"]];
  return meta?.tone ?? "muted";
}

// ── OAuth dönüş bildirimi ──────────────────────────────────────────────────

export interface ReturnNotice {
  kind: "success" | "error" | null;
  /** `kind === null` iken boştur; ekrana basılmaz. */
  text: string;
}

const NO_NOTICE: ReturnNotice = { kind: null, text: "" };

/**
 * Sunucunun ürettiği kısa kod → Türkçe tek cümle.
 *
 * Anahtarlar `src/http/server.ts` → `shortErrorCode` ile birebir aynıdır
 * (`auth_failed`, `invalid_request`, `rate_limited`, `policy`, `unknown`).
 * `access_denied` / `consent_denied` sunucunun bugünkü hâlinde üretilmiyor ama
 * sağlayıcı hata sınıfı değiştiğinde gelecek; burada TANIMLI olmayan bir kod
 * yanlış yön göstermesin diye önceden yazıldı.
 *
 * ⚠️ `Record<string, string>` bilinçlidir: anahtar kümesi kapalı bir SÖZLEŞME
 * değil, gelen kod tablosudur. Tabloya girmeyen her kod genel mesaja düşer.
 */
const RETURN_ERROR_TEXT: Record<string, string> = {
  auth_failed:
    "Hesap bağlanamadı: yetkilendirme başarısız oldu, erişim belirteci alınamadı. Yeniden deneyebilirsiniz.",
  access_denied:
    "Hesap bağlanmadı: yetki vermediniz. Bağlanmak istiyorsanız yeniden deneyin.",
  consent_denied:
    "Hesap bağlanmadı: gerekli izin onaylanmadı. İzinleri kabul edip yeniden deneyin.",
  invalid_request:
    "Bağlanma isteği geçersiz ya da süresi dolmuş. Akışı yeniden başlatın.",
  rate_limited: "Çok fazla deneme yapıldı. Bir süre bekleyip yeniden deneyin.",
  policy:
    "Platform politikası bağlanmayı reddetti. Farklı bir hesap ya da uygulama deneyin.",
};

/** Bilinmeyen kodların (ve `unknown`in) karşılığı. Ham kod buraya GİRMEZ. */
export const GENERIC_RETURN_ERROR =
  "Bağlantı tamamlanamadı. Sağlayıcı beklenmeyen bir hata döndürdü; ayrıntı sunucu günlüğünde.";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // Bozuk yüzde dizisi (`%zz`) çökmeye yol açmaz; ham metin kullanılır ve
    // zaten tabloya giremeyeceği için genel mesaja düşer.
    return value;
  }
}

/**
 * `#/accounts?linked=youtube&ok=1` ya da çıplak `?linked=youtube&ok=1`
 * girdisinden `Record`. `location.search` DEĞİL: dönüş adresi hash'in İÇİNDE
 * (`src/http/server.ts` → `accountsHashPath`), `location.search` boş gelir.
 */
function noticeQuery(search: string): Record<string, string> {
  const raw = search.replace(/^#/, "");
  const mark = raw.indexOf("?");
  const query = mark === -1 ? "" : raw.slice(mark + 1);
  // `Object.create(null)`: `__proto__` gibi bir anahtar tabloya sızamaz.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key === "") continue;
    out[safeDecode(key).trim().toLowerCase()] = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
  }
  return out;
}

function has(query: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(query, key);
}

/** `linked` değerini YALNIZ tablo üzerinden etikete çevirir; bilinmeyen → null. */
function linkedLabel(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_META, key)) return null;
  return PLATFORM_META[key as Platform].label;
}

/** Yalnız `PLATFORM_META` etiketinden metin üretir; dönüş URL'si başka hiçbir şey katmaz. */
function successText(linked: string | undefined): string {
  const label = linkedLabel(linked);
  if (label === null) return "Hesap bağlandı. Artık bu hesapla yayın yapabilirsiniz.";
  return `${label} hesabı bağlandı. Artık bu hesapla yayın yapabilirsiniz.`;
}

/** Yalnız `RETURN_ERROR_TEXT` tablosundan metin üretir. */
function errorText(code: string | undefined): string {
  const key = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (key !== "" && Object.prototype.hasOwnProperty.call(RETURN_ERROR_TEXT, key)) {
    return RETURN_ERROR_TEXT[key] ?? GENERIC_RETURN_ERROR;
  }
  return GENERIC_RETURN_ERROR;
}

/**
 * `/#/accounts?linked=<platform>&ok=1` → başarı şeridi.
 * `/#/accounts?linked=<platform>&error=<kod>` → hata şeridi.
 * Parametre yoksa `kind: null` (şerit basılmaz).
 *
 * Karar sırası önemlidir: sunucu başarıda `ok`, hatada `error` gönderir; ikisi
 * birden varsa HATA kazanır (güvenli taraf).
 */
export function returnNotice(search: string): ReturnNotice {
  if (typeof search !== "string" || search === "") return NO_NOTICE;
  const query = noticeQuery(search);
  if (has(query, "error")) return { kind: "error", text: errorText(query["error"]) };
  const ok = query["ok"];
  if (ok === "1") return { kind: "success", text: successText(query["linked"]) };
  if (ok !== undefined) return { kind: "error", text: GENERIC_RETURN_ERROR };
  return NO_NOTICE;
}

// ── Yapılandırma eksiği ────────────────────────────────────────────────────

/**
 * `platform`un EKSİK `.env` anahtarları.
 *
 * ⚠️ `setup` başka bir platforma aitse boş dizi döner: kullanıcı YouTube
 * eksiklerini Instagram kartının altında görmemeli. Anahtarlar ayrıklaştırılır
 * (tekrar eden ve boş olan atılır) çünkü her biri `CopyableKey` düğmesi olarak
 * basılır — tekrarlı anahtar "iki ayrı eksik" izlenimi verir.
 */
export function missingKeysFor(
  platform: Platform,
  setup: PlatformSetup | null | undefined,
): string[] {
  if (setup === null || setup === undefined) return [];
  if (setup.platform !== platform) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of setup.missing ?? []) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// ── Yönlendirme güvenliği ──────────────────────────────────────────────────

/**
 * `authStart` dönen adrese `location.href` ile gidilecek. Değer sunucudan
 * geldiği için "güvenilir" saymak doğru olmaz: `javascript:` gibi bir şema
 * panelde kod çalıştırır. Yalnız `http(s)` ve aynı kaynaklı yol kabul edilir.
 *
 * `//evil.example` (protokol-göreli) reddedilir: dış adres.
 */
export function isSafeRedirectUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
