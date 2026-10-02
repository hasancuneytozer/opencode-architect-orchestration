/**
 * İş durum makinesi. SAF FONKSİYON: yalnız tablo ve gerekçe üretir; veritabanı
 * bilmez, hata durumunda ne yapılacağını bilmez.
 *
 * TERMINALLİK NEDEN BU KADAR KATı: `published` bir permalink'tir; ondan
 * `queued`'a dönmek aynı içeriğin ikinci kez yayınlanması demektir. Terminal
 * durumdan hiçbir çıkış yoktur.
 *
 * `failed` DA TERMINALDIR ve bu bir çelişki gibi görünür: sözleşmedeki
 * `RETRYABLE_STATES = ["failed"]` "bu iş yeniden denenebilir" der. İkisi de
 * doğru, farklı şey söylüyorlar:
 *   - `canTransition` YAYIN SONUÇLARINI konuşur: bu iş bitti, sonucu değişmez.
 *   - `canRequeueForRetry` İŞÇİ KARARINI konuşur: yeni bir deneme yapılacak.
 * Yeniden deneme bir durum GEÇİŞİ değildir; işçi `failed` işi kuyruğa geri
 * alır ve `assertTransition` bu yolda ÇAĞRILMAZ. İkisini birleştirmek,
 * terminal durumdan kaçışı mümkün kılardı.
 */
import type { ContentState, JobState } from "../contract/index.js";

/** Yayın sonucu bitti: bu durumdan hiçbir yere çıkılmaz. */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "published",
  "published_no_link",
  "failed",
  "canceled",
]);

/** Yayın tamam: permalink var (`published`) ya da yok (`published_no_link`). */
export const SUCCEEDED_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "published",
  "published_no_link",
]);

/** Hâlâ iş görüyor: kuyrukta, hazırlanıyor, yükleniyor veya işleniyor. */
export const ACTIVE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "queued",
  "preparing",
  "uploading",
  "processing",
]);

/** İzin verilen geçişler. Listede OLMAYAN her geçiş reddedilir. */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  // Hazırlık başlamadan iptal edilebilir; yayınlanamaz.
  queued: ["preparing", "canceled"],
  // Vazgeçilme kuyruğa geri alır (iptal/yeniden deneme kararı), ayrıca başarısız olabilir.
  preparing: ["uploading", "failed", "queued", "canceled"],
  // Yoklamadan "hâlâ bekliyorum" cevabı gelirse iş yeniden kuyruğa alınır.
  uploading: ["processing", "queued", "failed", "canceled"],
  processing: ["published", "published_no_link", "failed", "queued", "canceled"],
  // Terminal: çıkış yok.
  published: [],
  published_no_link: [],
  failed: [],
  canceled: [],
};

/** Terminal durumların red gerekçeleri — duruma özel, boş değil. */
const TERMINAL_REASONS: Readonly<Record<string, string>> = {
  published:
    "published terminal durumdur: yayın permalink'i kalıcıdır. Geri alınırsa içerik ikinci kez yayınlanır.",
  published_no_link:
    "published_no_link terminal durumdur: yayın tamamlandı, yalnız permalink çözümlenemedi. Sonuç değiştirilemez.",
  canceled:
    "canceled terminal durumdur: iptal edilen iş yeniden başlatılmaz. Yeniden yayın yeni bir iş gerektirir.",
  failed:
    "failed terminal durumdur: kalıcı hata. Yeniden deneme bir durum geçişi değildir; `canRequeueForRetry()` ayrı bir işçi kararıdır.",
};

/** Sık reddedilen geçişler için açıklayıcı not (yoksa jenerik mesaj üretilir). */
const REJECTION_NOTES: Readonly<Record<string, string>> = {
  "queued->published": "İş kuyruktayken yayınlanmış olamaz; önce preparing → uploading → processing gerekir.",
  "queued->published_no_link": "İş kuyruktayken yayınlanmış olamaz; önce preparing → uploading → processing gerekir.",
  "queued->uploading": "Hazırlık aşaması atlanamaz; uploading'e geçmeden önce preparing gerekir.",
  "queued->processing": "Yükleme yapılmadan işlenemez.",
  "queued->failed": "Henüz denenmemiş bir iş doğrudan başarısız sayılamaz; önce preparing gerekir.",
  "preparing->published": "Yükleme tamamlanmadan yayınlanmış sayılamaz.",
  "preparing->published_no_link": "Yükleme tamamlanmadan yayınlanmış sayılamaz.",
  "preparing->processing": "Sunucuya yükleme yapılmadan işlenemez.",
  "uploading->published": "Sunucu yüklemesi bitmeden yayınlanmış sayılamaz; önce processing gerekir.",
  "uploading->published_no_link": "Sunucu yüklemesi bitmeden yayınlanmış sayılamaz; önce processing gerekir.",
  "uploading->preparing": "Yüklemeye hazırlık geri alınamaz; yeniden deneme queued üzerinden yapılır.",
  "processing->uploading": "İşleme aşamasından yüklemeye dönülemez; yeniden deneme queued üzerinden yapılır.",
  "processing->preparing": "İşleme aşamasına geri dönülemez; yeniden deneme queued üzerinden yapılır.",
};

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Reddedilen geçişin GEREKÇESİNİ döner; izin veriliyorsa `null`.
 * "Neden olmadı" sorusu, "neden oldu" sorusundan daha pahalıdır: üretimde
 * reddedilen geçişin gerekçesini bilmeden kovaya düzeltmek saatler alır.
 */
export function explainTransition(from: JobState, to: JobState): string | null {
  if (from === to) {
    return (
      `KENDİNE GEÇİŞ (${from} → ${to}) tanımlı değil. Aynı durumu yeniden yazmak için ` +
      `geçiş çağırmayın; durum alanını doğrudan güncelleyin.`
    );
  }
  const terminalReason = TERMINAL_REASONS[from];
  if (terminalReason !== undefined) {
    return terminalReason;
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed.includes(to)) return null;
  return (
    REJECTION_NOTES[`${from}->${to}`] ??
    `${from} → ${to} geçişi tanımlı değil. ${from} durumundan izin verilen: ` +
      `${allowed.length > 0 ? allowed.join(", ") : "hiçbir durum (terminal)"}.`
  );
}

export function canTransition(from: JobState, to: JobState): boolean {
  return explainTransition(from, to) === null;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
    readonly reason: string,
  ) {
    super(`Geçersiz durum geçişi: ${from} → ${to}. ${reason}`);
    this.name = "IllegalTransitionError";
  }
}

/** Geçiş reddedilirse gerekçeli hata fırlatır. */
export function assertTransition(from: JobState, to: JobState): void {
  const reason = explainTransition(from, to);
  if (reason !== null) throw new IllegalTransitionError(from, to, reason);
}

// ── Yeniden deneme yolu (durum geçişi DEĞİLDİR) ─────────────────────────

/**
 * İşçi, kalıcı sayılmayan hatadan sonra bu işi yeni bir denemeye alabilir mi?
 * Bu bir DURUM GEÇİŞİ DEĞİLDİR; `assertTransition` bu yolda çağrılmaz.
 * Sözleşmedeki `RETRYABLE_STATES` (`failed`) ile aynı kaynaktan beslenir.
 */
export function canRequeueForRetry(state: JobState): boolean {
  return state === "failed";
}

// ── İçerik durumu toplulaştırma ────────────────────────────────────────────

/**
 * Platform işlerinin durumlarından içerik durumu türetir.
 *
 * SIRA ÖNEMLİDİR:
 * 1. hepsi iptal           → `canceled`
 * 2. hepsi başarılı         → `published`
 * 3. başarılı + (başarısız | iptal) → `partial`   (bir yere gitti, bir yere gitmedi)
 * 4. hepsi terminal, başarılı yok, en az biri başarısız → `failed`
 * 5. diğer her durum        → `scheduled`
 *
 * "başarılı" = `published` VEYA `published_no_link` (ikisi de yayındır;
 * permalink eksikliği yayın olmamak demek değildir).
 * Boş dizi `scheduled` döner: hiç iş yoksa "hepsi başarılı" demek yanlıştır.
 */
export function aggregateContentState(jobStates: readonly JobState[]): ContentState {
  const states = [...jobStates];
  if (states.length === 0) return "scheduled";

  const succeeded = states.filter((s) => SUCCEEDED_STATES.has(s));
  const failedCount = states.filter((s) => s === "failed").length;
  const canceledCount = states.filter((s) => s === "canceled").length;
  const activeCount = states.filter((s) => ACTIVE_STATES.has(s)).length;

  if (canceledCount === states.length) return "canceled";
  if (succeeded.length === states.length) return "published";
  if (succeeded.length > 0 && (failedCount > 0 || canceledCount > 0)) return "partial";
  if (activeCount === 0 && failedCount > 0) return "failed";
  return "scheduled";
}