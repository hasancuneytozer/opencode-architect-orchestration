/**
 * Yayın Günlüğü: iş listesi + hata analizi.
 * Uçlar: GET /v1/jobs, /v1/jobs/:id, POST /v1/jobs/:id/retry
 */
import { useMemo, useState } from "react";

import { getJob, listJobs, retryJob } from "../api/endpoints.js";
import { useAction, useAsync } from "../api/hooks.js";
import type { JobState, Platform, PublishJob } from "../api/types.js";
import { ErrorLegend, JobRow, JobStateBadge } from "../components/JobRow.js";
import { PlatformBadge } from "../components/PlatformBits.js";
import { Badge } from "../components/Badge.js";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Panel,
  Select,
  TextInput,
} from "../components/Ui.js";
import { DASH, formatRelativeTime } from "../lib/format.js";
import { emptyJobFilters, filterJobs, pageInfo } from "../lib/filters.js";
import type { JobFilterState } from "../lib/filters.js";
import { ERROR_KIND_META, JOB_STATE_META, PLATFORM_META } from "../lib/labels.js";
import { pageStateOf } from "../lib/logStats.js";

const ALL_JOB_STATES: JobState[] = [
  "queued",
  "preparing",
  "uploading",
  "processing",
  "published",
  "published_no_link",
  "failed",
  "canceled",
];

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];

function CountRow({ jobs, nowMs, timezone }: { jobs: PublishJob[]; nowMs: number; timezone: string }) {
  const stats = pageStateOf(jobs);
  return (
    <div className="flex flex-wrap gap-1.5">
      {ALL_JOB_STATES.map((state) => {
        const count = stats[state] ?? 0;
        const meta = JOB_STATE_META[state];
        return (
          <Badge key={state} tone={count > 0 ? meta.tone : "muted"} title={meta.help}>
            {meta.label}: {count}
          </Badge>
        );
      })}
      <Badge tone="muted">toplam: {jobs.length}</Badge>
      {(stats["published_no_link"] ?? 0) > 0 ? (
        <Badge tone="orange" title="Yayın tamam ama kalıcı bağlantı yok — izlenemeyen yayın.">
          link yok: {stats["published_no_link"] ?? 0}
        </Badge>
      ) : null}
      <span className="text-[11px] text-muted">
        en yeni güncelleme{" "}
        {jobs.length === 0 ? DASH : formatRelativeTime(formatNewest(jobs), nowMs)}
      </span>
    </div>
  );
}

function formatNewest(jobs: PublishJob[]): string {
  let newest = jobs[0];
  for (const job of jobs) {
    if (newest === undefined || job.updatedAt > newest.updatedAt) newest = job;
  }
  return newest?.updatedAt ?? new Date().toISOString();
}

function ErrorBreakdown({ jobs }: { jobs: PublishJob[] }) {
  const counts = new Map<string, { count: number; retryable: number }>();
  for (const job of jobs) {
    const failure = job.error;
    if (failure === null) continue;
    const current = counts.get(failure.kind);
    if (current === undefined) {
      counts.set(failure.kind, { count: 1, retryable: failure.retryable ? 1 : 0 });
    } else {
      counts.set(failure.kind, {
        count: current.count + 1,
        retryable: current.retryable + (failure.retryable ? 1 : 0),
      });
    }
  }
  const entries = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    return <EmptyState title="Hata yok." hint="Görünen işlerde `error` alanı dolu değil." />;
  }
  return (
    <table className="w-full border-collapse text-[12px]">
      <caption className="sr-only">Hata sınıflarına göre iş sayısı</caption>
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th scope="col" className="py-1 font-medium">Sınıf</th>
          <th scope="col" className="py-1 text-right font-medium">İş</th>
          <th scope="col" className="py-1 text-right font-medium">Tekrar</th>
          <th scope="col" className="py-1 font-medium">Anlamı</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([kind, stat]) => {
          const meta = ERROR_KIND_META[kind as keyof typeof ERROR_KIND_META];
          if (meta === undefined) return null;
          return (
            <tr key={kind} className="border-b border-line-soft last:border-0 align-top">
              <td className="py-1 pr-2">
                <Badge tone={meta.autoRetryable ? "warn" : "danger"}>{meta.label}</Badge>
                <span className="ml-1 font-mono text-[10px] text-faint">{kind}</span>
              </td>
              <td className="py-1 pr-2 text-right font-mono text-fg">{stat.count}</td>
              <td className="py-1 pr-2 text-right font-mono text-muted">
                {stat.retryable}/{stat.count}
              </td>
              <td className="py-1 text-fg">{meta.detail}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Log() {
  const [filters, setFilters] = useState<JobFilterState>(emptyJobFilters);
  const [selected, setSelected] = useState<PublishJob | null>(null);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const action = useAction();
  const nowMs = Date.now();

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Istanbul";
    } catch {
      return "Europe/Istanbul";
    }
  }, []);

  const jobs = useAsync(() => listJobs({ limit, offset }), [limit, offset]);
  const all = jobs.data?.items ?? [];
  const visible = useMemo(() => filterJobs(all, filters), [all, filters]);
  const info = pageInfo(jobs.data?.total ?? all.length, limit, offset);
  const detail = useAsync(
    () => (selected === null ? Promise.resolve(null) : getJob(selected.id)),
    [selected?.id, selected === null],
    selected !== null,
  );

  return (
    <div className="space-y-3">
      <Panel
        title="Yayın Günlüğü"
        subtitle={`${info.from}-${info.to} / ${info.total} iş · sayfa ${info.page}/${info.pages}`}
        actions={
          <>
            <Button disabled={!info.hasPrev} onClick={() => setOffset(Math.max(0, offset - limit))}>
              ← önceki sayfa
            </Button>
            <Button disabled={!info.hasNext} onClick={() => setOffset(offset + limit)}>
              sonraki sayfa →
            </Button>
            <Button onClick={jobs.reload}>Yenile</Button>
          </>
        }
      >
        <div className="space-y-2">
          <CountRow jobs={all} nowMs={nowMs} timezone={timezone} />

          <div className="flex flex-wrap items-end gap-2">
            <Field label="İş durumu" htmlFor="j-state">
              <Select
                id="j-state"
                value=""
                onChange={(e) => {
                  const value = e.currentTarget.value as JobState | "";
                  if (value === "") {
                    setFilters({ ...filters, states: [] });
                    return;
                  }
                  setFilters({
                    ...filters,
                    states: filters.states.includes(value)
                      ? filters.states.filter((s) => s !== value)
                      : [...filters.states, value],
                  });
                }}
              >
                <option value="">Tümü</option>
                {ALL_JOB_STATES.map((s) => (
                  <option key={s} value={s}>
                    {JOB_STATE_META[s].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Platform" htmlFor="j-platform">
              <Select
                id="j-platform"
                value=""
                onChange={(e) => {
                  const value = e.currentTarget.value as Platform | "";
                  if (value === "") {
                    setFilters({ ...filters, platforms: [] });
                    return;
                  }
                  setFilters({
                    ...filters,
                    platforms: filters.platforms.includes(value)
                      ? filters.platforms.filter((p) => p !== value)
                      : [...filters.platforms, value],
                  });
                }}
              >
                <option value="">Tümü</option>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_META[p].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="İş/İçerik kimliği" htmlFor="j-query">
              <TextInput
                id="j-query"
                value={filters.query}
                onChange={(e) => setFilters({ ...filters, query: e.currentTarget.value })}
              />
            </Field>
            <div className="flex flex-col gap-1.5 pb-0.5">
              <Checkbox
                label="Yalnız başarısızlar"
                checked={filters.onlyFailed}
                onChange={(v) => setFilters({ ...filters, onlyFailed: v })}
              />
              <Checkbox
                label="Hata taşıyanlar"
                checked={filters.onlyWithError}
                onChange={(v) => setFilters({ ...filters, onlyWithError: v })}
              />
            </div>
            <Button onClick={() => setFilters(emptyJobFilters())}>Temizle</Button>
          </div>

          {filters.states.length > 0 || filters.platforms.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">seçili:</span>
              {filters.states.map((s) => (
                <Badge key={s} tone={JOB_STATE_META[s].tone}>
                  {JOB_STATE_META[s].label}
                </Badge>
              ))}
              {filters.platforms.map((p) => (
                <PlatformBadge key={p} platform={p} />
              ))}
            </div>
          ) : null}

          {jobs.loading ? <Loading label="İşler yükleniyor…" /> : null}
          {jobs.error !== null ? <ErrorBox error={jobs.error} onRetry={jobs.reload} /> : null}

          {jobs.settled && jobs.error === null && all.length === 0 ? (
            <EmptyState
              title="İş kaydı yok."
              hint="Zamanlanan içerikler zamanı geldiğinde iş oluşturur."
            />
          ) : null}

          {all.length > 0 && visible.length === 0 ? (
            <EmptyState title="Filtreye uyan iş yok." hint="Filtreleri temizleyin." />
          ) : null}

          {action.error !== null ? <ErrorBox error={action.error} /> : null}

          <ul className="rounded border border-line bg-panel">
            {visible.map((job) => (
              <div key={job.id} className="border-b border-line-soft last:border-0">
                <div className="flex items-center gap-2 px-2 pt-1.5">
                  <button
                    type="button"
                    onClick={() => setSelected(job)}
                    aria-expanded={selected?.id === job.id}
                    className="font-mono text-[10px] text-accent hover:underline"
                  >
                    {selected?.id === job.id ? "detayı gizle" : "detay"}
                  </button>
                  <span className="text-[10px] text-faint">{job.id}</span>
                </div>
                <ul className="list-none">
                  <JobRow
                    job={job}
                    timezone={timezone}
                    nowMs={nowMs}
                    retrying={action.busy}
                    onRetry={(target) => {
                      void action
                        .run(async () => {
                          await retryJob(target.id);
                          jobs.reload();
                        })
                        .then(() => undefined);
                    }}
                  />
                </ul>
              </div>
            ))}
          </ul>
        </div>
      </Panel>

      {selected !== null ? (
        <Panel title={`İş detayı · ${selected.id}`} subtitle="GET /api/v1/jobs/:id">
          {detail.loading ? <Loading /> : null}
          {detail.error !== null ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : null}
          {detail.data === null ? null : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <PlatformBadge platform={detail.data.platform} full />
                <JobStateBadge state={detail.data.state} />
                <Badge tone="muted">deneme {detail.data.attempts}</Badge>
                <Badge tone="muted">idempotency {detail.data.idempotencyKey.slice(0, 12)}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">externalId</dt>
                  <dd className="font-mono text-fg">{detail.data.externalId ?? DASH}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">remoteId</dt>
                  <dd className="font-mono text-fg">{detail.data.remoteId ?? DASH}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">permalink</dt>
                  <dd className="truncate font-mono text-fg">{detail.data.permalink ?? DASH}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">yüklenen parça</dt>
                  <dd className="font-mono text-fg">
                    {detail.data.uploadedParts}/{detail.data.totalParts ?? DASH}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">leaseOwner</dt>
                  <dd className="font-mono text-fg">{detail.data.leaseOwner ?? DASH}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-faint">idempotency ilk kullanım</dt>
                  <dd className="font-mono text-fg">
                    {detail.data.idempotencyFirstUsedAt === null
                      ? DASH
                      : formatRelativeTime(detail.data.idempotencyFirstUsedAt, nowMs)}
                  </dd>
                </div>
              </dl>
              <ul>
                <JobRow
                  job={detail.data}
                  timezone={timezone}
                  nowMs={nowMs}
                  retrying={action.busy}
                  onRetry={(target) => {
                    void action
                      .run(async () => {
                        await retryJob(target.id);
                        detail.reload();
                        jobs.reload();
                      })
                      .then(() => undefined);
                  }}
                />
              </ul>
            </div>
          )}
        </Panel>
      ) : null}

      <Panel title="Hata analizi" subtitle="Hata sınıflarının insan dili karşılığı">
        <div className="space-y-2">
          <ErrorBreakdown jobs={all} />
          <ErrorLegend />
        </div>
      </Panel>
    </div>
  );
}