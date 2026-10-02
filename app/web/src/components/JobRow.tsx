/**
 * İş (job) satırı ve hata analizi.
 *
 * Kritik davranış: `published` ↔ `published_no_link` AYRI rozetlerdir. Linki
 * olmayan yayın "yayınlandı" gibi gösterilmez — "Yayınlandı, link yok" denir.
 */
import type { PublishFailure, PublishJob } from "../api/types.js";
import { formatRelativeTime, formatZonedDateTime, DASH } from "../lib/format.js";
import { ERROR_KIND_META, JOB_STATE_META } from "../lib/labels.js";
import { Badge } from "./Badge.js";
import { PlatformBadge } from "./PlatformBits.js";
import { Button } from "./Ui.js";

/** `retryable: false` ise "Tekrar denenmeyecek" rozeti gösterilir. */
export function FailureDetail({
  failure,
  timezone,
  nowMs,
}: {
  failure: PublishFailure | null;
  timezone: string;
  nowMs: number;
}) {
  if (failure === null) return null;
  const meta = ERROR_KIND_META[failure.kind];
  return (
    <div className="space-y-1 rounded border border-line-soft bg-elev/40 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={failure.retryable ? "warn" : "danger"}>{meta.label}</Badge>
        {failure.retryable ? (
          <Badge tone="info" title="Sunucu bu hatayı geçici saydı ve otomatik yeniden deneyecek.">
            otomatik tekrar
          </Badge>
        ) : (
          <Badge tone="muted" title="Yeniden denemek anlamlı değil; önce nedeni giderin.">
            Tekrar denenmeyecek
          </Badge>
        )}
      </div>
      <p className="text-[12px] text-fg">{meta.detail}</p>
      <p className="text-[12px] text-muted">Yapılacak: {meta.action}</p>
      {failure.message === "" ? null : (
        <p className="font-mono text-[11px] text-muted">mesaj: {failure.message}</p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-faint">sağlayıcı kodu</dt>
          <dd className="font-mono text-fg">{failure.providerCode ?? DASH}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-faint">logId</dt>
          <dd className="font-mono text-fg">{failure.logId ?? DASH}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-faint">HTTP</dt>
          <dd className="font-mono text-fg">{failure.httpStatus ?? DASH}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-faint">retry-after</dt>
          <dd className="font-mono text-fg">
            {failure.retryAfterMs === null ? DASH : `${Math.round(failure.retryAfterMs / 1000)} sn`}
          </dd>
        </div>
        <div className="col-span-2 flex justify-between gap-2">
          <dt className="text-faint">zaman</dt>
          <dd className="font-mono text-fg">
            {formatZonedDateTime(failure.at, timezone)} · {formatRelativeTime(failure.at, nowMs)}
          </dd>
        </div>
      </dl>
      {failure.logId === null ? (
        <p className="text-[10px] text-faint">
          logId yalnız TikTok&apos;da gelir; diğer platformlarda destek talebi için sağlayıcı kodunu kullanın.
        </p>
      ) : null}
    </div>
  );
}

export function JobStateBadge({ state }: { state: PublishJob["state"] }) {
  const meta = JOB_STATE_META[state];
  const live = meta.tone === "progress";
  return (
    <Badge tone={meta.tone} live={live} title={meta.help}>
      {meta.label}
    </Badge>
  );
}

export function JobProgress({ job }: { job: PublishJob }) {
  if (job.totalParts === null || job.totalParts === 0) return null;
  const pct = Math.min(100, Math.round((job.uploadedParts / job.totalParts) * 100));
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="block h-1.5 w-16 overflow-hidden rounded bg-line"
        role="img"
        aria-label={`Yükleme ilerlemesi yüzde ${pct}`}
      >
        <span className="block h-full bg-info" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-[11px] text-muted">
        {job.uploadedParts}/{job.totalParts}
      </span>
    </span>
  );
}

export function JobRow({
  job,
  timezone,
  nowMs,
  onRetry,
  retrying,
  contentLink,
}: {
  job: PublishJob;
  timezone: string;
  nowMs: number;
  onRetry?: (job: PublishJob) => void;
  retrying?: boolean;
  contentLink?: string | null;
}) {
  const canRetry = onRetry !== undefined && (job.state === "failed" || job.state === "canceled");
  return (
    <li className="space-y-1.5 border-b border-line-soft px-2 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <PlatformBadge platform={job.platform} />
        <JobStateBadge state={job.state} />
        <Badge tone={job.attempts > 1 ? "warn" : "muted"}>deneme {job.attempts}</Badge>
        {job.state === "published_no_link" ? (
          <span className="text-[11px] text-orange">
            Yayın tamam, kalıcı bağlantı yok — içerik yayında ama izlenemez.
          </span>
        ) : null}
        {contentLink === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              window.location.hash = contentLink ?? "";
            }}
            className="text-[11px] text-accent underline"
          >
            içeriğe git
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted">
          {formatZonedDateTime(job.scheduledAt, timezone)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>oluşturma {formatRelativeTime(job.createdAt, nowMs)}</span>
        {job.startedAt === null ? null : <span>başlama {formatRelativeTime(job.startedAt, nowMs)}</span>}
        {job.finishedAt === null ? null : (
          <span>bitiş {formatRelativeTime(job.finishedAt, nowMs)}</span>
        )}
        {job.nextAttemptAt !== null ? (
          <span>sonraki deneme {formatRelativeTime(new Date(job.nextAttemptAt).toISOString(), nowMs)}</span>
        ) : null}
        {job.state === "published" || job.state === "published_no_link" ? (
          <>
            <span>uzak kimlik {job.remoteId ?? DASH}</span>
            {job.permalink === null ? (
              <span className="text-orange">permalink yok</span>
            ) : (
              <a
                href={job.permalink}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline"
              >
                yayını aç
              </a>
            )}
          </>
        ) : null}
        <JobProgress job={job} />
      </div>

      <FailureDetail failure={job.error} timezone={timezone} nowMs={nowMs} />

      {canRetry ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" busy={retrying === true} onClick={() => onRetry(job)}>
            Yeniden Dene
          </Button>
          {job.error !== null && job.error.retryable ? (
            <span className="text-[11px] text-muted">
              Bu hata geçici sayılmıştı; yeniden denemek anlamlı.
            </span>
          ) : job.error !== null ? (
            <span className="text-[11px] text-warn">
              Bu hata kalıcı; önce düzeltin ({ERROR_KIND_META[job.error.kind].action}).
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Hata sınıflarının insan dili karşılığı — günlük sayfasının üst kısmında. */
export function ErrorLegend() {
  const kinds = Object.entries(ERROR_KIND_META) as Array<
    [PublishFailure["kind"], (typeof ERROR_KIND_META)[PublishFailure["kind"]]]
  >;
  return (
    <details className="rounded border border-line-soft px-2 py-1.5">
      <summary className="cursor-pointer text-[12px] font-medium text-muted">
        Hata sınıfları ne anlama geliyor? ({kinds.length} sınıf)
      </summary>
      <table className="mt-1.5 w-full border-collapse text-[11px]">
        <caption className="sr-only">Yayın hata sınıflarının açıklamaları</caption>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="py-1 font-medium">
              Sınıf
            </th>
            <th scope="col" className="py-1 font-medium">
              Anlamı
            </th>
            <th scope="col" className="py-1 font-medium">
              Otomatik tekrar
            </th>
          </tr>
        </thead>
        <tbody>
          {kinds.map(([kind, meta]) => (
            <tr key={kind} className="border-b border-line-soft last:border-0 align-top">
              <td className="py-1 pr-2">
                <Badge tone={meta.autoRetryable ? "warn" : "danger"}>{meta.label}</Badge>
                <span className="ml-1 font-mono text-[10px] text-faint">{kind}</span>
              </td>
              <td className="py-1 pr-2 text-fg">{meta.detail}</td>
              <td className="py-1">{meta.autoRetryable ? "evet" : "hayır"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}