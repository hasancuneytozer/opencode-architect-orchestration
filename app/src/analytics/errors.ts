/**
 * "NEDEN ÖLÇÜLEMEDİ" sınıflandırması.
 *
 * KURAL: SAĞLAYICIYA ÖZEL HATA TABLOSU UYDURULMAZ. Üç platformun kod
 * sözlükleri `src/domain/providerErrors.ts` içinde zaten var ve politika
 * kararları oradan gelir. Buradeki tek ek tablo, bir `PublishErrorKind`'ı
 * `MetricUnavailable.reason` sözlüğüne çeviren ALTI SATIRLIK KÖPRÜDÜR; bu
 * platforma özel değildir, analitik sözlüğüne çeviridir.
 *
 * KÖPRÜ NEDEN `kind`'a ÖNCELİK VERMEZ: HTTP durumu, çoğu zaman ham koddan
 * DAHA güvenilir bir "neden" taşır. Meta'da `403` "scope eksik" demektir ve
 * gövdede çoğu zaman hiç kod olmaz; gövde kodlu olsa bile 410 "silinmiş"
 * demektir. Bu yüzden sıra: durum → eşleme → güvenli varsayılan.
 */
import type { Platform, PublishErrorKind } from "../contract/index.js";
import type { ProviderErrorMapping } from "../domain/providerErrors.js";
import type { MetricUnavailable, MetricUnavailableReason } from "./types.js";

/**
 * `PublishErrorKind` → analitik sebebi.
 *
 * - `auth`, `policy` → `no_scope`: kapsam/izin eksik. Yayın yapılabilir ama
 *   ölçüm yapılamaz (IG'de `instagram_manage_insights` ayrı izindir).
 * - `not_public` → `not_public`: TikTok `SELF_ONLY` yayınlarda
 *   `publicaly_available_post_id` hiç dönmez.
 * - `validation`, `media_rejected` → `not_found`: içerik yok/silinmiş olabilir.
 * - geri kalan her şey → `provider_error`: sağlayıcı tarafı, bizim düzeltmemiz
 *   değil. `container_expired` dahil: yayın kaplosu sağlayıcıda bitmiş.
 */
export function reasonForKind(kind: PublishErrorKind): MetricUnavailableReason {
  switch (kind) {
    case "auth":
    case "policy":
      return "no_scope";
    case "not_public":
      return "not_public";
    case "validation":
    case "media_rejected":
      return "not_found";
    default:
      return "provider_error";
  }
}

/** `retryable` = politika (`isRetryableKind`), burada yeniden hesaplanır. */
export function retryableForReason(reason: MetricUnavailableReason): boolean {
  switch (reason) {
    case "not_public":
    case "not_found":
    case "no_scope":
    case "deleted":
      return false;
    case "provider_error":
      // Geçici/ kalıcı ayrımı YALNIZ `kind` bilir; çağıran mapping geçirir.
      return false;
  }
}

export interface UnavailableDecision {
  unavailable: MetricUnavailable;
  /** Bu karar geçici mi? Yeniden çekimde anlamlı mı. */
  retryable: boolean;
  /** Sağlayıcının ham kodu — destek talebi için. */
  providerCode: string | null;
  /** Sağlayıcının log/fbtrace kimliği. */
  logId: string | null;
  /** HTTP durumu (yoksa null). */
  httpStatus: number | null;
}

export interface UnavailableInput {
  platform: Platform;
  /** Ekran/hata adı: "Insights okunamadı". */
  what: string;
  status: number;
  /** `providerErrors.ts`'ten gelen eşleme. */
  mapping?: ProviderErrorMapping | null;
  providerMessage?: string | null;
  providerCode?: string | null;
  logId?: string | null;
  retryAfterMs?: number | null;
  /** Eksik kapsamlar; mesajda kullanıcıya ne yapması gerektiğini söyler. */
  missingScopes?: readonly string[];
}

/**
 * HTTP yanıtından "ölçülemedi" kararı üretir.
 *
 * Geçici/kalıcı AYRIMI: eşleme geldiyse `mapping.retryable`, gelmediyse HTTP
 * durumu (`429` ve `5xx` geçici). `no_scope` her zaman kalıcıdır — eksik izin
 * kendiliğinden gelmez; kullanıcı OAuth ekranından izin vermek zorundadır.
 */
export function unavailableFromResponse(input: UnavailableInput): UnavailableDecision {
  const status = input.status;
  const logId = input.logId ?? null;
  const mapping = input.mapping ?? null;
  const code =
    input.providerCode ?? (mapping !== null && mapping.providerCode !== "" ? mapping.providerCode : null);

  const base =
    `${input.what} — HTTP ${status}` +
    (code === null ? "" : ` (${code})`) +
    (input.providerMessage === null || input.providerMessage === undefined || input.providerMessage === ""
      ? ""
      : `: ${input.providerMessage}`);

  const scopeHint =
    input.missingScopes !== undefined && input.missingScopes.length > 0
      ? ` Gerekli izin: ${input.missingScopes.join(", ")}.`
      : "";

  const build = (reason: MetricUnavailableReason, message: string, retryable: boolean): UnavailableDecision => ({
    unavailable: { reason, message, logId },
    retryable,
    providerCode: code,
    logId,
    httpStatus: status,
  });

  // 1) Durum. 410 "silinmiş" ayrı bir sebeptir ve `not_found` ile karıştırılmaz.
  if (status === 410) {
    return build("deleted", `${base}. İçerik platform tarafında silinmiş.`, false);
  }
  if (status === 404) {
    return build("not_found", `${base}. İçerik bulunamadı.`, false);
  }
  if (status === 401 || status === 403) {
    return build(
      "no_scope",
      `${base}. ${mapping !== null ? `${mapping.message} ` : ""}${scopeHint || "İzin eksik; ölçüm için yeniden yetkilendirme gerekir."}`.trim(),
      false,
    );
  }
  if (status === 429) {
    const wait =
      input.retryAfterMs === null || input.retryAfterMs === undefined
        ? "Sağlayıcı bekleme süresi vermedi."
        : `Sağlayıcı ${Math.ceil(input.retryAfterMs / 1000)} sn sonra tekrar denemeyi söyledi.`;
    return build("provider_error", `${base}. ${wait}`, true);
  }
  if (status >= 500) {
    return build("provider_error", `${base}. Sağlayıcı tarafı geçici hata verdi.`, true);
  }

  // 2) Doğrulanmış kod eşlemesi.
  if (mapping !== null) {
    const reason = reasonForKind(mapping.kind);
    const message = `${base} — ${mapping.message}${reason === "no_scope" ? scopeHint : ""}`;
    return build(reason, message, mapping.retryable);
  }

  // 3) Tahmin yok: kalıcı `provider_error`. "Belki geçcidir" demek, destek
  //    talebinde yanlış teşhis ve sonsuz yeniden deneme demektir.
  return build("provider_error", `${base}. Tanımlı hata kodu yok; kalıcı kabul edildi.`, false);
}

/** Geçici bir taşıma hatasını "ölçülemedi" kararına çevirir (ağ yok, zaman aşımı). */
export function unavailableFromTransport(input: {
  platform: Platform;
  what: string;
  message: string;
  logId?: string | null;
}): UnavailableDecision {
  const logId = input.logId ?? null;
  return {
    unavailable: {
      reason: "provider_error",
      message: `${input.what} — ${input.message}`,
      logId,
    },
    retryable: true,
    providerCode: null,
    logId,
    httpStatus: null,
  };
}

/**
 * Kapsam ön kontrolü: eksik izinler `no_scope` kararı üretir ve AĞ ÇAĞRISI
 * YAPILMAZ.
 *
 * Neden ağdan önce: eksik kapsamda yapılan her çağrı 403 döner ve IG'nin
 * BUC kotasını (4800 × Impressions / 24 saat) harcar. Kullanıcıya gösterilecek
 * mesaj aynı zamanda ne yapması gerektiğini söyler.
 */
export function noScopeDecision(input: {
  what: string;
  missingScopes: readonly string[];
  logId?: string | null;
}): UnavailableDecision {
  const logId = input.logId ?? null;
  return {
    unavailable: {
      reason: "no_scope",
      message:
        `${input.what} — eksik izin: ${input.missingScopes.join(", ")}. ` +
        "Bu izin yayın için gerekenlerden FARKLIDIR; yeniden yetkilendirme ile talep edilmelidir.",
      logId,
    },
    retryable: false,
    providerCode: "missing_scope",
    logId,
    httpStatus: null,
  };
}