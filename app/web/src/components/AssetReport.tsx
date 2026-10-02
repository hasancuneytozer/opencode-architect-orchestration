/**
 * 9:16 doğrulama raporu: platform sekmeleri + şiddet grupları.
 *
 * `provisional: true` olan her sınırda "henüz doğrulanmadı" rozeti görünür —
 * kullanıcı geçici bir kurala güvenmesin.
 */
import { useState } from "react";

import type { AssetReportPayload, Platform } from "../api/types.js";
import { formatBitrate, formatDurationSec, formatFps, formatResolution, trNumber } from "../lib/format.js";
import type { MediaInfo, ValidationFinding } from "../api/types.js";
import {
  countProvisional,
  findingCodeLabel,
  findingDetail,
  groupBySeverity,
  isPublishReady,
} from "../lib/validation.js";
import type { FindingGroups } from "../lib/validation.js";
import { SEVERITY_META } from "../lib/labels.js";
import type { Severity } from "../api/types.js";
import { Badge } from "./Badge.js";
import { PlatformBadge } from "./PlatformBits.js";
import { EmptyState, KeyValue, Tabs } from "./Ui.js";

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];

export function MediaFacts({ info }: { info: MediaInfo | null }) {
  if (info === null) return <EmptyState title="Medya bilgisi alınamadı." />;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px]">
      <KeyValue label="Çözünürlük">{formatResolution(info.width, info.height)}</KeyValue>
      <KeyValue label="Süre">{formatDurationSec(info.durationSec)}</KeyValue>
      <KeyValue label="Kare hızı">{formatFps(info.fps)}</KeyValue>
      <KeyValue label="Bit hızı">{formatBitrate(info.bitrate)}</KeyValue>
      <KeyValue label="Kapsayıcı">{info.container ?? "—"}</KeyValue>
      <KeyValue label="Video kodeği">{info.videoCodec ?? "—"}</KeyValue>
      <KeyValue label="Ses kodeği">{info.audioCodec ?? "—"}</KeyValue>
      <KeyValue label="Piksel biçimi">{info.pixelFormat ?? "—"}</KeyValue>
      <KeyValue label="Ses var">{info.hasAudio ? "evet" : "hayır"}</KeyValue>
      <KeyValue label="Boyut">{info.bytes > 0 ? `${info.bytes} bayt` : "—"}</KeyValue>
    </dl>
  );
}

function FindingRow({ finding }: { finding: ValidationFinding }) {
  const meta = SEVERITY_META[finding.severity];
  return (
    <li className="border-b border-line-soft py-1.5 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-[12px] font-medium text-fg">{findingCodeLabel(finding.code)}</span>
        <span className="font-mono text-[10px] text-faint">{finding.code}</span>
        {finding.provisional === true ? (
          <Badge tone="warn" title="Bu sınır resmî dokümanla doğrulanmadı. Yanlış olabilir.">
            henüz doğrulanmadı
          </Badge>
        ) : null}
      </div>
      <p className="mt-0.5 text-[12px] text-fg">{findingDetail(finding)}</p>
    </li>
  );
}

function SeverityGroup({
  severity,
  findings,
}: {
  severity: Severity;
  findings: ValidationFinding[];
}) {
  const meta = SEVERITY_META[severity];
  if (findings.length === 0) {
    return (
      <div className="rounded border border-line-soft px-2 py-2">
        <Badge tone="muted">{meta.label}: yok</Badge>
      </div>
    );
  }
  return (
    <div className="rounded border border-line-soft">
      <h4 className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1 text-[11px] font-semibold text-muted">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {findings.length} bulgu
      </h4>
      <ul className="px-2">
        {findings.map((finding, i) => (
          <FindingRow key={`${finding.code}-${i}`} finding={finding} />
        ))}
      </ul>
    </div>
  );
}

export function PlatformReportTab({
  platform,
  findings,
}: {
  platform: Platform;
  findings: ValidationFinding[];
}) {
  const groups: FindingGroups = groupBySeverity(findings);
  const provisional = countProvisional(findings);
  const ready = isPublishReady(findings);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <PlatformBadge platform={platform} full />
        <Badge tone={ready ? "ok" : "danger"}>{ready ? "Yayına hazır" : "Yayına hazır değil"}</Badge>
        {provisional > 0 ? (
          <Badge tone="warn" title="Doğrulanmamış sınırlar var; sayılar değişebilir.">
            {provisional} doğrulanmamış sınır
          </Badge>
        ) : null}
      </div>
      {findings.length === 0 ? (
        <EmptyState title="Bu platform için bulgu yok." hint="Doğrulama çalışmış ve kural ihlali bildirmemiş." />
      ) : (
        <>
          <SeverityGroup severity="error" findings={groups.error} />
          <SeverityGroup severity="warning" findings={groups.warning} />
          <SeverityGroup severity="info" findings={groups.info} />
        </>
      )}
    </div>
  );
}

export function AssetReport({
  report,
  platform,
  onPlatform,
}: {
  report: AssetReportPayload;
  platform: Platform;
  onPlatform: (next: Platform) => void;
}) {
  const tabs = PLATFORMS.map((p) => {
    const list = report.perPlatform[p];
    const errors = list.filter((f) => f.severity === "error").length;
    return {
      id: p,
      label: p === "instagram" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube",
      badge:
        errors > 0 ? (
          <Badge tone="danger">{errors} hata</Badge>
        ) : list.length > 0 ? (
          <Badge tone="warn">{list.length} bulgu</Badge>
        ) : (
          <Badge tone="ok">temiz</Badge>
        ),
    };
  });

  return (
    <div className="space-y-2">
      <Tabs tabs={tabs} active={platform} onSelect={(id) => onPlatform(id as Platform)} label="Platform doğrulama raporu" />
      <PlatformReportTab platform={platform} findings={report.perPlatform[platform]} />
      {report.findings.length > 0 ? (
        <details className="rounded border border-line-soft px-2 py-1.5">
          <summary className="cursor-pointer text-[12px] font-medium text-muted">
            Dosya geneli bulgular ({report.findings.length})
          </summary>
          <div className="mt-1 space-y-2">
            <SeverityGroup severity="error" findings={groupBySeverity(report.findings).error} />
            <SeverityGroup severity="warning" findings={groupBySeverity(report.findings).warning} />
            <SeverityGroup severity="info" findings={groupBySeverity(report.findings).info} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Küçük özet: kapak üzerindeki hata sayısı. */
export function ReportSummaryBadge({ report }: { report: AssetReportPayload | null }) {
  if (report === null) return null;
  const all = PLATFORMS.flatMap((p) => report.perPlatform[p]);
  const errors = all.filter((f) => f.severity === "error").length;
  const provisional = countProvisional(all);
  if (errors > 0) return <Badge tone="danger">{errors} hata</Badge>;
  if (all.length > 0) return <Badge tone="warn">{all.length} bulgu</Badge>;
  if (provisional > 0) return <Badge tone="warn">{provisional} geçici sınır</Badge>;
  return <Badge tone="ok">temiz</Badge>;
}

/** Kapak üzerinde "9:16 dikey" göstergesi. */
export function VerticalBadge({ info }: { info: MediaInfo | null }) {
  if (info === null) return null;
  const vertical = info.height !== null && info.width !== null && info.height > info.width;
  const target =
    info.width !== null && info.height !== null &&
    Math.abs(info.width / info.height - 9 / 16) <= 0.06;
  if (target) return <Badge tone="ok">9:16</Badge>;
  if (vertical) return <Badge tone="warn">dikey · 9:16 değil</Badge>;
  return <Badge tone="danger">yatay · 9:16 değil</Badge>;
}

/** En-boy oranını yüzde olarak gösteren yardımcı (test edilen biçimlendirme kullanır). */
export function aspectPercent(info: MediaInfo | null): string {
  if (info === null || info.width === null || info.height === null || info.height === 0) return "—";
  return `%${trNumber((info.width / info.height) * 100, 1)}`;
}