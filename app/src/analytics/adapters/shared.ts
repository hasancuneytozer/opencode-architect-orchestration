/**
 * Üç analitik adaptörünün paylaştığı, platforma ÖZEL OLMAYAN yardımcılar.
 *
 * Kural (aynı): sağlayıcıya özel hata tablosu burada YOK. Hata sözlükleri
 * `src/domain/providerErrors.ts` içindedir; burada yalnız
 *   * Meta `fbtrace_id` okuma (yalnız Meta gövdesinde bulunur),
 *   * "yanıt hata mı değil mi" kararı ve `no_scope` ipucu
 * vardır. Bunlar üç platformda da aynı soruyu sorar ve üç ayrı kopyası
 * zamanla ayrışırdı.
 */
import type { Platform } from "../../contract/index.js";
import { mapMetaError, mapYouTubeReason } from "../../domain/providerErrors.js";
import type { AnalyticsHttpResponse } from "../http.js";
import { asRecord, asText } from "../http.js";
import { unavailableFromResponse } from "../errors.js";
import type { UnavailableDecision } from "../errors.js";

/**
 * Meta hata gövdesinden destek kanıtı.
 *
 * Öncelik `fbtrace_id`, sonra `error_log_id`. İkisi de destek talebinde tek
 * tek aranır; `error_log_id` gövdenin kökünde de olabilir.
 */
export function parseMetaLogId(json: unknown): string | null {
  const root = asRecord(json);
  if (root === null) return null;
  const err = asRecord(root["error"]) ?? root;
  return asText(err["fbtrace_id"]) ?? asText(err["error_log_id"]) ?? asText(root["error_log_id"]);
}

/**
 * Yanıt başarılı mı? Değilse "ölçülemedi" kararı döndürür.
 *
 * `response.ok` ise `null` döner (çağıran devam eder). `!ok` ise:
 *   1) Meta gövdesi varsa `mapMetaError` ile sınıflandırılır,
 *   2) Google gövdesi varsa `errors[].reason` → `mapYouTubeReason`,
 *   3) HTTP durumu (401/403 → `no_scope` + hangi izin gerektiği).
 */
export function noScopeOrResponse(
  platform: Platform,
  what: string,
  response: AnalyticsHttpResponse,
  requiredScopes: readonly string[],
): UnavailableDecision | null {
  if (response.ok) return null;

  const mapping = classifyBody(platform, response.json);
  const logId =
    platform === "instagram"
      ? parseMetaLogId(response.json)
      : (asText((asRecord(response.json) ?? {})["log_id"]) ?? null);

  return unavailableFromResponse({
    platform,
    what,
    status: response.status,
    mapping,
    providerMessage: providerMessageOf(response.json),
    providerCode: mapping !== null && mapping.providerCode !== "" ? mapping.providerCode : null,
    logId,
    retryAfterMs: response.retryAfterMs,
    missingScopes: requiredScopes,
  });
}

/** Sağlayıcının insan metni. Yoksa `null` — mesaj uydurulmaz. */
export function providerMessageOf(json: unknown): string | null {
  const root = asRecord(json);
  if (root === null) return null;
  const err = asRecord(root["error"]);
  if (err !== null) {
    const msg = asText(err["message"]);
    if (msg !== null) return msg;
  }
  const errors = root["errors"];
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const cell = asRecord(e);
      if (cell === null) continue;
      const msg = asText(cell["message"]);
      if (msg !== null) return msg;
    }
  }
  return asText(root["message"]);
}

/**
 * Gövde → `ProviderErrorMapping`.
 *
 * Meta için `mapMetaError`, Google için `mapYouTubeReason`. TikTok'un gövdesi
 * `error.message` + `error.code` taşır ve `providerErrors.ts`'te DOĞRULANMIŞ
 * bir `video/query` kodu tablosu YOKTUR; sahte kod uydurmak yerine `null`
 * döner ve karar HTTP durumundan gelir (bilinmeyen kod = kalıcı kabul edilir).
 */
export function classifyBody(platform: Platform, json: unknown) {
  const root = asRecord(json);
  if (root === null) return null;
  if (platform === "instagram") {
    const err = asRecord(root["error"]) ?? root;
    return mapMetaError({
      code: err["code"] as number | string | null | undefined,
      subcode: err["error_subcode"] as number | string | null | undefined,
      errorCode: err["code"] as number | string | null | undefined,
    });
  }
  if (platform === "youtube") {
    const errors = root["errors"];
    const first = Array.isArray(errors) ? asRecord(errors[0]) : null;
    const reason = first === null ? null : asText(first["reason"]);
    if (reason === null) return null;
    return mapYouTubeReason(reason);
  }
  return null;
}

/** TikTok gövdesindeki `log_id` — destek talebinde ZORUNLU alan. */
export function tiktokLogId(json: unknown): string | null {
  const root = asRecord(json);
  if (root === null) return null;
  const err = asRecord(root["error"]);
  return (err === null ? null : asText(err["log_id"])) ?? asText(root["log_id"]);
}

/** TikTok gövdesindeki `error.code` (varsa). Metin olarak korunur. */
export function tiktokErrorCode(json: unknown): string | null {
  const root = asRecord(json);
  if (root === null) return null;
  const err = asRecord(root["error"]);
  const raw = err === null ? root["code"] : err["code"];
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return null;
}