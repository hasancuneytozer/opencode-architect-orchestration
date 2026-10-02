/**
 * Sunucudan gelen KOD → kullanıcının okuyacağı TÜRKÇE metin.
 *
 * Kural: her kodun karşılığı ZORUNLUDUR. `Record<PublishErrorKind, ...>` tipi
 * eksik bir anahtarı derleme zamanında hata yapar; `test/web/labels.test.ts`
 * ayrıca sayıca doğrular. Kullanıcıya `unknown` ya da çıplak `quota` gösterilmez —
 * "Günlük kota doldu — yayınlanmadı" denir.
 *
 * `retryHint`, "Şimdi Yayınla/Yeniden Dene" kararının gerekçesidir; politika
 * kararının kendisi sunucudadır, burada yalnızca insan dili açıklama vardır.
 */
import type {
  Account,
  ContentState,
  JobState,
  Platform,
  PublishErrorKind,
  Severity,
} from "../../../src/contract/index.js";

/** Renk tonu. HER rozet metin de içerir; renk tek başına anlam taşımaz. */
export type Tone =
  | "idle"
  | "info"
  | "progress"
  | "ok"
  | "warn"
  | "orange"
  | "danger"
  | "muted"
  | "accent";

export interface ErrorKindMeta {
  /** Kısa başlık (rozette görünür). */
  label: string;
  /** Ne olduğu — bir cümle, teknik jargon yok. */
  detail: string;
  /** Kullanıcının yapabileceği şey. */
  action: string;
  /** Politika: otomatik tekrar denenecek mi? (sunucu kararı `retryable`'dır) */
  autoRetryable: boolean;
}

export const ERROR_KIND_META: Record<PublishErrorKind, ErrorKindMeta> = {
  network: {
    label: "Ağ hatası",
    detail: "Platforma ulaşılamadı veya bağlantı koptu. Dosya sunucuda sağlam duruyor.",
    action: "Kendi internet bağlantınızı kontrol edin.",
    autoRetryable: true,
  },
  ratelimit: {
    label: "Hız sınırı",
    detail: "Platform istek sayısı sınırına takıldı; bu bir hata değil, sıra koruması.",
    action: "Bekleyin, otomatik tekrar denenecek.",
    autoRetryable: true,
  },
  server: {
    label: "Sağlayıcı hatası",
    detail: "Platformun kendi sunucusu geçici bir hata döndürdü.",
    action: "Bekleyin, otomatik tekrar denenecek.",
    autoRetryable: true,
  },
  transient: {
    label: "Geçici hata",
    detail: "Hata geçici görünüyor; kalıcı bir sorun olduğuna dair kanıt yok.",
    action: "Bekleyin, otomatik tekrar denenecek.",
    autoRetryable: true,
  },
  validation: {
    label: "Doğrulama hatası",
    detail: "Gönderilen alan platform kurallarına uymuyor; bu içerikle yayın yapılamaz.",
    action: "Açıklama, başlık veya etiketleri düzeltin, sonra yeniden deneyin.",
    autoRetryable: false,
  },
  auth: {
    label: "Yetki hatası",
    detail: "Hesabın oturumu geçersiz veya gerekli izne sahip değil.",
    action: "Hesaplar ekranından hesabı yeniden bağlayın.",
    autoRetryable: false,
  },
  policy: {
    label: "Platform politikası",
    detail: "İçerik platformun yayın kurallarına aykırı bulundu.",
    action: "İçeriği değiştirin; otomatik tekrar deneme anlamlı değil.",
    autoRetryable: false,
  },
  quota: {
    label: "Günlük kota doldu",
    detail: "Hesabın yayın kotası tükendi. İçerik YAYINLANMADI.",
    action: "Kota sıfırlanınca yeniden deneyin.",
    autoRetryable: false,
  },
  media_rejected: {
    label: "Video reddedildi",
    detail: "Platform videoyu kabul etmedi: biçim, kalite veya içerik gerekçesi olabilir.",
    action: "Dosyayı kontrol edin; gerekirse yeniden dönüştürüp tekrar yükleyin.",
    autoRetryable: false,
  },
  container_expired: {
    label: "Kapsayıcı süresi doldu",
    detail: "Yükleme oturumu (Meta container / TikTok publish oturumu) süresini doldurdu.",
    action: "Yeniden deneyin; yükleme sıfırdan başlar.",
    autoRetryable: false,
  },
  not_public: {
    label: "İçerik herkese açık değil",
    detail: "Kaynak içerik gizli; platform yalnızca herkese açık içeriği alabilir.",
    action: "Kaynağı herkese açık yapın veya dosyayı doğrudan yükleyin.",
    autoRetryable: false,
  },
  unknown: {
    label: "Sınıflandırılamayan hata",
    detail: "Hata bilinen sınıflardan birine uymadı; sağlayıcının ham kodu kaydedildi.",
    action: "Sağlayıcı kodunu ve log kimliğini destek talebine ekleyin.",
    autoRetryable: false,
  },
};

export function errorKindMeta(kind: PublishErrorKind): ErrorKindMeta {
  return ERROR_KIND_META[kind];
}

export interface StateMeta {
  label: string;
  tone: Tone;
  /** Durumun ne anlama geldiğini söyleyen tek cümle. */
  help: string;
}

/** 8 iş durumu. */
export const JOB_STATE_META: Record<JobState, StateMeta> = {
  queued: {
    label: "Kuyrukta",
    tone: "idle",
    help: "İş kaydedildi, işçi henüz başlamadı.",
  },
  preparing: {
    label: "Hazırlanıyor",
    tone: "progress",
    help: "Video hazırlanıyor (gerekirse platform biçimine dönüştürülüyor).",
  },
  uploading: {
    label: "Yükleniyor",
    tone: "progress",
    help: "Video platforma parça parça gönderiliyor.",
  },
  processing: {
    label: "İşleniyor",
    tone: "progress",
    help: "Platform videoyu işliyor; kalıcı bağlantı bekleniyor.",
  },
  published: {
    label: "Yayınlandı",
    tone: "ok",
    help: "Yayın tamamlandı ve kalıcı bağlantı çözümlendi.",
  },
  published_no_link: {
    label: "Yayınlandı, link yok",
    tone: "orange",
    help: "Yayın tamamlandı ama platform kalıcı bağlantı vermedi (örn. TikTok SELF_ONLY).",
  },
  failed: {
    label: "Başarısız",
    tone: "danger",
    help: "Yayın tamamlanamadı. Hata sınıfına bakın.",
  },
  canceled: {
    label: "İptal edildi",
    tone: "muted",
    help: "İş iptal edildi; tekrar denemeye alınabilir.",
  },
};

/** 8 içerik durumu. */
export const CONTENT_STATE_META: Record<ContentState, StateMeta> = {
  draft: {
    label: "Taslak",
    tone: "idle",
    help: "İçerik oluşturuldu, henüz yayına hazır değil.",
  },
  validating: {
    label: "Doğrulanıyor",
    tone: "progress",
    help: "Teknik doğrulama sürüyor.",
  },
  ready: {
    label: "Yayına hazır",
    tone: "ok",
    help: "Doğrulama geçti; zamanlama bekleniyor.",
  },
  scheduled: {
    label: "Zamanlandı",
    tone: "info",
    help: "Zamanı geldiğinde yayınlanacak.",
  },
  published: {
    label: "Yayınlandı",
    tone: "ok",
    help: "Tüm platformlarda yayınlandı.",
  },
  partial: {
    label: "Kısmen yayınlandı",
    tone: "warn",
    help: "Bazı platformlarda yayınlandı, bazılarında olmadı.",
  },
  failed: {
    label: "Başarısız",
    tone: "danger",
    help: "Hiçbir platformda yayınlanamadı.",
  },
  canceled: {
    label: "İptal edildi",
    tone: "muted",
    help: "İçerik iptal edildi.",
  },
};

export const SEVERITY_META: Record<Severity, { label: string; tone: Tone }> = {
  error: { label: "Hata", tone: "danger" },
  warning: { label: "Uyarı", tone: "warn" },
  info: { label: "Bilgi", tone: "info" },
};

export const ACCOUNT_STATUS_META: Record<Account["status"], { label: string; tone: Tone; help: string }> = {
  active: {
    label: "Bağlı",
    tone: "ok",
    help: "Hesap bağlı ve yayına hazır.",
  },
  needs_reauth: {
    label: "Yeniden bağlanmalı",
    tone: "danger",
    help: "Erişim bilgisi geçersiz. Bu hesap yayın yapamaz; en yüksek öncelikli iş.",
  },
  disabled: {
    label: "Devre dışı",
    tone: "muted",
    help: "Hesap bilinçli olarak kapatıldı.",
  },
};

export const PLATFORM_META: Record<
  Platform,
  { label: string; short: string; tone: Tone; className: string }
> = {
  instagram: {
    label: "Instagram",
    short: "IG",
    tone: "orange",
    className: "border-orange/50 bg-orange/10 text-orange",
  },
  tiktok: {
    label: "TikTok",
    short: "TT",
    tone: "info",
    className: "border-info/50 bg-info/10 text-info",
  },
  youtube: {
    label: "YouTube",
    short: "YT",
    tone: "danger",
    className: "border-danger/50 bg-danger/10 text-danger",
  },
};

export function platformLabel(platform: Platform): string {
  return PLATFORM_META[platform].label;
}

/** "3 dk sonra" yerine: yayın zamanı gelecekte mi? */
export function isFuture(iso: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
}

/** Türkçe sıralama için küçük harfe indirme: "İ" ve "I" doğru davranır. */
export function trLower(text: string): string {
  return text.replace(/İ/g, "i").replace(/I/g, "ı").toLocaleLowerCase("tr-TR");
}