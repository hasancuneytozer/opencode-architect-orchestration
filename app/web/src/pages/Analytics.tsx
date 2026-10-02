/**
 * Analitik paneli.
 *
 * Uçlar: GET /v1/analytics/overview, /v1/analytics/series, /v1/analytics/coverage,
 * GET /v1/analytics/content/:id, POST /v1/analytics/collect
 *
 * ── GÖSTERİLME KURALLARI (ürün kararları) ──────────────────────────────────
 *
 * 1) **Grafik yok, tablo var.** Bu bir yönetim paneldir; "gösterge" değil,
 *    karşılaştırılabilir sayılar lazım. Günlük tablo: tarih × platform.
 *
 * 2) **Kaldırılmış metrikler gösterilmez.** Instagram'ın kaldırdığı iki sayaç
 *    panelde hiçbir yerde görünmez; gösterilseydi kullanıcı "ölçtük" izlenimi
 *    alırdı. (Gerekçe `src/analytics/metrics.ts`'te.)
 *
 * 3) **`0` ile `—` ayrıdır.** `0` = ölçüldü ve sıfır. `—` = bu metrik yok ya da
 *    ölçülemedi. `0`'ı "veri yok" gibi göstermek yanlış güven yaratır.
 *
 * 4) **Veri gecikmesi hata değildir.** Instagram 48 saat gecikmelidir; son iki
 *    günün eksik olması "eksik veri" uyarısı değil, açıklama gerektiren bir
 *    olgudur. Aynı şekilde 27 Ağustos 2026 tarih kırılması karşılaştırma
 *    yapılıyorsa not düşülür.
 */
import { useMemo, useState } from "react";

import {
  analyticsContent,
  analyticsCoverage,
  analyticsOverview,
  analyticsSeries,
  collectAnalytics,
} from "../api/endpoints.js";
import { useAction, useAsync } from "../api/hooks.js";
import type {
  AdditiveMetricKey,
  AnalyticsCollectResult,
  AnalyticsContentDetail,
  AnalyticsPlatformCard,
  AnalyticsSeriesPoint,
  Platform,
} from "../api/types.js";
import { Badge } from "../components/Badge.js";
import { PlatformBadge } from "../components/PlatformBits.js";
import {
  Button,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Panel,
  Select,
  TextInput,
} from "../components/Ui.js";
import {
  DEFAULT_RANGE_DAYS,
  activeReasons,
  changeTone,
  completenessNote,
  formatChangePct,
  formatCount,
  formatRate,
  measuredValue,
  newestFirst,
  rangeOf,
  seriesState,
  sortPlatforms,
  sumMeasured,
  unavailableBadge,
  viewsChangeWarning,
} from "../lib/analytics.js";

/** Panelde gösterilen sütunlar. Hepsi KANONİK sayaçlardır. */
const COLUMNS = [
  { key: "views", label: "Oynatma" },
  { key: "interactions", label: "Etkileşim" },
  { key: "saves", label: "Kaydetme" },
  { key: "shares", label: "Paylaşım" },
] as const;

const RATE_ROWS = [
  { key: "saveRate", label: "Kaydetme oranı" },
  { key: "shareRate", label: "Paylaşım oranı" },
  { key: "interactionRate", label: "Etkileşim oranı" },
] as const;

/** `new Date()` burada TEK yerde; geri kalan her yer saf ve test edilebilir. */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Kart hücresi: `contributors[key] === 0` ise `null`.
 *
 * Kuralın TEK yazılışı `lib/analytics.ts`'in `measuredValue`'sıdır; burada
 * ikinci bir kopyası tutulursa iki yer bir gün ayrışır ve `0`/`—` ayrımı
 * sütunda kaybolur.
 */
function metricOf(card: AnalyticsPlatformCard, key: AdditiveMetricKey): number | null {
  return measuredValue(card, key);
}

function PlatformCard({
  card,
  onSelect,
}: {
  card: AnalyticsPlatformCard;
  onSelect: (platform: Platform) => void;
}) {
  const reasons = activeReasons(card.unavailableReasons);
  return (
    <section className="rounded border border-line bg-panel p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <PlatformBadge platform={card.platform} full />
        {card.available.configured ? (
          <Badge tone="muted" title="Ölçüm adaptörü bağlı.">
            ölçüm kaynağı bağlı
          </Badge>
        ) : (
          <Badge tone="warn" title={card.available.reason ?? undefined}>
            ölçüm kaynağı bağlı değil
          </Badge>
        )}
        {card.unavailableCount > 0 ? (
          <button
            type="button"
            onClick={() => onSelect(card.platform)}
            aria-expanded={false}
            title={reasons.map((r) => `${r.meta.label}: ${r.count}`).join(" · ")}
            className="cursor-pointer"
          >
            <Badge tone="orange">{unavailableBadge(card.unavailableCount)}</Badge>
          </button>
        ) : null}
        {card.noDataCount > 0 ? (
          <Badge tone="info" title="Satır var ama değer henüz gelmedi (veri gecikmesi).">
            {card.noDataCount} içerik veri bekliyor
          </Badge>
        ) : null}
      </div>

      {reasons.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {reasons.map((reason) => (
            <li key={reason.reason} className="flex items-start gap-1.5 text-[11px]">
              <Badge tone={reason.meta.tone}>{reason.meta.label}</Badge>
              <span className="text-muted">
                {reason.count} içerik · {reason.meta.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {COLUMNS.map((column) => (
          <div key={column.key} className="flex items-baseline justify-between gap-2">
            <dt className="text-faint">{column.label}</dt>
            <dd className="font-mono text-fg">{formatCount(metricOf(card, column.key))}</dd>
          </div>
        ))}
        {RATE_ROWS.map((rate) => {
          const value = card.rates[rate.key];
          return (
            <div key={rate.key} className="flex items-baseline justify-between gap-2">
              <dt className="text-faint">{rate.label}</dt>
              <dd className="font-mono text-fg">{formatRate(value)}</dd>
            </div>
          );
        })}
      </dl>

      <p className="mt-1.5 text-[10px] text-faint">
        {card.measuredCount} ölçülen içerik · son ölçüm{" "}
        {card.latestDate ?? "—"}
        {card.missingDataDays > 0 ? ` · ${card.missingDataDays} gün ölçümsüz` : ""}
      </p>
      {completenessNote(card.completeness) === null ? null : (
        <p className="mt-0.5 text-[10px] text-info">{completenessNote(card.completeness)}</p>
      )}
    </section>
  );
}

function SeriesTable({ points }: { points: readonly AnalyticsSeriesPoint[] }) {
  const rows = useMemo(() => newestFirst(points), [points]);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Bu dönemde ölçüm satırı yok."
        hint="Yayınlanmış içerik yok ya da ölçüm henüz toplanmadı."
      />
    );
  }
  return (
    <table className="w-full border-collapse text-[12px]">
      <caption className="sr-only">Günlük ölçüm tablosu</caption>
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th scope="col" className="py-1 font-medium">Tarih</th>
          <th scope="col" className="py-1 font-medium">Platform</th>
          {COLUMNS.map((column) => (
            <th key={column.key} scope="col" className="py-1 pr-2 text-right font-medium">
              {column.label}
            </th>
          ))}
          <th scope="col" className="py-1 pl-2 font-medium">Durum</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((point) => {
          const state = seriesState(point);
          return (
            <tr key={`${point.platform}-${point.date}`} className="border-b border-line-soft last:border-0">
              <td className="py-1 pr-2 font-mono text-fg">{point.date}</td>
              <td className="py-1 pr-2">
                <PlatformBadge platform={point.platform} />
              </td>
              {COLUMNS.map((column) => (
                <td
                  key={column.key}
                  className="py-1 pr-2 text-right font-mono text-fg"
                  title={point[column.key] === null ? "bu metrik için ölçülen değer yok" : undefined}
                >
                  {formatCount(point[column.key])}
                </td>
              ))}
              <td className="py-1 pl-2">
                <Badge
                  tone={state.tone}
                  title={
                    point.unavailable === null
                      ? undefined
                      : activeReasons(point.unavailable.byReason)
                          .map((r) => `${r.meta.label}: ${r.count}`)
                          .join(" · ")
                  }
                >
                  {state.label}
                </Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ContentDetail({ detail }: { detail: AnalyticsContentDetail }) {
  const change = detail.change;
  const warning = viewsChangeWarning({
    from: detail.rollup.from,
    to: detail.rollup.to,
    previousFrom: detail.previous?.window.from ?? null,
    previousTo: detail.previous?.window.to ?? null,
    changeDate: detail.viewsCountingChangeDate,
  });
  const deltas = change?.deltas ?? [];
  const series = useMemo(() => newestFirst(detail.series), [detail.series]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {detail.asset === null ? (
          <Badge tone="muted">varlık bulunamadı</Badge>
        ) : (
          <Badge tone="muted" title={detail.asset.originalName}>
            {detail.asset.originalName}
          </Badge>
        )}
        <Badge tone="muted">{detail.jobs.length} yayın işi</Badge>
        <Badge tone="muted">
          {detail.rollup.measuredCount} ölçülen · {detail.rollup.unavailableCount} ölçülemeyen
        </Badge>
      </div>

      {warning === null ? null : (
        <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
          {warning}
        </p>
      )}

      {detail.previous === null ? (
        <p className="text-[11px] text-muted">
          Karşılaştırma için önceki dönem verisi yok. Pencerede hiç ölçüm satırı bulunmadığı için
          yüzde değişim hesaplanmadı (0 değil, "veri yok").
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="muted">
            dönem {detail.rollup.from} → {detail.rollup.to}
          </Badge>
          <Badge tone="muted">
            önceki {detail.previous.window.from} → {detail.previous.window.to}
          </Badge>
        </div>
      )}

      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">Önceki döneme göre yüzde değişim</caption>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="py-1 font-medium">Metrik</th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">Bu dönem</th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">Önceki</th>
            <th scope="col" className="py-1 text-right font-medium">Değişim</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((delta) => (
            <tr key={delta.key} className="border-b border-line-soft last:border-0">
              <td className="py-1 pr-2 text-fg">{delta.key}</td>
              <td className="py-1 pr-2 text-right font-mono text-fg">
                {delta.key.endsWith("Rate") ? formatRate(delta.current) : formatCount(delta.current)}
              </td>
              <td className="py-1 pr-2 text-right font-mono text-muted">
                {delta.key.endsWith("Rate") ? formatRate(delta.previous) : formatCount(delta.previous)}
              </td>
              <td className="py-1 text-right">
                <span className={`font-mono text-[11px] ${changeTone(delta.changePct) === "ok" ? "text-ok" : changeTone(delta.changePct) === "danger" ? "text-danger" : "text-faint"}`}>
                  {formatChangePct(delta.changePct)}
                </span>
              </td>
            </tr>
          ))}
          {deltas.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-2 text-[11px] text-muted">
                Karşılaştırılacak iki dönem de yok; değişim hesaplanmadı.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {series.length === 0 ? (
        <EmptyState title="Bu içerik için ölçüm satırı yok." />
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">İçerik günlük ölçüm tablosu</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-1 font-medium">Tarih</th>
              <th scope="col" className="py-1 font-medium">Platform</th>
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className="py-1 pr-2 text-right font-medium">
                  {column.label}
                </th>
              ))}
              <th scope="col" className="py-1 pl-2 font-medium">Not</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr
                key={`${point.platform}-${point.date}`}
                className="border-b border-line-soft last:border-0"
              >
                <td className="py-1 pr-2 font-mono text-fg">{point.date}</td>
                <td className="py-1 pr-2">
                  <PlatformBadge platform={point.platform} />
                </td>
                {COLUMNS.map((column) => (
                  <td key={column.key} className="py-1 pr-2 text-right font-mono text-fg">
                    {formatCount(point.metrics[column.key] ?? null)}
                  </td>
                ))}
                <td className="py-1 pl-2 text-[11px] text-muted">
                  {point.unavailable === null ? "" : point.unavailable.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[10px] text-faint">
        Sütun toplamı: oynatma {formatCount(sumMeasured(series.map((p) => p.metrics["views"] ?? null)))}
      </p>
    </div>
  );
}

/**
 * `onNavigate` yalnız "içerik" ekranına geçişi bilir. `PageRoute`'un tamamı
 * DEĞİL: `App.tsx`'in `PageRoute`'u `RouteId | "analytics"` birleşimi ve
 * geniş `string` imzası ona `string` atamaya çalışıp kırılıyordu.
 */
export function Analytics({ onNavigate }: { onNavigate?: (route: "content") => void }) {
  const [days, setDays] = useState(DEFAULT_RANGE_DAYS);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [contentId, setContentId] = useState("");
  const [collectNote, setCollectNote] = useState<string | null>(null);
  const collect = useAction();

  const range = useMemo(() => {
    const auto = rangeOf(days, todayString());
    return {
      from: from !== "" ? from : auto.from,
      to: to !== "" ? to : auto.to,
    };
  }, [days, from, to]);

  const overview = useAsync(
    () => analyticsOverview({ from: range.from, to: range.to, platform: platform === "" ? null : platform }),
    [range.from, range.to, platform],
  );
  const series = useAsync(
    () => analyticsSeries({ from: range.from, to: range.to, platform: platform === "" ? null : platform }),
    [range.from, range.to, platform],
  );
  const coverage = useAsync(
    () => analyticsCoverage({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  const detail = useAsync(
    () => (contentId === "" ? Promise.resolve(null) : analyticsContent(contentId, range)),
    [contentId, range.from, range.to],
    contentId !== "",
  );

  const cards = useMemo(
    () => sortPlatforms(overview.data?.platforms ?? []),
    [overview.data],
  );
  const summaryWarning = viewsChangeWarning({
    from: range.from,
    to: range.to,
    previousFrom: overview.data?.previous.from ?? null,
    previousTo: overview.data?.previous.to ?? null,
  });

  const coverageRows = coverage.data?.unavailable ?? [];
  const measuredTotal = sumMeasured(cards.map((card) => metricOf(card, "views"))) ?? 0;

  return (
    <div className="space-y-3">
      <Panel
        title="Analitik"
        subtitle={`GET /api/v1/analytics/overview · ${range.from} → ${range.to}`}
        actions={
          <>
            <Button onClick={() => { overview.reload(); series.reload(); coverage.reload(); detail.reload(); }}>
              Yenile
            </Button>
            <Button
              variant="primary"
              busy={collect.busy}
              onClick={() => {
                void collect
                  .run(async () => {
                    const result: AnalyticsCollectResult = await collectAnalytics(1);
                    setCollectNote(
                      `${result.collected} kayıt yazıldı, ${result.skipped} atlandı ` +
                        `(ölçüm günü ${result.metricDate}).`,
                    );
                    overview.reload();
                    series.reload();
                    coverage.reload();
                  })
                  .then(() => undefined);
              }}
            >
              Ölçümü tetikle
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Gün" htmlFor="a-days">
            <Select
              id="a-days"
              value={String(days)}
              onChange={(e) => setDays(Number(e.currentTarget.value))}
            >
              <option value="7">son 7 gün</option>
              <option value="14">son 14 gün</option>
              <option value="30">son 30 gün</option>
              <option value="90">son 90 gün</option>
            </Select>
          </Field>
          <Field label="Başlangıç" htmlFor="a-from" hint="YYYY-AA-GG">
            <TextInput id="a-from" value={from} placeholder={range.from} onChange={(e) => setFrom(e.currentTarget.value)} />
          </Field>
          <Field label="Bitiş" htmlFor="a-to" hint="YYYY-AA-GG">
            <TextInput id="a-to" value={to} placeholder={range.to} onChange={(e) => setTo(e.currentTarget.value)} />
          </Field>
          <Field label="Platform" htmlFor="a-platform">
            <Select
              id="a-platform"
              value={platform}
              onChange={(e) => setPlatform(e.currentTarget.value as Platform | "")}
            >
              <option value="">Tümü</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube">YouTube</option>
            </Select>
          </Field>
          <Button onClick={() => { setFrom(""); setTo(""); setDays(DEFAULT_RANGE_DAYS); }}>
            Temizle
          </Button>
        </div>

        {overview.data !== null && overview.data.mode === "mock" ? (
          <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
            Hiçbir platform için ölçüm adaptörü bağlı değil. Sayılar gelene kadar bu ekran boş
            kalır; bu bir hata değil, yapılandırma eksikliğidir.
          </p>
        ) : null}

        {summaryWarning === null ? null : (
          <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
            {summaryWarning}
          </p>
        )}

        {collectNote === null ? null : <p className="mt-2 text-[11px] text-ok">{collectNote}</p>}
        {collect.error !== null ? <ErrorBox error={collect.error} context="Ölçüm tetiklenemedi" /> : null}

        {overview.loading ? <Loading label="Özet yükleniyor…" /> : null}
        {overview.error !== null ? <ErrorBox error={overview.error} onRetry={overview.reload} /> : null}

        {overview.settled && overview.error === null && cards.length === 0 ? (
          <EmptyState
            title="Bu dönem için ölçüm yok."
            hint="Yayınlanmış içerik bulunmuyor ya da ölçüm henüz toplanmadı."
          />
        ) : null}

        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {cards.map((card) => (
            <PlatformCard
              key={card.platform}
              card={card}
              onSelect={(next) => setPlatform((current) => (current === next ? "" : next))}
            />
          ))}
        </div>

        <p className="mt-2 text-[11px] text-muted">
          Dönem toplamı oynatma: {formatCount(measuredTotal)} · kapsanan iş:{" "}
          {coverage.data?.totalJobs ?? 0} · ölçülebilen: {coverage.data?.measurable ?? 0}
        </p>
      </Panel>

      <Panel
        title="Günlük ölçüm tablosu"
        subtitle="Grafik değil tablo: tarih × platform. — = bu metrik için ölçülen değer yok."
      >
        {series.loading ? <Loading label="Seri yükleniyor…" /> : null}
        {series.error !== null ? <ErrorBox error={series.error} onRetry={series.reload} /> : null}
        {series.data === null ? null : <SeriesTable points={series.data.points} />}
      </Panel>

      <Panel
        title="Neden ölçülemiyor"
        subtitle="GET /api/v1/analytics/coverage — eksik izin ve herkese açık olmayan yayınlar"
      >
        {coverage.loading ? <Loading /> : null}
        {coverage.error !== null ? <ErrorBox error={coverage.error} onRetry={coverage.reload} /> : null}
        {coverageRows.length === 0 && coverage.settled && coverage.error === null ? (
          <EmptyState
            title="Bu dönemde ölçülemeyen içerik yok."
            hint="Her yayınlanan işin en az bir ölçüm satırı var."
          />
        ) : null}
        {coverageRows.length > 0 ? (
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">Sebebe göre ölçülemeyen içerik sayısı</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-1 font-medium">Platform</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">İçerik</th>
                <th scope="col" className="py-1 font-medium">Sebep</th>
              </tr>
            </thead>
            <tbody>
              {coverageRows.map((row) =>
                activeReasons(row.byReason).map((reason) => (
                  <tr
                    key={`${row.platform}-${reason.reason}`}
                    className="border-b border-line-soft last:border-0 align-top"
                  >
                    <td className="py-1 pr-2">
                      <PlatformBadge platform={row.platform} full />
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-fg">{reason.count}</td>
                    <td className="py-1">
                      <Badge tone={reason.meta.tone}>{reason.meta.label}</Badge>
                      <span className="ml-1 text-muted">{reason.meta.detail}</span>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel
        title="İçerik detayı"
        subtitle="GET /api/v1/analytics/content/:id — günlük seri + önceki dönem"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="İçerik kimliği" htmlFor="a-content" hint="Yayın günlüğünden kopyalayın">
            <TextInput
              id="a-content"
              value={contentId}
              placeholder="content-…"
              onChange={(e) => setContentId(e.currentTarget.value.trim())}
            />
          </Field>
          {onNavigate === undefined ? null : (
            <Button onClick={() => onNavigate("content")}>İçerik ekranına git</Button>
          )}
        </div>
        {detail.loading ? <Loading /> : null}
        {detail.error !== null ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : null}
        {contentId !== "" && detail.settled && detail.error === null && detail.data === null ? (
          <EmptyState title="İçerik bulunamadı." />
        ) : null}
        {detail.data === null ? null : <ContentDetail detail={detail.data} />}
      </Panel>
    </div>
  );
}
