/**
 * Durum sayacı. SAF ve testli — günlük ekranının üstündeki rozetler buradan gelir.
 * `published` ve `published_no_link` AYRI sayılır: linki olmayan yayın
 * "yayınlandı" rozetine gömülmez.
 */
import type { JobState, PublishErrorKind, PublishJob } from "../api/types.js";

export type JobStateCounts = Record<JobState, number>;

export function emptyJobStateCounts(): JobStateCounts {
  return {
    queued: 0,
    preparing: 0,
    uploading: 0,
    processing: 0,
    published: 0,
    published_no_link: 0,
    failed: 0,
    canceled: 0,
  };
}

export function pageStateOf(jobs: readonly PublishJob[] | null | undefined): JobStateCounts {
  const counts = emptyJobStateCounts();
  for (const job of jobs ?? []) {
    const key = job.state;
    if (Object.hasOwn(counts, key)) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function hasError(job: PublishJob): boolean {
  return job.error !== null && job.error !== undefined;
}

/** Kaç iş hata taşıyor (başarısız OLMAYAN işler dâhil — `published_no_link` de hata taşır). */
export function countJobsWithError(jobs: readonly PublishJob[] | null | undefined): number {
  return (jobs ?? []).filter(hasError).length;
}

export function countFailed(jobs: readonly PublishJob[] | null | undefined): number {
  return (jobs ?? []).filter((job) => job.state === "failed").length;
}

export function countRetriableFailures(jobs: readonly PublishJob[] | null | undefined): number {
  return (jobs ?? []).filter((job) => job.state === "failed" && job.error?.retryable === true).length;
}

export function countPermanentFailures(jobs: readonly PublishJob[] | null | undefined): number {
  return (jobs ?? []).filter((job) => job.state === "failed" && job.error?.retryable !== true).length;
}

export function countPublishedNoLink(jobs: readonly PublishJob[] | null | undefined): number {
  return (jobs ?? []).filter((job) => job.state === "published_no_link").length;
}

export type ErrorKindCounts = Partial<Record<PublishErrorKind, number>>;

export function countErrorKinds(jobs: readonly PublishJob[] | null | undefined): ErrorKindCounts {
  const counts: ErrorKindCounts = {};
  for (const job of jobs ?? []) {
    const kind = job.error?.kind;
    if (kind === undefined) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** En sık görülen hata sınıfı (eşitlikte alfabetik — deterministik). */
export function topErrorKind(jobs: readonly PublishJob[] | null | undefined): PublishErrorKind | null {
  const counts = countErrorKinds(jobs);
  let best: PublishErrorKind | null = null;
  let bestCount = 0;
  for (const kind of Object.keys(counts).sort() as PublishErrorKind[]) {
    const count = counts[kind] ?? 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}