/**
 * ZAMLAYICI — `PublishService.tick()`'i periyodik olarak çağırır.
 *
 * ── ÜÇ KURAL, ÜÇÜ DE TEST EDİLEBİLİR ───────────────────────────────────────
 *
 * 1) **ÖRTÜŞEN TICK YOK.** Bir tick sürerken yenisi başlamaz. Nedeni
 *    `claimDue`'un atomik olması DEĞİLDİR (o doğru): örtüşen iki tick aynı işi
 *    iki kez "ilerletir", `pollPublish` iki kez çağrılır ve sağlayıcı tarafında
 *    çift iş yükü oluşur. Kilit `busy` bayrağıyla tutulur; kaçırılan tick
 *    `skippedTicks` olarak SAYILIR — sessizce yutulmaz.
 *
 * 2) **SCHEDULER ASLA ÖLMEZ.** `tick()` bir hata fırlatsa bile döngü devam
 *    eder; hata `onError`'a verilir ve bir sonraki tick normal çalışır.
 *    Zamanlayıcı, işlerin durduğu tek yerdir; onun ölmesi "hiçbir şey
 *    yayınlanmıyor" demektir ve bu, tek bir bozuk işten daha kötüdür.
 *
 * 3) **`unref()`.** Zamanlayıcı sürecin kapanmasını ENGELLEMEZ. `setInterval`
 *    varsayılan olarak süreci ayakta tutar; bir CLI komutundan sonra asılı
 *    kalmış bir uygulama "bitmedi" görünür. `unref` bu varsayılanı kaldırır.
 */
import type { TickResult } from "./publisher.js";
import type { PublishService } from "./publisher.js";

/**
 * Varsayılan aralık. `SP_SCHEDULER_TICK_MS` ile aynı değer (bkz.
 * `src/config`). Burada SABİT yazılır ki servis katmanı ortam değişkeni
 * okumasın: okuması gereken tek yer `src/config`'tir, burada yalnız eşleştirme
 * yapılır.
 */
export const DEFAULT_SCHEDULER_TICK_MS = 15_000;

/** Testler ve CLI için kabul edilen en küçük aralık (config sınırıyla aynı). */
export const MIN_SCHEDULER_TICK_MS = 250;

export interface SchedulerOptions {
  /** `SP_SCHEDULER_TICK_MS`. Varsayılan 15_000. */
  tickMs?: number;
  /** `tick(limit)` için üst sınır. */
  limit?: number;
  /**
   * Tick hatası. Verilmezse `console.error`'a düşer. Zamanlayıcının kendi
   * hatasını YUTMAMASI gerekir, ama çağıranın da haberdar olması gerekir.
   */
  onError?: (error: unknown) => void;
  /** Tick sonucunu gözlemlemek için (test: kaç tick koştu, kaç iş işlendi). */
  onTick?: (result: TickResult) => void;
}

export class Scheduler {
  private readonly service: PublishService;
  private readonly tickMs: number;
  private readonly limit: number | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly onTick: ((result: TickResult) => void) | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private tickCount = 0;
  private skippedTicks = 0;
  private lastError: unknown = null;

  constructor(service: PublishService, opts: SchedulerOptions = {}) {
    this.service = service;
    this.tickMs = clampTickMs(opts.tickMs);
    this.limit = opts.limit;
    this.onError = opts.onError ?? ((err: unknown) => console.error("[scheduler] tick hatası:", err));
    this.onTick = opts.onTick ?? null;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Tamamlanmış tick sayısı (istatistik ve testler için). */
  get ticks(): number {
    return this.tickCount;
  }

  /** Örtüşme nedeniyle ATLANAN tick sayısı. Sıfır olmalıdır. */
  get skipped(): number {
    return this.skippedTicks;
  }

  /** Son hatada görülen hata (başarılı tick'te `null` olmaz; sadece okunur). */
  get lastTickError(): unknown {
    return this.lastError;
  }

  /** Döngüyü başlatır. Zaten çalışıyorsa ETKİSİZDİR (çift interval yok). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.loopOnce();
    }, this.tickMs);
    // Süreç kapanırken takılmasın: zamanlayıcı ayakta tutmaz.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Döngüyü durdurur. Durmamışsa ETKİSİZDİR. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Elle bir tur. Testler ve CLI için.
   *
   * Bu çağrı DÖNGÜ KİLİTİNİ BEKLEMEZ ve kilidi de almaz: açık bir "şimdi çalıştır"
   * isteğidir. Periyodik döngü ise kilide uyar. (İkisi aynı anda çalışırsa
   * `claimDue` atomik kiralama sayesinde aynı iş iki kez ilerletilmez; en kötü
   * hata fazladan bir yoklama çağrısıdır.)
   */
  async runOnce(): Promise<TickResult> {
    return this.invoke();
  }

  /** Periyodik döngünün bir adımı: kilit, hata yutma, sayım. */
  private async loopOnce(): Promise<void> {
    if (this.busy) {
      this.skippedTicks += 1;
      this.onError(new Error(`Tick hâlâ sürüyor (${this.tickCount + 1}. tur atlandı).`));
      return;
    }
    await this.invoke();
  }

  /** Ortak çalıştırma: hata asla dışarı çıkmaz. */
  private async invoke(): Promise<TickResult> {
    this.busy = true;
    try {
      const result = await (this.limit === undefined
        ? this.service.tick()
        : this.service.tick(this.limit));
      this.tickCount += 1;
      this.lastError = null;
      this.onTick?.(result);
      return result;
    } catch (err) {
      // 2) Zamanlayıcı ölmez. Hata burada BİTER.
      this.lastError = err;
      this.onError(err);
      return {
        claimed: 0,
        published: 0,
        scheduled: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
        details: [],
      };
    } finally {
      this.busy = false;
    }
  }
}

function clampTickMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SCHEDULER_TICK_MS;
  }
  // Config 250 ms altını reddeder; burada da aynı taban kullanılır ki CLI ile
  // sunucu arasında "farklı" bir aralık çıkmasın.
  return Math.max(MIN_SCHEDULER_TICK_MS, Math.floor(value));
}
