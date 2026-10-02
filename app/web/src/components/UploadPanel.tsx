/**
 * Video yükleme alanı — sürükle-bırak + dosya seçici + ilerlemeli yükleme
 * kuyruğu.
 *
 * ── NEDEN XHR ───────────────────────────────────────────────────────────────
 * `fetch` gövde yükleme ilerlemesi vermez (bkz. `api/client.ts` → `xhrUpload`).
 * Yüzde, `XMLHttpRequest.upload.onprogress` üzerinden gelir; aynı nesne iptali
 * de sağlar (`abort()`).
 *
 * ── KARARLAR BURADA DEĞİL ──────────────────────────────────────────────────
 * Kabul/ret, yüzde, durum metni ve hata çevirisi `lib/upload.ts`'te saf
 * fonksiyonlardır; bu dosya yalnız onları çağırır ve React'e bağlar.
 */
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";

import { ingestVideo, uploadAsset } from "../api/endpoints.js";
import type { Project } from "../api/types.js";
import { Badge } from "./Badge.js";
import {
  Button,
  Checkbox,
  Field,
  Panel,
  Select,
  TextInput,
  Textarea,
} from "./Ui.js";
import { formatBytes } from "../lib/format.js";
import { PLATFORM_META } from "../lib/labels.js";
import {
  FEED_PLATFORMS,
  HASHTAG_LIMIT,
  INSTAGRAM_MAX_BYTES,
  UPLOAD_ACCEPT,
  activeUploads,
  advanceUpload,
  beginUpload,
  completeUpload,
  countUploadsByState,
  emptyFeedForm,
  failUpload,
  filesFromInput,
  hasActiveUploads,
  instagramWarning,
  parseHashtags,
  prepareFiles,
  removeUpload,
  toIngestFields,
  uploadErrorMessage,
  uploadStatusLabel,
  type FeedForm,
  type FileLike,
  type QueuedUpload,
} from "../lib/upload.js";

/** `POST /api/v1/assets` (yalnız varlık) ya da `POST /api/v1/ingest` (içerik). */
export type UploadMode = "asset" | "ingest";

export interface UploadPanelProps {
  projects: Project[];
  /** Yükleme sonrası: kütüphane listesini yenile. */
  onSettled: () => void;
  /** Yükleme sonrası: yeni varlık kimliği (sağdaki rapor panelini aç). */
  onUploaded: (assetId: string) => void;
}

interface Notice {
  id: string;
  tone: "warn" | "danger" | "info";
  text: string;
}

let noticeSeq = 0;

function nextNoticeId(): string {
  noticeSeq += 1;
  return `n${noticeSeq}`;
}

/** `ApiError` → `UploadFailure`. Alanlar `unknown` olabilir; tip zorlaması yok. */
function describeUploadError(err: unknown): string {
  const record = (err ?? {}) as { status?: unknown; code?: unknown };
  return uploadErrorMessage({
    status: typeof record.status === "number" ? record.status : null,
    code: typeof record.code === "string" ? record.code : null,
    message: err instanceof Error ? err.message : String(err),
  });
}

export function UploadPanel({ projects, onSettled, onUploaded }: UploadPanelProps) {
  const [mode, setMode] = useState<UploadMode>("asset");
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [form, setForm] = useState<FeedForm>(emptyFeedForm);
  const [projectId, setProjectId] = useState("");

  // `File` nesneleri durumda TUTULMAZ (yeniden render'da karşılaştırılamaz ve
  // bellekte kopyalanır). Kimlik → dosya eşlemesi ref'te durur.
  const filesRef = useRef<Map<string, File>>(new Map());
  const abortRef = useRef<Map<string, () => void>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const busy = hasActiveUploads(queue);
  const uploadCount = countUploadsByState(queue, "uploading");

  const addNotices = useCallback((items: Omit<Notice, "id">[]) => {
    if (items.length === 0) return;
    setNotices((prev) => [
      ...prev,
      ...items.map((item) => ({ ...item, id: nextNoticeId() })),
    ]);
  }, []);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  /**
   * SIRAYA AL ve SIRAYLA gönder.
   *
   * Kabul/ret kararı `prepareFiles`'te verilir; burada yalnız `File` nesneleri
   * kimliğe bağlanır (durumda `File` tutulmaz) ve döngü yürütülür.
   *
   * SIRALI gönderimin nedeni eşzamanlılık değil, okunabilirlik: üç dosya seçildiğinde
   * üç ayrı çubuk birbirine girip hangisinin bittiği anlaşılmaz; sırada ilk
   * dosya öne çıkar ve kullanıcı ne olduğunu izler.
   */
  const start = useCallback(
    async (incoming: FileLike[], raw: File[]) => {
      const prepared = prepareFiles(incoming, queue);
      const report = [
        ...prepared.duplicates.map((d) => ({ tone: "warn" as const, text: d.reason })),
        ...prepared.rejected.map((r) => ({ tone: "danger" as const, text: `${r.name}: ${r.reason}` })),
        ...prepared.warnings.map((text) => ({ tone: "warn" as const, text })),
      ];
      if (prepared.accepted.length === 0) {
        addNotices(report);
        return;
      }
      for (let i = 0; i < prepared.accepted.length; i += 1) {
        const item = prepared.accepted[i];
        const file = raw[i];
        if (item !== undefined && file !== undefined) filesRef.current.set(item.id, file);
      }
      setQueue((prev) => [...prev, ...prepared.accepted]);
      addNotices(report);

      let lastAssetId: string | null = null;
      for (const item of prepared.accepted) {
        const id = item.id;
        const file = filesRef.current.get(id);
        // `cancel` dosyayı sildiyse bu satır atlanır (kuyruktan düşen iş).
        if (file === undefined) continue;
        setQueue((prev) => beginUpload(prev, id));
        const onProgress = (percent: number): void => {
          setQueue((prev) => advanceUpload(prev, id, percent, 100));
        };
        try {
          const handle =
            mode === "ingest"
              ? ingestVideo(file, toIngestFields(form, form.platforms), { onProgress })
              : uploadAsset(file, { projectId, onProgress });
          abortRef.current.set(id, handle.abort);
          const data: unknown = await handle.promise;
          abortRef.current.delete(id);
          setQueue((prev) => completeUpload(prev, id));
          // Yanıtın hangi şekilde geldiği TİTİMLE değil, alanla ayrılır: iki
          // ucun da varlık kimliği döndürdüğü tek yer burasıdır ve sözleşme
          // değişirse (yeni alan adı) derleme kırılır, ekran boş kalmaz.
          const record = (data ?? {}) as { id?: unknown; assetId?: unknown };
          const assetId = typeof record.id === "string" ? record.id : record.assetId;
          if (typeof assetId === "string") lastAssetId = assetId;
        } catch (err) {
          abortRef.current.delete(id);
          setQueue((prev) => failUpload(prev, id, describeUploadError(err)));
        }
      }
      onSettled();
      if (lastAssetId !== null) onUploaded(lastAssetId);
    },
    [addNotices, form, mode, onSettled, onUploaded, projectId, queue],
  );

  const onInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const raw = Array.from(event.currentTarget.files ?? []);
      start(filesFromInput(event.currentTarget), raw);
      // Aynı dosya ikinci kez seçilebilsin: `value` sıfırlanmazsa tarayıcı
      // `change` olayını tetiklemez ve kullanıcı "dosyamı seçtim ama bir şey
      // olmadı" der.
      event.currentTarget.value = "";
    },
    [start],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const raw = Array.from(event.dataTransfer.files ?? []);
      start(filesFromInput({ files: event.dataTransfer.files }), raw);
    },
    [start],
  );

  const cancel = useCallback((id: string) => {
    const abort = abortRef.current.get(id);
    if (abort !== undefined) {
      abort();
      return;
    }
    // Henüz başlamadı: satırı kuyruktan düşür, döngü dosyayı bulamayacak.
    filesRef.current.delete(id);
    setQueue((prev) => removeUpload(prev, id));
  }, []);

  const onZoneKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPicker();
    },
    [openPicker],
  );

  const instagramRisk = queue.filter((item) => item.warnInstagram);
  const tagCount = parseHashtags(form.hashtags).length;

  return (
    <Panel
      title="Video yükle"
      subtitle={`POST /api/v1/${mode === "ingest" ? "ingest" : "assets"} · çoklu seçim`}
      actions={
        <>
          <Badge tone={mode === "ingest" ? "accent" : "muted"}>
            {mode === "ingest" ? "varlık + içerik" : "yalnız varlık"}
          </Badge>
          {uploadCount > 0 ? <Badge tone="progress" live>{uploadCount} yükleniyor</Badge> : null}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={mode === "asset"}
            onClick={() => setMode("asset")}
            className={`rounded border px-2 py-1 text-[12px] ${
              mode === "asset" ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
            }`}
          >
            Yalnız varlık
          </button>
          <button
            type="button"
            aria-pressed={mode === "ingest"}
            onClick={() => setMode("ingest")}
            className={`rounded border px-2 py-1 text-[12px] ${
              mode === "ingest" ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
            }`}
          >
            Varlık + içerik
          </button>
        </div>

        <div
          role="button"
          tabIndex={0}
          aria-label="Video yüklemek için tıklayın, Enter veya Boşluk tuşuyla dosya seçin, ya da dosyayı buraya sürükleyin"
          onClick={openPicker}
          onKeyDown={onZoneKey}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            // `dragleave` ÇOCUK öğelerden de gelir; sayaç olmadan alan
            // "bırakılırken" titrer ve yanlışlıkla pasif görünür.
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
          className={`cursor-pointer rounded border-2 border-dashed px-3 py-6 text-center transition-colors ${
            dragging
              ? "border-accent bg-accent/15"
              : "border-line bg-elev hover:border-accent/60"
          }`}
        >
          <p className={`text-[13px] font-medium ${dragging ? "text-accent" : "text-fg"}`}>
            {dragging ? "Dosyayı bırakın" : "Videoyu buraya sürükleyin"}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            ya da tıklayıp seçin · mp4, mov, webm, mkv · en çok 2 GB
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={onInputChange}
          />
        </div>

        {mode === "ingest" ? (
          <div className="space-y-2 rounded border border-line bg-elev px-2.5 py-2">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Proje adı" htmlFor="up-project" hint="varsayılan: genel">
                <TextInput
                  id="up-project"
                  value={form.project}
                  placeholder="genel"
                  onChange={(e) => setForm((f) => ({ ...f, project: e.currentTarget.value }))}
                />
              </Field>
              <div className="flex flex-col gap-1 pb-0.5">
                <span className="text-[11px] font-medium text-muted">Platformlar</span>
                <div className="flex flex-wrap gap-2">
                  {FEED_PLATFORMS.map((p) => (
                    <Checkbox
                      key={p}
                      label={PLATFORM_META[p as keyof typeof PLATFORM_META].label}
                      checked={form.platforms.includes(p)}
                      onChange={(next) =>
                        setForm((f) => ({
                          ...f,
                          platforms: next ? [...f.platforms, p] : f.platforms.filter((x) => x !== p),
                        }))
                      }
                    />
                  ))}
                </div>
              </div>
            </div>
            <Field label="Açıklama" htmlFor="up-desc" hint="her platform için ortak metin">
              <Textarea
                id="up-desc"
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.currentTarget.value }))}
              />
            </Field>
            <Field
              label="Hashtag"
              htmlFor="up-tags"
              hint={`# ile veya virgülle ayırın · ${tagCount}/${HASHTAG_LIMIT}`}
            >
              <TextInput
                id="up-tags"
                value={form.hashtags}
                placeholder="#vlog #kahve"
                onChange={(e) => setForm((f) => ({ ...f, hashtags: e.currentTarget.value }))}
              />
            </Field>
            <p className="text-[11px] text-muted">
              Birden çok dosya seçerseniz HER DOSYA için ayrı varlık, ayrı içerik ve ayrı kuyruk
              işi oluşur. İçerikler taslak kalır; yayın insan onayına bağlıdır.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Proje" htmlFor="up-asset-project" hint="yoksa varsayılan proje">
              <Select
                id="up-asset-project"
                value={projectId}
                onChange={(e) => setProjectId(e.currentTarget.value)}
              >
                <option value="">Varsayılan</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="pb-1 text-[11px] text-muted">
              Bu akış yalnız medyayı depolar; içerik ve yayın işi oluşmaz.
            </p>
          </div>
        )}

        {instagramRisk.length > 0 ? (
          <div
            role="status"
            className="rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-[11px] text-warn"
          >
            <p className="font-semibold">
              {instagramRisk.length} dosya Instagram sınırını ({formatBytes(INSTAGRAM_MAX_BYTES)}) aşıyor.
            </p>
            <p className="mt-0.5 text-fg">{instagramWarning(instagramRisk[0]?.size ?? 0)}</p>
            <ul className="mt-1 space-y-0.5">
              {instagramRisk.map((item) => (
                <li key={item.id} className="truncate text-fg">
                  {item.name} · {formatBytes(item.size)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-fg">Yükleme ENGELLENMEZ; yalnız uyarıdır.</p>
          </div>
        ) : null}

        {notices.length > 0 ? (
          <ul className="space-y-1" aria-live="polite">
            {notices.map((notice) => (
              <li
                key={notice.id}
                className={`rounded border px-2 py-1 text-[11px] ${
                  notice.tone === "danger"
                    ? "border-danger/50 bg-danger/10 text-danger"
                    : "border-warn/50 bg-warn/10 text-warn"
                }`}
              >
                {notice.text}
                <Button
                  variant="subtle"
                  className="ml-1"
                  ariaLabel="Uyarıyı kapat"
                  onClick={() => setNotices((prev) => prev.filter((n) => n.id !== notice.id))}
                >
                  kapat
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {queue.length === 0 ? (
          <p className="text-[11px] text-muted">Kuyruk boş. Henüz dosya seçilmedi.</p>
        ) : (
          <ul className="space-y-1.5">
            {queue.map((item) => (
              <li
                key={item.id}
                className="rounded border border-line bg-elev px-2 py-1.5"
                aria-live={item.state === "uploading" ? "polite" : undefined}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={item.name}>
                    {item.name}
                  </span>
                  <Badge tone="muted">{formatBytes(item.size)}</Badge>
                  <Badge
                    tone={
                      item.state === "done"
                        ? "ok"
                        : item.state === "error"
                          ? "danger"
                          : item.state === "uploading"
                            ? "progress"
                            : "idle"
                    }
                    live={item.state === "uploading"}
                  >
                    {uploadStatusLabel(item)}
                  </Badge>
                  <Button
                    variant="subtle"
                    ariaLabel={`${item.name} yüklemesini iptal et`}
                    disabled={item.state === "done"}
                    onClick={() => cancel(item.id)}
                  >
                    iptal
                  </Button>
                </div>
                {item.state === "uploading" ? (
                  <div
                    role="progressbar"
                    aria-valuenow={item.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${item.name} yükleme ilerlemesi`}
                    className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-line"
                  >
                    <div
                      className="h-full bg-accent transition-[width] duration-150"
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                ) : null}
                {item.error === null ? null : (
                  <p className="mt-1 text-[11px] text-danger">{item.error}</p>
                )}
                {item.warnInstagram && item.state !== "uploading" ? (
                  <p className="mt-0.5 text-[11px] text-warn">
                    Instagram 300 MB sınırını aşıyor (uyarı).
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {activeUploads(queue).length > 0 ? (
          <p className="text-[11px] text-muted">
            {activeUploads(queue).length} dosya sırada/yolda. Sıralı yüklenir.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
