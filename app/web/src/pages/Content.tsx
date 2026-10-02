/**
 * İçerik & Takvim — GET /v1/content, /v1/content/:id, /v1/jobs
 * PATCH /v1/content/:id, POST approve | publish-now | cancel, POST /v1/jobs/:id/retry
 *
 * İki görünüm: TAKVİM (hafta, sütunlar gün, yerel saat dilimi) ve LİSTE.
 * Takvim verisi UTC gelir, yerele çevirme `lib/schedule.ts` içinde saf ve testli.
 */
import { useEffect, useMemo, useState } from "react";

import {
  approveContent,
  cancelContent,
  getContent,
  listContent,
  listJobs,
  normalizeContentDetail,
  patchContent,
  publishNow,
  retryJob,
} from "../api/endpoints.js";
import { useAction, useAsync } from "../api/hooks.js";
import type {
  ContentDetail,
  ContentItem,
  ContentState,
  Platform,
  PublishJob,
  QuietHours,
  ValidationFinding,
} from "../api/types.js";
import { Badge } from "../components/Badge.js";
import { JobRow } from "../components/JobRow.js";
import { PlatformBadge, TimeZonePicker } from "../components/PlatformBits.js";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Counter,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Panel,
  Select,
  Textarea,
  TextInput,
} from "../components/Ui.js";
import {
  COPY_FIELDS,
  fieldsForPlatform,
  joinTags,
  mergeCopy,
  overLimitFields,
  readField,
  splitTags,
  usageForField,
} from "../lib/copy.js";
import type { CopyField } from "../lib/copy.js";
import { DASH, formatRelativeTime, formatZonedDateTime, toDateTimeLocalValue, truncate } from "../lib/format.js";
import {
  campaigns as collectCampaigns,
  contentIsApproved,
  contentNeedsApproval,
  emptyContentFilters,
  filterContent,
} from "../lib/filters.js";
import type { ContentFilterState } from "../lib/filters.js";
import { CONTENT_STATE_META } from "../lib/labels.js";
import {
  addDays,
  buildWeekColumns,
  columnIndexInWeek,
  dayPositionPercent,
  describeQuietHours,
  isTimeOfDay,
  startOfWeek,
  weekTitle,
} from "../lib/schedule.js";
import { summarize } from "../lib/validation.js";

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];
const ALL_STATES: ContentState[] = [
  "draft",
  "validating",
  "ready",
  "scheduled",
  "published",
  "partial",
  "failed",
  "canceled",
];

/** İşleri hafta sütunlarına dağıtır. Gecikmede bile doğru hücreye düşer. */
function useCalendarBuckets(
  jobs: PublishJob[],
  weekStart: Date,
  timezone: string,
  nowMs: number,
): Array<{ key: string; jobs: PublishJob[] }> {
  return useMemo(() => {
    const columns = buildWeekColumns(weekStart, new Date(nowMs));
    const buckets = new Map<string, PublishJob[]>(columns.map((c) => [c.key, []]));
    const fallbackKey = columns.find((c) => c.isToday)?.key ?? columns[0]?.key;
    for (const job of jobs) {
      const t = Date.parse(job.scheduledAt);
      if (!Number.isFinite(t)) continue;
      const instant = new Date(t);
      const index = columnIndexInWeek(instant, weekStart, timezone);
      const key = index === -1 ? fallbackKey : columns[index]?.key;
      if (key === undefined) continue;
      const list = buckets.get(key);
      if (list === undefined) continue;
      list.push(job);
    }
    return [...buckets.entries()].map(([key, list]) => ({
      key,
      jobs: list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
    }));
  }, [jobs, weekStart, timezone, nowMs]);
}

function ContentStateBadge({ state }: { state: ContentState }) {
  const meta = CONTENT_STATE_META[state];
  return (
    <Badge tone={meta.tone} live={meta.tone === "progress"} title={meta.help}>
      {meta.label}
    </Badge>
  );
}

/** Platform başına ayrı metin alanları — sözleşmede `PerPlatformCopy` böyle. */
function CopyEditor({
  detail,
  onChange,
  onSave,
  saving,
}: {
  detail: ContentDetail;
  onChange: (next: ContentDetail) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const specs = fieldsForPlatform(platform);
  const problems = overLimitFields(detail.copy);

  const setField = (field: CopyField, raw: string): void => {
    const value = field === "hashtags" || field === "tags" ? splitTags(raw) : raw;
    onChange({ ...detail, copy: mergeCopy(detail.copy, platform, { [field]: value }) });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPlatform(p)}
            aria-pressed={platform === p}
            className={`rounded border px-2 py-1 text-[12px] ${
              platform === p ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
            }`}
          >
            {p === "instagram" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube"}
          </button>
        ))}
        <PlatformBadge platform={platform} />
      </div>

      {specs.map((spec) => {
        const current = readField(detail.copy, platform, spec.field);
        const usage = usageForField(
          spec.field === "hashtags" || spec.field === "tags" ? current : current,
          spec.field,
        );
        const isTagField = spec.field === "hashtags" || spec.field === "tags";
        return (
          <Field
            key={spec.field}
            label={`${spec.label} (${COPY_FIELDS[spec.field].max} karakter)`}
            htmlFor={`copy-${platform}-${spec.field}`}
            hint={spec.hint}
            error={usage.over ? `${usage.length} karakter — sınır ${usage.max}. Metin kırpılmadı, düzeltin.` : null}
          >
            {spec.multiline ? (
              <Textarea
                id={`copy-${platform}-${spec.field}`}
                rows={4}
                value={current}
                onChange={(e) => setField(spec.field, e.currentTarget.value)}
                aria-invalid={usage.over}
              />
            ) : (
              <TextInput
                id={`copy-${platform}-${spec.field}`}
                value={isTagField ? current.replace(/, /g, ", ") : current}
                onChange={(e) => setField(spec.field, e.currentTarget.value)}
                aria-invalid={usage.over}
                placeholder={isTagField ? "sürgü, yaz günü, 2026" : undefined}
              />
            )}
            <div className="flex items-center justify-between gap-2">
              <Counter used={usage.length} max={usage.max} />
              {isTagField ? (
                <span className="text-[11px] text-muted">
                  {splitTags(current).length} etiket · {joinTags(splitTags(current)) === "" ? "—" : joinTags(splitTags(current))}
                </span>
              ) : null}
            </div>
          </Field>
        );
      })}

      {problems.length === 0 ? null : (
        <div className="rounded border border-danger/50 bg-danger/10 px-2 py-1.5">
          <p className="text-[12px] font-semibold text-danger">Sınırı aşan alanlar:</p>
          <ul className="mt-0.5 list-inside list-disc text-[11px] text-fg">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted">
            Metin bilerek kırpılmadı. Sunucu da sınırı aşan metni sessizce kesmez; düzeltmeden yayın
            yapılamaz.
          </p>
        </div>
      )}

      <Button variant="primary" busy={saving} onClick={onSave}>
        Metni kaydet (PATCH)
      </Button>
    </div>
  );
}

function FindingsList({ findings }: { findings: ValidationFinding[] }) {
  const summary = summarize(findings);
  if (findings.length === 0) {
    return <p className="text-[12px] text-muted">Doğrulama bulgusu yok.</p>;
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={summary.ready ? "ok" : "danger"}>
          {summary.ready ? "yayına hazır" : "yayına hazır değil"}
        </Badge>
        {summary.errors > 0 ? <Badge tone="danger">{summary.errors} hata</Badge> : null}
        {summary.warnings > 0 ? <Badge tone="warn">{summary.warnings} uyarı</Badge> : null}
        {summary.provisional > 0 ? (
          <Badge tone="warn" title="Doğrulanmamış sınırlar">
            {summary.provisional} doğrulanmamış sınır
          </Badge>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {findings.slice(0, 12).map((f, i) => (
          <li key={`${f.code}-${i}`} className="text-[11px] text-fg">
            <Badge tone={f.severity === "error" ? "danger" : f.severity === "warning" ? "warn" : "info"}>
              {f.severity === "error" ? "hata" : f.severity === "warning" ? "uyarı" : "bilgi"}
            </Badge>{" "}
            {f.message}
            {f.observed === undefined ? null : (
              <span className="font-mono text-[10px] text-faint"> (ölçülen {f.observed})</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContentDetailPanel({
  item,
  timezone,
  nowMs,
  onChanged,
}: {
  item: ContentItem;
  timezone: string;
  nowMs: number;
  onChanged: () => void;
}) {
  const detail = useAsync(() => getContent(item.id), [item.id]);
  const action = useAction();
  const [draft, setDraft] = useState<ContentDetail | null>(null);
  const [localValue, setLocalValue] = useState<string>(toDateTimeLocalValue(item.scheduledAt, item.timezone));
  const [tz, setTz] = useState<string>(item.timezone);
  const [quietStart, setQuietStart] = useState<string>(item.quietHours?.start ?? "");
  const [quietEnd, setQuietEnd] = useState<string>(item.quietHours?.end ?? "");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const data = draft ?? detail.data;

  useEffect(() => {
    setDraft(null);
  }, [item.id]);

  const quietValid = (quietStart === "" && quietEnd === "") || (isTimeOfDay(quietStart) && isTimeOfDay(quietEnd));
  const needsApproval = data !== null ? contentNeedsApproval(data) : false;
  const approved = data !== null ? contentIsApproved(data) : false;

  const saveSchedule = async (): Promise<void> => {
    if (data === null) return;
    const quiet: QuietHours | null =
      isTimeOfDay(quietStart) && isTimeOfDay(quietEnd) ? { start: quietStart, end: quietEnd } : null;
    const ok = await action.run(async () => {
      const saved = await patchContent(item.id, {
        // Ofsetsiz yerel değer + timezone gönderilir; UTC'ye çevirmeyi SUNUCU yapar.
        scheduledAt: localValue === "" ? null : localValue,
        timezone: tz,
        quietHours: quiet,
        copy: data.copy,
      });
      setDraft(normalizeContentDetail(saved));
    });
    if (ok) onChanged();
  };

  return (
    <div className="space-y-3">
      <Panel
        title="İçerik"
        subtitle={`${item.id} · ${item.assetId}`}
        actions={<ContentStateBadge state={data?.state ?? item.state} />}
      >
        {detail.loading ? <Loading /> : null}
        {detail.error !== null ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : null}
        {data === null ? null : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={approved ? "ok" : "warn"}>
                {approved ? "onay alındı" : needsApproval ? "onay gerekli" : "onay gerekmiyor"}
              </Badge>
              {data.approvedBy === null ? null : (
                <span className="text-[11px] text-muted">
                  {data.approvedBy} · {formatRelativeTime(data.approvedAt, nowMs)}
                </span>
              )}
              <span className="text-[11px] text-muted">güncelleme {formatRelativeTime(data.updatedAt, nowMs)}</span>
            </div>
            <FindingsList findings={data.findings} />

            <CopyEditor
              detail={data}
              saving={action.busy}
              onChange={setDraft}
              onSave={() => {
                if (draft === null) return;
                void action
                  .run(async () => {
                    const saved = await patchContent(item.id, { copy: draft.copy });
                    setDraft(normalizeContentDetail(saved));
                  })
                  .then((ok) => {
                    if (ok) onChanged();
                  });
              }}
            />
          </div>
        )}
      </Panel>

      <Panel title="Zamanlama" subtitle="Yerel değer gönderilir; UTC çevrimi sunucuda yapılır">
        <div className="space-y-2">
          <Field
            label="Yayın zamanı (bu dilimde)"
            htmlFor="sched-local"
            hint={`Sunucuya ofsetsiz yerel değer + timezone gider. Şu anki ofset: ${tz}`}
          >
            <TextInput
              id="sched-local"
              type="datetime-local"
              value={localValue}
              onChange={(e) => setLocalValue(e.currentTarget.value)}
            />
          </Field>
          <Field label="Saat dilimi" htmlFor="sched-tz">
            <TimeZonePicker id="sched-tz" value={tz} onChange={setTz} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Sessiz saat başlangıç" htmlFor="q-start" hint="SS:DD">
              <TextInput id="q-start" value={quietStart} placeholder="23:00" onChange={(e) => setQuietStart(e.currentTarget.value)} />
            </Field>
            <Field label="Sessiz saat bitiş" htmlFor="q-end" hint="SS:DD">
              <TextInput id="q-end" value={quietEnd} placeholder="07:00" onChange={(e) => setQuietEnd(e.currentTarget.value)} />
            </Field>
          </div>
          <p className={`text-[11px] ${quietValid ? "text-muted" : "text-danger"}`}>
            {quietValid
              ? describeQuietHours(
                  isTimeOfDay(quietStart) && isTimeOfDay(quietEnd)
                    ? { start: quietStart, end: quietEnd }
                    : null,
                )
              : "Sessiz saat SS:DD biçiminde olmalı."}
          </p>

          <Checkbox
            label="Onay zorunlu (requiresApproval)"
            hint="Reklam içeriği insan onayı olmadan yayına girmemeli."
            checked={data?.requiresApproval ?? item.requiresApproval}
            onChange={(next) => {
              if (data === null) return;
              void action
                .run(async () => {
                  const saved = await patchContent(item.id, { requiresApproval: next });
                  setDraft(normalizeContentDetail(saved));
                })
                .then((ok) => {
                  if (ok) onChanged();
                });
            }}
          />

          {action.error !== null ? <ErrorBox error={action.error} /> : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={action.busy} onClick={() => void saveSchedule()}>
              Zamanlamayı kaydet
            </Button>
            <Button
              disabled={approved}
              busy={action.busy}
              onClick={() => {
                void action
                  .run(async () => {
                    const saved = await approveContent(item.id);
                    setDraft(normalizeContentDetail(saved));
                  })
                  .then((ok) => {
                    if (ok) onChanged();
                  });
              }}
            >
              Onayla
            </Button>
            <Button
              variant="primary"
              busy={action.busy}
              onClick={() => setConfirmPublish(true)}
              title={needsApproval ? "Onaylanmamış içerik — önce onay istenecek" : undefined}
            >
              Şimdi Yayınla
            </Button>
            <Button variant="danger" busy={action.busy} onClick={() => setConfirmCancel(true)}>
              İptal et
            </Button>
          </div>

          {item.scheduledAt === null ? (
            <p className="text-[11px] text-warn">Zamanlama yok; yayınlanmaz.</p>
          ) : (
            <p className="font-mono text-[11px] text-muted">
              kayıtlı UTC: {formatZonedDateTime(item.scheduledAt, tz)}
            </p>
          )}
        </div>
      </Panel>

      {data === null ? null : (
        <Panel title="İşler" subtitle={`${data.jobs.length} iş`}>
          {data.jobs.length === 0 ? (
            <EmptyState title="Bu içerik için iş yok." hint="Yayın zamanı geldiğinde iş oluşur." />
          ) : (
            <ul>
              {data.jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  timezone={tz}
                  nowMs={nowMs}
                  retrying={action.busy}
                  onRetry={(target) => {
                    void action
                      .run(async () => {
                        await retryJob(target.id);
                        detail.reload();
                      })
                      .then((ok) => {
                        if (ok) onChanged();
                      });
                  }}
                />
              ))}
            </ul>
          )}
        </Panel>
      )}

      <ConfirmDialog
        open={confirmPublish}
        title="Şimdi yayınla?"
        confirmLabel="Yayınla"
        variant="primary"
        busy={action.busy}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={() => {
          setConfirmPublish(false);
          void action
            .run(async () => {
              const saved = await publishNow(item.id);
              setDraft(normalizeContentDetail(saved));
            })
            .then((ok) => {
              if (ok) onChanged();
            });
        }}
      >
        <p>
          Bu içerik <strong>şimdi</strong> yayınlanacak. Zamanlama atlanır ve platformlara hemen gönderilir.
        </p>
        {needsApproval ? (
          <p className="mt-1.5 text-warn">
            ⚠ İçerik henüz onaylanmadı ({data?.requiresApproval ? "requiresApproval = true" : DASH}). Onay
            alınmadan yayınlamak, reklam içeriğini insan kontrolü olmadan yayımlamak demektir.
          </p>
        ) : (
          <p className="mt-1.5 text-muted">Onay durumu: alındı.</p>
        )}
        <p className="mt-1.5 text-[11px] text-muted">
          Zamanlanan zaman: {localValue === "" ? "yok" : `${localValue} (${tz})`}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmCancel}
        title="Yayını iptal et?"
        confirmLabel="İptal et"
        variant="danger"
        busy={action.busy}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void action
            .run(async () => {
              const saved = await cancelContent(item.id);
              setDraft(normalizeContentDetail(saved));
            })
            .then((ok) => {
              if (ok) onChanged();
            });
        }}
      >
        <p>Bekleyen yayınlar iptal edilir. Daha önce yayınlanmış içerik geri alınmaz.</p>
      </ConfirmDialog>
    </div>
  );
}

function CalendarView({
  items,
  jobs,
  weekStart,
  setWeekStart,
  timezone,
  nowMs,
  onPick,
  selectedId,
}: {
  items: ContentItem[];
  jobs: PublishJob[];
  weekStart: Date;
  setWeekStart: (next: Date) => void;
  timezone: string;
  nowMs: number;
  onPick: (id: string) => void;
  selectedId: string | null;
}) {
  const buckets = useCalendarBuckets(jobs, weekStart, timezone, nowMs);
  const columns = buildWeekColumns(weekStart, new Date(nowMs));
  const byId = new Map(items.map((i) => [i.id, i]));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setWeekStart(addDays(weekStart, -7))}>← önceki hafta</Button>
        <Button onClick={() => setWeekStart(startOfWeek(new Date(nowMs)))}>bu hafta</Button>
        <Button onClick={() => setWeekStart(addDays(weekStart, 7))}>sonraki hafta →</Button>
        <span className="text-[12px] font-medium text-fg">{weekTitle(weekStart)}</span>
        <span className="text-[11px] text-muted">Saat dilimi: {timezone} (veri UTC gelir, yerele çevrilir)</span>
      </div>

      <div className="grid grid-cols-7 gap-1 overflow-x-auto">
        {columns.map((column) => {
          const bucket = buckets.find((b) => b.key === column.key);
          return (
            <div
              key={column.key}
              className={`min-h-[180px] rounded border px-1 py-1 ${
                column.isToday ? "border-accent bg-accent/5" : "border-line bg-panel"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-medium text-muted">{column.weekday}</span>
                <span className={`text-[12px] ${column.isToday ? "text-accent" : "text-fg"}`}>{column.label}</span>
              </div>
              <ul className="mt-1 space-y-1">
                {bucket === undefined || bucket.jobs.length === 0 ? null : (
                  bucket.jobs.map((job) => {
                    const item = byId.get(job.contentId);
                    const t = Date.parse(job.scheduledAt);
                    const pos = Number.isFinite(t) ? dayPositionPercent(new Date(t), timezone) : 0;
                    const meta = CONTENT_STATE_META[item?.state ?? "scheduled"];
                    return (
                      <li key={job.id}>
                        <button
                          type="button"
                          onClick={() => onPick(job.contentId)}
                          className={`w-full rounded border px-1 py-0.5 text-left ${
                            selectedId === job.contentId ? "border-accent" : "border-line"
                          }`}
                          title={`${formatZonedDateTime(job.scheduledAt, timezone)} · ${item?.campaign ?? DASH}`}
                        >
                          <div className="flex flex-wrap items-center gap-1">
                            <PlatformBadge platform={job.platform} />
                            <span className="font-mono text-[10px] text-fg">
                              {formatZonedDateTime(job.scheduledAt, timezone).slice(-5)}
                            </span>
                          </div>
                          <p className="truncate text-[10px]" style={{ marginTop: `${Math.round(pos / 12)}%` }}>
                            <span className={meta.tone === "danger" ? "text-danger" : "text-muted"}>
                              {meta.label}
                            </span>
                          </p>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({
  items,
  filters,
  setFilters,
  selectedId,
  onPick,
}: {
  items: ContentItem[];
  filters: ContentFilterState;
  setFilters: (next: ContentFilterState) => void;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Durum" htmlFor="c-state">
          <Select
            id="c-state"
            value=""
            onChange={(e) => {
              const value = e.currentTarget.value as ContentState | "";
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
            {ALL_STATES.map((s) => (
              <option key={s} value={s}>
                {CONTENT_STATE_META[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kampanya" htmlFor="c-campaign">
          <Select
            id="c-campaign"
            value={filters.campaign ?? ""}
            onChange={(e) => setFilters({ ...filters, campaign: e.currentTarget.value || null })}
          >
            <option value="">Tümü</option>
            {collectCampaigns(items).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Arama" htmlFor="c-query" hint="kampanya, hashtag, açıklama">
          <TextInput id="c-query" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.currentTarget.value })} />
        </Field>
        <div className="flex flex-col gap-1.5 pb-0.5">
          <Checkbox
            label="Yalnız onay bekleyenler"
            checked={filters.onlyNeedsApproval}
            onChange={(v) => setFilters({ ...filters, onlyNeedsApproval: v })}
          />
          <Checkbox
            label="Seçili durumlar"
            checked={filters.states.length > 0}
            onChange={(v) => setFilters({ ...filters, states: v ? ["scheduled", "ready"] : [] })}
          />
        </div>
        <Button onClick={() => setFilters(emptyContentFilters())}>Temizle</Button>
      </div>

      {filters.states.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">durum:</span>
          {filters.states.map((s) => (
            <Badge key={s} tone={CONTENT_STATE_META[s].tone}>
              {CONTENT_STATE_META[s].label}
            </Badge>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState title="İçerik yok." hint="AI projesi içerik gönderdiğinde burada listelenir." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">İçerik listesi</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-1 font-medium">Durum</th>
                <th scope="col" className="py-1 font-medium">Kampanya</th>
                <th scope="col" className="py-1 font-medium">Zaman</th>
                <th scope="col" className="py-1 font-medium">Onay</th>
                <th scope="col" className="py-1 font-medium">Etiketler</th>
                <th scope="col" className="py-1 font-medium">Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={`cursor-pointer border-b border-line-soft last:border-0 ${
                    selectedId === item.id ? "bg-accent/10" : "hover:bg-elev"
                  }`}
                  onClick={() => onPick(item.id)}
                >
                  <td className="py-1 pr-2"><ContentStateBadge state={item.state} /></td>
                  <td className="py-1 pr-2 text-fg">{item.campaign ?? DASH}</td>
                  <td className="py-1 pr-2 font-mono text-muted">
                    {item.scheduledAt === null ? DASH : formatZonedDateTime(item.scheduledAt, item.timezone)}
                  </td>
                  <td className="py-1 pr-2">
                    {contentIsApproved(item) ? (
                      <Badge tone="ok">onaylı</Badge>
                    ) : item.requiresApproval ? (
                      <Badge tone="warn">onay gerekli</Badge>
                    ) : (
                      <Badge tone="muted">gerekmiyor</Badge>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-muted">{item.tags.length === 0 ? DASH : item.tags.join(", ")}</td>
                  <td className="py-1 text-muted">{truncate(item.copy.instagram?.caption ?? item.copy.tiktok?.caption ?? "", 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Content() {
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [timezone, setTimezone] = useState<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Istanbul";
    } catch {
      return "Europe/Istanbul";
    }
  });
  const [filters, setFilters] = useState<ContentFilterState>(emptyContentFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nowMs = Date.now();

  const content = useAsync(() => listContent({ limit: 200, offset: 0 }), []);
  const jobs = useAsync(() => listJobs({ limit: 300, offset: 0 }), []);

  const items = content.data?.items ?? [];
  const visible = useMemo(() => filterContent(items, filters), [items, filters]);
  const allJobs = jobs.data?.items ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,620px)]">
      <div className="space-y-3">
        <Panel
          title="İçerik & Takvim"
          subtitle={`${visible.length} / ${items.length} içerik · ${allJobs.length} iş`}
          actions={
            <>
              <Button
                variant={view === "calendar" ? "primary" : "ghost"}
                onClick={() => setView("calendar")}
                aria-pressed={view === "calendar"}
              >
                Takvim
              </Button>
              <Button
                variant={view === "list" ? "primary" : "ghost"}
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
              >
                Liste
              </Button>
              <Button onClick={() => { content.reload(); jobs.reload(); }}>Yenile</Button>
            </>
          }
        >
          <div className="mb-2">
            <Field label="Takvim saat dilimi" htmlFor="tz-cal">
              <TimeZonePicker id="tz-cal" value={timezone} onChange={setTimezone} />
            </Field>
          </div>

          {content.loading || jobs.loading ? <Loading /> : null}
          {content.error !== null ? <ErrorBox error={content.error} onRetry={content.reload} /> : null}
          {jobs.error !== null ? <ErrorBox error={jobs.error} onRetry={jobs.reload} /> : null}

          {view === "calendar" ? (
            <CalendarView
              items={visible}
              jobs={allJobs}
              weekStart={weekStart}
              setWeekStart={setWeekStart}
              timezone={timezone}
              nowMs={nowMs}
              onPick={setSelectedId}
              selectedId={selectedId}
            />
          ) : (
            <ListView
              items={visible}
              filters={filters}
              setFilters={setFilters}
              selectedId={selectedId}
              onPick={setSelectedId}
            />
          )}
        </Panel>
      </div>

      <aside className="min-w-0">
        {selected === null ? (
          <Panel title="Seçili içerik yok">
            <EmptyState
              title="Bir içerik seçin."
              hint="Seçince platform metinleri, zamanlama, sessiz saat, onay ve işler burada açılır."
            />
          </Panel>
        ) : (
          <ContentDetailPanel
            item={selected}
            timezone={selected.timezone}
            nowMs={nowMs}
            onChanged={() => {
              content.reload();
              jobs.reload();
            }}
          />
        )}
      </aside>
    </div>
  );
}