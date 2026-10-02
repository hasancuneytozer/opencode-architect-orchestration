/**
 * ZAMANLAYICI TUTAMAĞI — HTTP katmanının gördüğü zamanlayıcı yüzeyi.
 *
 * Neden var: `Scheduler` sınıfı `isRunning`, `ticks`, `skipped` okuyucularını
 * sunar ama `tickMs`, `lastTickAt` ve `nextTickAt` bilgisini TAŞIMAZ (bunlar
 * `main.ts`'in kurulum kararıdır). HTTP katmanı bu değerleri üç ayrı yerden
 * toplamaya çalışırsa panele gösterilen "son tick" bilgisi ile gerçek tick
 * arasında kayma olur. Burada TEK bir yüzey tanımlanır; testler de sahte bir
 * tutamakla gerçek `Scheduler` kullanmadan bu yüzeyi doğrulayabilir.
 */
import type { Scheduler, TickResult } from "../services/index.js";

export interface SchedulerStatus {
  running: boolean;
  tickMs: number;
  /** Son tamamlanan tick'in zamanı (ISO). Hiç olmadıysa null. */
  lastTickAt: string | null;
  /** Bir sonraki tick'in beklenen zamanı (ISO). Döngü kapalıysa null. */
  nextTickAt: string | null;
}

export interface SchedulerHandle {
  status(): SchedulerStatus;
  runOnce(): Promise<TickResult>;
  start(): void;
  stop(): void;
  /**
   * Döngü tiklerini DIŞARIDAN bildirir. `Scheduler.onTick` yapıcı seçeneğidir
   * ve sonradan bağlanamaz; `main.ts` kendi dinleyicisini kurarken bunu
   * çağırır, böylece panel periyodik tikleri de görür.
   */
  noteTick(at?: string): void;
}

export interface WrapOptions {
  scheduler: Scheduler;
  tickMs: number;
  now?: () => Date;
}

/**
 * Gerçek zamanlayıcıyı HTTP yüzeyine sarar.
 *
 * `nextTickAt` bir TAHMİNDİR (`lastTickAt + tickMs`): periyodik bir döngü için
 * bu en dürüst ifadedir. "Kesin olacak" denip `new Date(now + tickMs)` yazmak,
 * `stop()` sonrası veya süre kaymasında yanlış saat gösterirdi. İlk tick'ten
 * önce `lastTickAt` null ise "bir sonraki beklenti" olarak şimdi döner.
 */
export function wrapScheduler(opts: WrapOptions): SchedulerHandle {
  const { scheduler, tickMs } = opts;
  const now = opts.now ?? (() => new Date());
  let lastTickAt: string | null = null;

  const handle: SchedulerHandle = {
    status(): SchedulerStatus {
      const running = scheduler.isRunning;
      const base = lastTickAt === null ? now().getTime() : Date.parse(lastTickAt);
      return {
        running,
        tickMs,
        lastTickAt,
        nextTickAt: running ? new Date(base + tickMs).toISOString() : null,
      };
    },
    async runOnce(): Promise<TickResult> {
      const result = await scheduler.runOnce();
      handle.noteTick();
      return result;
    },
    start(): void {
      scheduler.start();
    },
    stop(): void {
      scheduler.stop();
    },
    noteTick(at?: string): void {
      lastTickAt = at ?? now().toISOString();
    },
  };
  return handle;
}

/** Testler için: gerçek zamanlayıcıya bağlanmadan yüzey üreten tutamak. */
export interface FakeSchedulerOptions {
  tickMs?: number;
  running?: boolean;
  now?: () => Date;
  result?: TickResult;
  /** `runOnce` çağrılarını kaydet (test "tick'e bir istek gitti" diyor). */
  calls?: number;
}

export function emptyTickResult(): TickResult {
  return {
    claimed: 0,
    published: 0,
    scheduled: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };
}

/** Test yardımcısı: `SchedulerHandle` sahte uygulaması. */
export function fakeScheduler(opts: FakeSchedulerOptions = {}): SchedulerHandle {
  const now = opts.now ?? (() => new Date());
  let running = opts.running ?? false;
  let lastTickAt: string | null = null;
  const calls = { count: opts.calls ?? 0 };

  return {
    status(): SchedulerStatus {
      const base = lastTickAt === null ? now().getTime() : Date.parse(lastTickAt);
      return {
        running,
        tickMs: opts.tickMs ?? 15_000,
        lastTickAt,
        nextTickAt: running ? new Date(base + (opts.tickMs ?? 15_000)).toISOString() : null,
      };
    },
    async runOnce(): Promise<TickResult> {
      calls.count += 1;
      lastTickAt = now().toISOString();
      return opts.result ?? emptyTickResult();
    },
    start(): void {
      running = true;
    },
    stop(): void {
      running = false;
    },
    noteTick(at?: string): void {
      lastTickAt = at ?? now().toISOString();
    },
  };
}