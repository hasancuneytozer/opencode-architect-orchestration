/**
 * Kütüphane: yükleme alanı + varlık ızgarası + sağ panel (9:16 doğrulama raporu,
 * güvenli alan).
 * Uçlar: GET /v1/assets, /v1/assets/:id, /v1/assets/:id/report, /:id/video, /:id/cover
 */
import { useEffect, useMemo, useState } from "react";

import { assetCoverUrl, assetVideoUrl } from "../api/client.js";
import { getAssetReport, listAssets, listProjects, normalizeAsset } from "../api/endpoints.js";
import { useAsync } from "../api/hooks.js";
import type { Asset, Platform } from "../api/types.js";
import { AssetReport, MediaFacts, VerticalBadge, aspectPercent } from "../components/AssetReport.js";
import { Badge } from "../components/Badge.js";
import { PlatformBadge } from "../components/PlatformBits.js";
import {
  SafeAreaOverlay,
  SafeAreaSummary,
  TextBoxControls,
  VerticalFrame,
  useTextBox,
} from "../components/SafeAreaOverlay.js";
import { UploadPanel } from "../components/UploadPanel.js";
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
import {
  DASH,
  formatBytes,
  formatDurationSec,
  formatRelativeTime,
  formatResolution,
} from "../lib/format.js";
import {
  assetFindingCount,
  assetHasError,
  emptyAssetFilters,
  filterAssets,
} from "../lib/filters.js";
import type { AssetFilterState } from "../lib/filters.js";

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];

/** Kapak varsa kapak, yoksa dikey oranlı boş kutu (taşma yok). */
function AssetThumb({ asset, url }: { asset: Asset; url: string }) {
  return (
    <VerticalFrame label={`${asset.originalName} dikey önizleme`}>
      {asset.coverKey === null ? (
        <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] text-faint">
          Kapak yok · {formatResolution(asset.info.width, asset.info.height)}
        </div>
      ) : (
        <img
          src={url}
          alt={`${asset.originalName} kapak görseli`}
          loading="lazy"
          className="h-full w-full object-contain"
        />
      )}
    </VerticalFrame>
  );
}

function AssetCard({
  asset,
  selected,
  onSelect,
}: {
  asset: Asset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full rounded border px-2 py-2 text-left ${
          selected ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-accent/60"
        }`}
      >
        <AssetThumb asset={asset} url={assetCoverUrl(asset.id)} />
        <p className="mt-1.5 truncate text-[12px] font-medium text-fg" title={asset.originalName}>
          {asset.originalName}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <VerticalBadge info={asset.info} />
          <Badge tone="muted">{formatDurationSec(asset.info.durationSec)}</Badge>
          <Badge tone="muted">{formatBytes(asset.bytes)}</Badge>
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-faint">
          {formatResolution(asset.info.width, asset.info.height)} · {aspectPercent(asset.info)}
          {assetFindingCount(asset) > 0 ? ` · ${assetFindingCount(asset)} bulgu` : ""}
        </p>
      </button>
    </li>
  );
}

function AssetDetailPanel({ asset }: { asset: Asset }) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [textBox, setTextBox] = useTextBox();
  const report = useAsync(() => getAssetReport(asset.id), [asset.id]);

  return (
    <div className="space-y-3">
      <Panel title={asset.originalName} subtitle={`${asset.id} · ${formatRelativeTime(asset.createdAt)}`}>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="w-full shrink-0 sm:w-[220px]">
            <VerticalFrame label="Güvenli alan önizlemesi">
              <video
                src={assetVideoUrl(asset.id)}
                controls
                preload="metadata"
                playsInline
                className="h-full w-full object-contain"
                aria-label={`${asset.originalName} videosu`}
              />
              <SafeAreaOverlay platform={platform} textBox={textBox} />
            </VerticalFrame>
            <p className="mt-1 text-center text-[11px] text-muted">
              Kırmızı çizgi: güvenli alan ihlali · yeşil: temiz
            </p>
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <MediaFacts info={asset.info} />
            <div className="flex flex-wrap gap-1.5">
              {asset.derivedForPlatform === null ? null : (
                <Badge tone="accent">{asset.derivedForPlatform} için dönüştürülmüş kopya</Badge>
              )}
              {assetHasError(asset) ? <Badge tone="danger">hata var</Badge> : <Badge tone="ok">hata yok</Badge>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Metin yerleştirme yardımı" subtitle="Kutunun x/y/genişlik/yükseklik değerlerini girin">
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
          </div>
          <TextBoxControls value={textBox} onChange={setTextBox} platform={platform} />
          <SafeAreaSummary platform={platform} />
        </div>
      </Panel>

      <Panel title="9:16 doğrulama raporu" subtitle="GET /api/v1/assets/:id/report">
        {report.loading ? <Loading /> : null}
        {report.error !== null ? <ErrorBox error={report.error} onRetry={report.reload} /> : null}
        {report.data === null ? null : <AssetReport report={report.data} platform={platform} onPlatform={setPlatform} />}
      </Panel>
    </div>
  );
}

export function Library() {
  const assets = useAsync(() => listAssets({ limit: 200, offset: 0 }), []);
  const projects = useAsync(() => listProjects(), []);
  const [filters, setFilters] = useState<AssetFilterState>(emptyAssetFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Yükleme sonrası seçilecek varlık (listede görününce seçilir). */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const items = useMemo(
    () => (assets.data?.items ?? []).map(normalizeAsset),
    [assets.data],
  );
  const visible = useMemo(() => filterAssets(items, filters), [items, filters]);

  useEffect(() => {
    if (selectedId !== null && !items.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  // Yüklenen varlık seçilir. Seçim `pendingSelect` ÜZERİNDEN yapılır çünkü
  // yükleme biter bitmez `assets.reload()` çağrılır ve yeni varlık listede
  // BİRKAÇ YÜZDE SANİYE SONRA görünür; doğrudan `setSelectedId` çağırsaydı
  // yukarıdaki efekt, henüz gelmemiş kimliği "bulunamadı" sanıp seçimi
  // SİLARDI — yüklediğiniz video panelde görünmezdi.
  useEffect(() => {
    if (pendingSelect === null) return;
    if (items.some((a) => a.id === pendingSelect)) {
      setSelectedId(pendingSelect);
      setPendingSelect(null);
    }
  }, [items, pendingSelect]);

  const selected = items.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
      <div className="space-y-3">
        <UploadPanel
          projects={projects.data?.items ?? []}
          onSettled={assets.reload}
          onUploaded={setPendingSelect}
        />

        <Panel title="Varlıklar" subtitle={`${visible.length} / ${items.length} kayıt`}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Proje" htmlFor="f-project">
              <Select
                id="f-project"
                value={filters.projectId ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, projectId: e.currentTarget.value === "" ? null : e.currentTarget.value }))
                }
              >
                <option value="">Tümü</option>
                {(projects.data?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Arama" htmlFor="f-query" hint="dosya adı, kodek, biçim">
              <TextInput
                id="f-query"
                value={filters.query}
                onChange={(e) => setFilters((f) => ({ ...f, query: e.currentTarget.value }))}
              />
            </Field>
            <Field label="Tarih başlangıç" htmlFor="f-from" hint="saat 00:00">
              <TextInput
                id="f-from"
                type="date"
                value={filters.range.from ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, range: { ...f.range, from: e.currentTarget.value || null } }))
                }
              />
            </Field>
            <Field label="Tarih bitiş (hariç)" htmlFor="f-to" hint="saat 00:00 — bitiş günü dahil değil">
              <TextInput
                id="f-to"
                type="date"
                value={filters.range.to ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, range: { ...f.range, to: e.currentTarget.value || null } }))
                }
              />
            </Field>
            <div className="flex flex-col gap-1.5 pb-0.5">
              <Checkbox
                label="Yalnız hatalılar"
                checked={filters.onlyProblems}
                onChange={(v) => setFilters((f) => ({ ...f, onlyProblems: v }))}
              />
              <Checkbox
                label="Bulgu olanlar"
                checked={filters.onlyWithFindings}
                onChange={(v) => setFilters((f) => ({ ...f, onlyWithFindings: v }))}
              />
            </div>
            <Button onClick={() => setFilters(emptyAssetFilters())}>Filtreleri temizle</Button>
          </div>
        </Panel>

        {assets.loading ? <Loading label="Varlıklar yükleniyor…" /> : null}
        {assets.error !== null ? <ErrorBox error={assets.error} onRetry={assets.reload} /> : null}

        {assets.settled && assets.error === null && items.length === 0 ? (
          <EmptyState
            title="Kütüphane boş."
            hint="AI projesi içerik gönderdiğinde videolar burada listelenir."
          />
        ) : null}

        {items.length > 0 && visible.length === 0 ? (
          <EmptyState
            title="Filtreye uyan kayıt yok."
            hint="Filtreleri temizleyin veya tarih aralığını genişletin."
          />
        ) : null}

        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              selected={asset.id === selectedId}
              onSelect={() => setSelectedId(asset.id)}
            />
          ))}
        </ul>
      </div>

      <aside className="min-w-0">
        {selected === null ? (
          <Panel title="Seçili varlık yok">
            <EmptyState
              title="Bir video seçin."
              hint="Seçince doğrulama raporu, güvenli alan önizlemesi ve video oynatıcı burada açılır."
            />
          </Panel>
        ) : (
          <AssetDetailPanel asset={selected} />
        )}
      </aside>
    </div>
  );
}

