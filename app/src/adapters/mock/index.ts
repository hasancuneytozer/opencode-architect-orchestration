/**
 * Sahte adaptörlerin tek giriş noktası.
 *
 * Kullanım:
 * ```ts
 * const adapters: ReadonlyMap<Platform, PublishAdapter> = new Map([
 *   ["instagram", mockAdapter("instagram")],
 *   ["tiktok", mockAdapter("tiktok", { failFirstN: 2, failKind: "ratelimit" })],
 *   ["youtube", mockAdapter("youtube", { startResult: "immediate" })],
 * ]);
 * ```
 */
import type { Platform } from "../../contract/index.js";
import { PLATFORMS } from "../../contract/index.js";
import type { PublishAdapter } from "../../ports/index.js";
import {
  MockPublishAdapter,
  type MockPublishAdapterOptions,
  type MockPublishRecord,
  type MockScript,
} from "./publisher.js";

export { MockPublishAdapter, mockExternalId } from "./publisher.js";
export type {
  MockScript,
  MockPublishAdapterOptions,
  MockPublishRecord,
  MockPublishStatus,
  MockCounters,
} from "./publisher.js";

/** Tek adaptör. `script` verilmezse "her şey bir turda yayınlanır". */
export function mockAdapter(
  platform: Platform,
  script?: MockScript,
  opts?: MockPublishAdapterOptions,
): MockPublishAdapter {
  return new MockPublishAdapter(platform, script ?? {}, opts);
}

/**
 * Verilen senaryolarla ÜÇ platformun adaptörleri. Verilmeyen platform için
 * `defaultScript` kullanılır; `null` → o platform için adaptör YOKtur, motor
 * "adaptör yok" gerekçesiyle işi sessizce başarısız saymadan atlar.
 */
export function mockAdapters(
  scripts: Partial<Record<Platform, MockScript | null>>,
  opts: MockPublishAdapterOptions = {},
  defaultScript: MockScript | null = {},
): Map<Platform, MockPublishAdapter> {
  const map = new Map<Platform, MockPublishAdapter>();
  for (const platform of PLATFORMS) {
    const script = scripts[platform] ?? defaultScript;
    if (script === null) continue;
    map.set(platform, new MockPublishAdapter(platform, script, opts));
  }
  return map;
}

/** `ReadonlyMap` bekleyen yerlere doğrudan verilebilir. */
export function asAdapterMap(
  adapters: Iterable<PublishAdapter>,
): ReadonlyMap<Platform, PublishAdapter> {
  return new Map([...adapters].map((a) => [a.platform, a as PublishAdapter]));
}

/** Üç platformun sahte adaptörü + paylaşılan senaryo. */
export function defaultMockAdapters(
  script: MockScript = {},
  opts: MockPublishAdapterOptions = {},
): Map<Platform, MockPublishAdapter> {
  return mockAdapters({}, opts, script);
}
