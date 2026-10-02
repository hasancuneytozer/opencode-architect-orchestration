/**
 * INGEST — uygulamanın ASIL GİRİŞ KAPISI.
 *
 * Diğer AI projeleri (video üreten araçlar) ürettikleri dosyayı buraya bırakır;
 * uygulama onu depolar, probe eder, doğrular, kuyruğa alır. Bu dosyanın
 * sorumluluğu "dosyayı almak" değil, "YAYINA HAZIR mı" sorusunu dürüstçe
 * yanıtlamaktır: doğrulanamayan dosya kaydedilir ama kuyruğa GİRMEZ.
 *
 * ── SIRALAMA NEDEN ÖNEMLİ ────────────────────────────────────────────────────
 *  1. doğrulama   (sözleşme alanları + `source.kind`e göre kaynak kuralı)
 *  2. proje       (upsert: FK çözülmesin diye varlık kaydından ÖNCE)
 *  3. kaynak      (buffer → doğrudan; path → realpath ile çözülür; url → stream)
 *  4. depolama    (sha256 içerik adresi → aynı dosya iki kez = TEK varlık)
 *  5. probe       (ffprobe)
 *  6. doğrulama   (her hedef platform için `validateMedia`)
 *  7. kapak       (transcoder → store)
 *  8. zaman/metin (UTC'ye çözülür, `resolveCopy` ile birleştirilir)
 *  9. kuyruk      (yalnız `autoSchedule` VE onay uygunsa)
 * 10. denetim     (her adım `ingest.*`)
 *
 * ── "ÇAKIŞMA AYNI VARLIK" KURALI ────────────────────────────────────────────
 * `storageKey = uploads/<sha256'in ilk 2>·<sha256>/dosya<uzantı>` içerikten
 * türetilir. Aynı dosya ikinci kez gelirse `assets.getByStorageKey` mevcut
 * varlığı bulur ve YENİ varlık açılmaz; yalnızca yeni bir içerik kaydı
 * üretilir. Aksi halde aynı video için iki varlık, iki kapak ve iki ayrı
 * doğrulama geçmişi oluşur.
 *
 * ── BELLEK KURALI ───────────────────────────────────────────────────────────
 * 4 GB sınırındaki bir video `arrayBuffer()` ile belleğe ALINMAZ: indirme
 * `store.put`'a doğrudan akıtılır, özet `createReadStream` ile hesaplanır.
 * Belleğe yalnız multipart dışındaki `buffer` kaynağı girer.
 *
 * ── ONAY KAPISI ─────────────────────────────────────────────────────────────
 * `requiresApproval = !input.autoSchedule`. Sözleşmede `autoSchedule` varsayılanı
 * `false` olduğu için varsayılan davranış "onay bekle"dir: reklam içeriğinde
 * insan onayı olmadan yayına girmez. `autoSchedule: true` yazan istemci bu
 * riski BİLİYOR.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";

import { z } from "zod";

import {
  AiDisclosureSchema,
  IngestBaseShape,
  PlatformCopySchema,
  SourcePathSchema,
  SourceUrlSchema,
  resolveScheduledAt,
  type AiDisclosure,
  type Asset,
  type ContentState,
  type IngestRequest,
  type MediaInfo,
  type PerPlatformCopy,
  type Platform,
  type PlatformSpec,
  type ValidationFinding,
} from "../contract/index.js";
import { resolveCopy } from "../domain/copy.js";
import {
  DEFAULT_AI_DISCLOSURE,
  type AccountRepo,
  type AssetRepo,
  type AuditRepo,
  type ContentRepo,
  type ProjectRepo,
  type PublishJobRepo,
} from "../db/index.js";
import { errorsOf, getSpec, validateMedia } from "../media/index.js";
import type { FfmpegProbe, MediaStore, Transcoder } from "../ports/index.js";
import type { Clock } from "../services/index.js";
import { attachCover } from "./cover.js";
import { productFindings } from "./policy.js";

/** İndirilecek en büyük dosya: 4 GB (TikTok tek parça sınırı). */
export const MAX_INGEST_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * SÖZLEŞMENİN KAYNAK KURALSIZ HALİ — alan doğrulaması burada biter, kaynak
 * kuralı `IngestService.validate` içinde `source.kind`e göre uygulanır.
 *
 * `IngestBaseShape` sözleşmeden TEK kaynaktan gelir (elle kopyalanmış alan
 * listesi yoktur); burada yalnız kaynak refine'leri çıkarılır. `.strict()`
 * sözleşmede de olduğu gibi korunur: gövdede tanımsız alan sessizce yutulmaz.
 */
const IngestBodySchema = z.object(IngestBaseShape).strict();

/** Kapak karesi çıkarılacak yüzde. Sözleşme varsayılanı. */
export const COVER_AT_PERCENT = 35;

/** Kaynak: dosya nereden geliyor. */
export type IngestSource =
  | { kind: "buffer"; body: Buffer; fileName: string }
  | { kind: "path"; path: string }
  | { kind: "url"; url: string };

/** Doğrulama hatası: HTTP 400 ve CLI çıkış kodu 1 üretir. */
export class IngestValidationError extends Error {
  constructor(
    message: string,
    readonly details: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "IngestValidationError";
  }
}

/** Kaynak alınamadı (dosya yok, erişilemedi, indirme başarısız). */
export class IngestSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestSourceError";
  }
}

export interface IngestSkip {
  platform: Platform;
  reason: string;
}

export interface IngestResult {
  assetId: string;
  contentId: string;
  state: ContentState;
  /**
   * İçeriğin insan onayı bekleyip beklemediği (`!autoSchedule`).
   *
   * Neden sonuçta: tüketici (HTTP gövdesi, CLI satırı) "kuyruk boş çünkü onay
   * bekliyor" ile "kuyruk boş çünkü hesap yok" ayrımını YALNIZCA bu alandan
   * yapabilir. `jobIds.length === 0` tek başına belirsizdir; karar bilgisi
   * çağıranın yeniden hesaplamasına bırakılmaz.
   */
  requiresApproval: boolean;
  jobIds: string[];
  findings: ValidationFinding[];
  /** Platform başına neden kuyruğa girilmedi. */
  skipped: IngestSkip[];
}

export interface IngestDeps {
  projects: ProjectRepo;
  assets: AssetRepo;
  contents: ContentRepo;
  accounts: AccountRepo;
  jobs: PublishJobRepo;
  audit: AuditRepo;
  store: MediaStore;
  probe: FfmpegProbe;
  transcoder: Transcoder;
  getSpec: (p: Platform) => PlatformSpec;
  clock: Clock;
  random?: () => number;
  /** URL indirmesi için `fetch`; testler sahte döner. */
  fetch?: typeof globalThis.fetch;
}

export class IngestService {
  private readonly deps: IngestDeps;

  constructor(deps: IngestDeps) {
    if (typeof deps.getSpec !== "function") {
      throw new Error("IngestService için getSpec zorunludur.");
    }
    this.deps = deps;
  }

  async ingest(input: IngestRequest, source: IngestSource): Promise<IngestResult> {
    const req = this.validate(input, source);
    const project = this.deps.projects.ensure(req.project, null);
    this.audit(project.id, "ingest.project", { project: req.project });

    const stored = await this.acquire(source, input.fileName);
    const found = this.deps.assets.getByStorageKey(stored.storageKey);
    const created = found === null;

    // ── PROBE INSERT'TEN ÖNCE, VE SONUCU KALICI ────────────────────────────
    // Ölçüler `assets.info_json` SÜTUNUNDA durur; `AssetRepo`da sonradan
    // `setInfo` YOKTUR (`setFindings` yalnız `findings_json`'ı günceller).
    // Bu yüzden probe burada yapılmalıdır: varlığı boş ölçülerle açıp
    // "sonra ölçerim" demek ölçümü HAFIZADA BIRAKIR ve kalıcılaştırmaz.
    //
    // Bu sıra tersine çevrilmişse: panel genişlik/yüksekliği "bilinmiyor"
    // gösterir, yeniden doğrulama hep hata üretir ve yayın ön kontrolü
    // `media_rejected` ile düşer — yani hiçbir şey yayınlanamaz.
    const info = created
      ? await this.probeAsset(stored.storageKey, stored.bytes, stored.path)
      : (found?.info ?? emptyInfo(stored.storageKey, stored.bytes));

    // Aynı içerik ikinci kez gelirse varlık YENİDEN açılmaz: `assets.storage_key`
    // UNIQUE, bu yüzden ikinci bir INSERT zaten hata verirdi.
    const asset: Asset =
      found ??
      this.deps.assets.create({
        projectId: project.id,
        storageKey: stored.storageKey,
        originalName: stored.fileName.slice(0, 255),
        bytes: stored.bytes,
        mimeType: mimeFor(stored.fileName),
        info,
        findings: [],
      });
    this.audit(asset.id, "ingest.asset_stored", {
      assetId: asset.id,
      storageKey: stored.storageKey,
      bytes: stored.bytes,
      reused: !created,
      sourceKind: source.kind,
    });

    const findings = this.validateForPlatforms(info, req.platforms);
    this.deps.assets.setFindings(asset.id, findings);

    const errors = errorsOf(findings);
    await this.attachCover(asset, stored.path, findings);

    const scheduledAt = req.scheduledAt
      ? resolveScheduledAt(req.scheduledAt, req.timezone)
      : null;
    const copy = this.resolveCopy(req);
    const aiDisclosure: AiDisclosure = req.aiDisclosure
      ? AiDisclosureSchema.parse(req.aiDisclosure)
      : DEFAULT_AI_DISCLOSURE;
    const requiresApproval = !req.autoSchedule;

    const state: ContentState = errors.length > 0 ? "draft" : "ready";
    const content = this.deps.contents.create({
      projectId: project.id,
      assetId: asset.id,
      state,
      campaign: req.campaign ?? null,
      tags: req.tags,
      copy,
      scheduledAt,
      timezone: req.timezone,
      quietHours: req.quietHours ?? null,
      metadata: req.metadata,
      aiDisclosure,
      requiresApproval,
      approvedBy: null,
      approvedAt: null,
      batchId: req.batchId ?? null,
    });
    this.audit(content.id, "ingest.content", {
      contentId: content.id,
      state,
      requiresApproval,
      scheduledAt,
      platforms: req.platforms,
      findings: findings.length,
    });

    const queued =
      errors.length > 0
        ? {
            jobIds: [] as string[],
            skipped: req.platforms.map((platform) => ({
              platform,
              reason:
                `Medya doğrulaması hata verdi: ${errors
                  .map((e) => `${e.code}: ${e.message}`)
                  .join(" | ")}; kuyruğa alınmadı.`,
            })),
          }
        : this.enqueue(content.id, req.platforms, scheduledAt, requiresApproval);

    return {
      assetId: asset.id,
      contentId: content.id,
      state,
      requiresApproval,
      jobIds: queued.jobIds,
      findings,
      skipped: queued.skipped,
    };
  }

  // ── 1. Doğrulama ───────────────────────────────────────────────────────────

  /**
   * Sözleşme alan doğrulaması + kaynak kuralı.
   *
   * ── NEDEN `IngestRequestSchema` DEĞİL ──────────────────────────────────────
   * Sözleşme şeması kaynağı "tam olarak biri zorunlu" diye refine ediyor
   * (`Boolean(sourcePath) !== Boolean(sourceUrl)`). Bu kural GÖVDEYİ konuşur
   * ve multipart/buffer beslemesinde gövdede kaynak alanı YOKTUR; dosya ayrı bir
   * akış olarak gelir. Yani kural, mesajının kendi dediği "veya multipart file
   * alanı" durumunu hesaba katmadan geçerli bir `buffer` beslemesini reddediyor
   * — sözleşme KORUMALI olduğu için kural burada, kod içinde uygulanır.
   *
   * Geriye kalan iki refine bu yolun işini görmez:
   *   * "sourcePath ve sourceUrl aynı anda verilemez" → aşağıdaki çelişki
   *     denetimi (`kind` başına) aynı işi daha açık mesajla yapar.
   *   * "autoSchedule=true iken scheduledAt verilmemişse..." → mantıksal olarak
   *     `a || !a` (her zaman doğru); hiçbir girdiyi eleyemez.
   *
   * ── KAYNAK KURALI `source.kind`e GÖRE ─────────────────────────────────────
   *   * `path`   → yol `source.path`'tir, `SourcePathSchema`'dan geçmeli;
   *     gövdede `sourceUrl` OLMAMALI (çelişki).
   *   * `url`    → adres `source.url`'dur, `SourceUrlSchema`'dan geçmeli;
   *     gövdede `sourcePath` OLMAMALI (çelişki).
   *   * `buffer` → gövdede kaynak alanı gerekmez (dosya bellekte); gövde yine de
   *     bir kaynak iddiası taşıyorsa REDDEDİLİR (aşağıda gerekçesi).
   *
   * ── "buffer + gövde sourcePath" KARARI: HATA ────────────────────────────────
   * Gövde alanı "yok sayılır" ama SESSİZCE değil: `IngestValidationError`.
   * Gerekçe: bu dal HTTP'den gelmiyor — multipart istek `kind: "path"` ile
   * depoya akıtılmış dosyayı verir (`src/http/server.ts`), yani gövde alanını
   * gereksiz yollayan mevcut bir istemci YOKTUR. Buna karşılık `buffer` dalı
   * programatik bir API'dir; gövdede `sourceUrl` gönderen çağıran, "dosya
   * indirilecek" yanılgısıyla kendi bellek baytları sessizce yutulur.
   * Sessiz yutma bu üründe zaten bir hata sınıfıdır (bkz. eski "gövde ile akış
   * uyuşmuyor" denetimi); aynı ilkeyi burada da uygulamak, çağıranı bir sonraki
   * hata yerine doğrudan doğru yere götürür. `path`/`url` dallarında aynı
   * alanın gövdeyle UYUŞMASI da bu yüzden denetlenmez: HTTP JSON yolu kaynağı
   * zaten gövdeden türetir (`server.ts`), yani o denetim üretimde hiç tutmaz.
   */
  private validate(input: IngestRequest, source: IngestSource): IngestRequest {
    const body: Record<string, unknown> = { ...(input as unknown as Record<string, unknown>) };

    // Kaynak alanları önce AKIŞIN kind'ine göre düzenlenir; gövdenin iddiası
    // kaydedilmez (yukarıdaki gerekçe).
    if (source.kind === "path") {
      if (body["sourceUrl"] !== undefined) {
        throw new IngestValidationError(
          "Çelişkili kaynak: path kaynağı seçildiğinde gövdede sourceUrl verilemez.",
          [{ path: "sourceUrl", message: "akış kaynağı 'path'; sourceUrl kullanılamaz." }],
        );
      }
      body["sourcePath"] = source.path;
    } else if (source.kind === "url") {
      if (body["sourcePath"] !== undefined) {
        throw new IngestValidationError(
          "Çelişkili kaynak: url kaynağı seçildiğinde gövdede sourcePath verilemez.",
          [{ path: "sourcePath", message: "akış kaynağı 'url'; sourcePath kullanılamaz." }],
        );
      }
      body["sourceUrl"] = source.url;
    } else {
      const iddia = body["sourcePath"] ?? body["sourceUrl"];
      if (iddia !== undefined) {
        throw new IngestValidationError(
          "Çelişkili kaynak: buffer kaynağında dosya gövdeden gelir; gövdede sourcePath veya sourceUrl verilemez.",
          [
            {
              path: body["sourcePath"] !== undefined ? "sourcePath" : "sourceUrl",
              message: `akış kaynağı 'buffer'; gövdedeki kaynak alanı yok sayılamaz (gelen: ${String(iddia)}).`,
            },
          ],
        );
      }
    }

    // Alan doğrulaması kaynak kuralsız: yalnız sözleşmenin taban şekli.
    const parsed = IngestBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new IngestValidationError(
        "Ingest isteği geçersiz.",
        parsed.error.issues.map((i) => ({
          path: i.path.join(".") || "(kök)",
          message: i.message,
        })),
      );
    }

    // Kaynak alanının KENDİ güvenlik kuralı (gezinme yasağı, SSRF) burada
    // uygulanır: gövde şeması `sourcePath`'i isteğe bağlı görüyor, kuralı akış
    // belirlediği için değeri de akış koyar.
    if (source.kind === "path") {
      const yol = SourcePathSchema.safeParse(source.path);
      if (!yol.success) {
        throw new IngestValidationError("sourcePath geçersiz.", [
          { path: "sourcePath", message: yol.error.issues[0]?.message ?? "geçersiz yol" },
        ]);
      }
    } else if (source.kind === "url") {
      const adres = SourceUrlSchema.safeParse(source.url);
      if (!adres.success) {
        throw new IngestValidationError("sourceUrl geçersiz.", [
          { path: "sourceUrl", message: adres.error.issues[0]?.message ?? "geçersiz adres" },
        ]);
      }
    }
    return parsed.data;
  }

  // ── 3–4. Kaynak ve depolama ────────────────────────────────────────────────

  /**
   * Kaynağı depoya akıtır ve İÇERİK ADRESİNİ döner. `storageKey` içerikten
   * türetildiği için aynı dosya iki kez geldiğinde aynı anahtar çıkar.
   */
  private async acquire(
    source: IngestSource,
    preferredName?: string,
  ): Promise<{ storageKey: string; path: string; fileName: string; bytes: number }> {
    switch (source.kind) {
      case "buffer": {
        if (source.body.length === 0) {
          throw new IngestValidationError("Yüklenen dosya boş.", [
            { path: "file", message: "0 bayt" },
          ]);
        }
        if (source.body.length > MAX_INGEST_BYTES) {
          throw new IngestValidationError(
            `Dosya çok büyük: ${source.body.length} bayt > ${MAX_INGEST_BYTES} bayt.`,
          );
        }
        const fileName = source.fileName;
        const key = storageKeyFor(source.body, fileName);
        await this.deps.store.put(key, source.body);
        return {
          storageKey: key,
          path: this.deps.store.pathFor(key),
          fileName,
          bytes: source.body.length,
        };
      }
      case "path": {
        const resolved = await this.resolveLocalPath(source.path);
        const st = await stat(resolved);
        if (!st.isFile()) {
          throw new IngestSourceError(`Kaynak bir dosya değil (dizin): ${source.path}`);
        }
        if (st.size > MAX_INGEST_BYTES) {
          throw new IngestSourceError(`Dosya çok büyük: ${st.size} bayt > ${MAX_INGEST_BYTES} bayt.`);
        }
        // `preferredName` yalnız GÖRÜNEN addır; `storageKey` içerik özetinden
        // türetilir. HTTP yolu dosyayı geçici bir anahtara akıtıp `path` dalına
        // verdiği için `basename(resolved)` geçici anahtarın parçası olur ve
        // kütüphanede video `mup3j59h-173184` gibi bir depo anahtarı olarak
        // görünür. Çağıranın bildirdiği ad (multipart `part.filename`) esas alınır.
        const fileName = preferredName ?? basename(resolved);
        const key = storageKeyForDigest(await sha256OfFile(resolved), fileName);
        await this.deps.store.put(key, createReadStream(resolved));
        return {
          storageKey: key,
          path: this.deps.store.pathFor(key),
          fileName,
          bytes: st.size,
        };
      }
      case "url":
        return this.download(source.url);
    }
  }

  /**
   * Yerel yol güvenliği — İKİ KONTROL.
   *
   * 1. `SourcePathSchema` (sözleşme) `..`, `~` ve baştaki `.` zaten reddeder.
   * 2. Burada `fs.realpath` ile SYMBOLİK BAĞ (junction/symlink) çözülür ve
   *    çözülen yolun hâlâ `..` içermediği denetlenir.
   *
   * Neden ikinci kontrol gerekli: Windows'ta `junction`, `..` içermeyen bir
   * yolla da depo dışını gösterebilir. Gerçek yol en azından "istenen yol ile
   * okunan yol ayrışmaz" garantisini verir; depo kökü sınırı `FsMediaStore`
   * tarafında ayrıca uygulanır (dosya DEPOYA yazılır, kaynaktan okunmaz).
   */
  private async resolveLocalPath(input: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(resolve(input));
    } catch (err) {
      throw new IngestSourceError(
        `Dosya okunamadı: ${input} (${err instanceof Error ? err.message : "bilinmeyen hata"})`,
      );
    }
    if (real.split(/[\\/]/).includes("..")) {
      throw new IngestValidationError("Gezinme (..) yasak.", [
        { path: "sourcePath", message: `çözülen yol gezinme içeriyor: ${real}` },
      ]);
    }
    return real;
  }

  /**
   * URL'den indirme: AKIŞLA, boyut tavanıyla.
   *
   * Yanıt gövdesi `store.put`'a doğrudan akıtılır (`arrayBuffer` YOK). İçerik
   * özeti geçici anahtardaki dosya `createReadStream` ile hesaplanır, sonra
   * kalıcı anahtara taşınır ve geçici dosya silinir.
   *
   * `SourceUrlSchema` (sözleşme) özel IP aralıklarını, `localhost` ve bulut
   * metadata adresini reddeder; SSRF kapısı oradadır ve burada TEKRAR yazılmaz.
   */
  private async download(url: string): Promise<{
    storageKey: string;
    path: string;
    fileName: string;
    bytes: number;
  }> {
    const doFetch = this.deps.fetch ?? globalThis.fetch;
    if (typeof doFetch !== "function") {
      throw new IngestSourceError("Bu ortamda fetch yok; sourceUrl kullanılamaz.");
    }
    let response: Response;
    try {
      response = await doFetch(url, { redirect: "follow" });
    } catch (err) {
      throw new IngestSourceError(
        `İndirilemedi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) throw new IngestSourceError(`İndirme başarısız: HTTP ${response.status}`);
    if (!response.body) throw new IngestSourceError("İndirilen yanıtın gövdesi yok.");

    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_INGEST_BYTES) {
      throw new IngestSourceError(
        `Dosya çok büyük (bildirilen ${declared} bayt > ${MAX_INGEST_BYTES} bayt).`,
      );
    }

    const fileName = fileNameFromUrl(url);
    const tmpKey = `tmp/${stamp(this.deps)}-${sha256Hex(url).slice(0, 16)}`;
    try {
      const source = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      ).pipe(new ByteLimitStream(MAX_INGEST_BYTES));
      const put = await this.deps.store.put(tmpKey, source);
      const tmpPath = this.deps.store.pathFor(tmpKey);
      const key = storageKeyForDigest(await sha256OfFile(tmpPath), fileName);
      await this.deps.store.put(key, createReadStream(tmpPath));
      await this.deps.store.remove(tmpKey);
      return { storageKey: key, path: this.deps.store.pathFor(key), fileName, bytes: put.bytes };
    } catch (err) {
      await this.deps.store.remove(tmpKey).catch(() => undefined);
      if (err instanceof MediaTooLargeError) {
        throw new IngestSourceError(`Dosya çok büyük: ${MAX_INGEST_BYTES} bayt sınırı aşıldı.`);
      }
      throw new IngestSourceError(
        `İndirilemedi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 5. Probe ───────────────────────────────────────────────────────────────

  /**
   * `MediaInfo`'ı ölçer.
   *
   * Varlık kaydı henüz açılmadığı için hedef kimlik olarak `storageKey`
   * kullanılır (`audit_events.target_id` metin alanı; `src/main.ts` de kaydı
   * olmayan nesneler için anahtarı kullanır).
   *
   * Probe edilemeyen dosya "kaydedildi ama yayına hazır değil" demek:
   * silmek istemcinin dosyasını kaybetmek ve nedenini görememektir. Boş
   * ölçüler yazılır; `validateMedia` zaten `resolution`/`unreadable` hatası
   * üretir, yani kayıt yine de dürüst kalır.
   */
  private async probeAsset(storageKey: string, bytes: number, path: string): Promise<MediaInfo> {
    try {
      return await this.deps.probe.probe(path);
    } catch (err) {
      // Probe edilemeyen dosya "kaydedildi ama yayına hazır değil" demektir:
      // silmek istemcinin dosyasını kaybetmek ve nedenini görememektir.
      this.audit(storageKey, "ingest.probe_failed", {
        storageKey,
        message: err instanceof Error ? err.message : String(err),
      });
      return emptyInfo(storageKey, bytes);
    }
  }

  // ── 6. Platform doğrulaması ───────────────────────────────────────────────

  /**
   * Doğrulama = UYGULAMA POLİTİKASI + PLATFORM KURALLARI.
   *
   * Sıra ve neden:
   *   1. `productFindings` (bizim kural) ÖNCE gelir ki panelde gerekçe
   *      "bu uygulama neden reddetti" sorusunu yanıtlayan satır olsun.
   *   2. Ardından her HEDEF platformun GERÇEK sınırı. Bulgu kodları platform
   *      önekli DEĞİLDİR (`aspect_ratio` üç platformda da aynı koddur),
   *      çünkü panel ve adaptörler bu kodu anahtar olarak kullanır.
   *
   * `validateMedia` SAF ve platform kuralının ayna görüntüsüdür; ürün
   * kararları buraya GİRMEZ (bkz. `src/ingest/policy.ts`).
   */
  private validateForPlatforms(
    info: MediaInfo,
    platforms: readonly Platform[],
  ): ValidationFinding[] {
    const out: ValidationFinding[] = productFindings(info);
    for (const platform of platforms) out.push(...validateMedia(info, this.deps.getSpec(platform)));
    return out;
  }

  // ── 7. Kapak ───────────────────────────────────────────────────────────────

  /**
   * Kapak karesi. Üretilemezse içerik yine de oluşur: kapak zorunlu değildir ve
   * yokluğu `coverKey: null` olarak DÜRÜSTçe görünür.
   *
   * Mantık `src/ingest/cover.ts`'te ORTAKLAŞILMIŞTIR; `uploadAsset` da aynı
   * yardımcıyı çağırır. Kopyalanmış olsaydı iki akış farklı `coverKey` üretirdi.
   */
  private async attachCover(asset: Asset, path: string, findings: ValidationFinding[]): Promise<void> {
    await attachCover({
      assetId: asset.id,
      path,
      findings,
      actionBase: "ingest.cover",
      assets: this.deps.assets,
      store: this.deps.store,
      transcoder: this.deps.transcoder,
      audit: this.audit,
    });
  }

  // ── 8. Metin ───────────────────────────────────────────────────────────────

  /**
   * Taban: sözleşmenin kendi varsayılanları (`PlatformCopySchema.parse({})`).
   * Elle yazılmış kopya kullanılmaz; şema ile ayrışırsa AI bildirimi ya da
   * gizlilik sessizce düşer.
   */
  private resolveCopy(req: IngestRequest): PerPlatformCopy {
    const base = PlatformCopySchema.parse({});
    const defaults = resolveCopy(base, req.defaultCopy);
    const out: PerPlatformCopy = {};
    for (const platform of req.platforms) {
      out[platform] = resolveCopy(defaults, req.copy?.[platform]);
    }
    return out;
  }

  // ── 9. Kuyruk ──────────────────────────────────────────────────────────────

  /**
   * Kuyruğa alma.
   *
   * `requiresApproval` true ise (`autoSchedule === false`) HİÇBİR iş oluşturulmaz:
   * onay kapısı motorun değil içeriğin kararıdır; onaydan sonra
   * `POST /content/:id/approve` kuyruğa alır.
   */
  private enqueue(
    contentId: string,
    platforms: readonly Platform[],
    scheduledAt: string | null,
    requiresApproval: boolean,
  ): { jobIds: string[]; skipped: IngestSkip[] } {
    const jobIds: string[] = [];
    const skipped: IngestSkip[] = [];
    if (requiresApproval) {
      for (const platform of platforms) {
        skipped.push({
          platform,
          reason: "autoSchedule=false: içerik onay bekliyor; onaydan sonra kuyruğa alınacak.",
        });
      }
      return { jobIds, skipped };
    }

    const when = scheduledAt ?? this.deps.clock.now().toISOString();
    for (const platform of platforms) {
      const account = this.deps.accounts.findActiveByPlatform(platform);
      if (!account) {
        skipped.push({
          platform,
          reason: `${platform} için yayına hazır (active) hesap yok; iş oluşturulmadı.`,
        });
        this.audit(contentId, "ingest.no_account", { platform });
        continue;
      }
      // `enqueueUnique` aynı içerik + platform + hesap üçlüsünü ikinci kez
      // kuyruğa ALMAZ; repo UNIQUE indeksi de bunu veritabanında zorlar.
      const job = this.deps.jobs.enqueueUnique({
        contentId,
        platform,
        accountId: account.id,
        scheduledAt: when,
        idempotencyKey: idempotencyKeyFor(contentId, platform, account.id),
      });
      jobIds.push(job.id);
      this.audit(job.id, "ingest.queued", {
        contentId,
        platform,
        accountId: account.id,
        scheduledAt: job.scheduledAt,
      });
    }
    if (jobIds.length > 0) this.deps.contents.setState(contentId, "scheduled");
    return { jobIds, skipped };
  }

  // ── 10. Denetim ────────────────────────────────────────────────────────────

  private audit(targetId: string, action: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit.record({
        actor: "ingest",
        action,
        targetType: "content",
        targetId,
        detail,
      });
    } catch {
      // Denetim yazılamazsa akış DURMAZ: kaydın kaybolması, yayının
      // gerçekleşmemesinden daha kötüdür.
    }
  }
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

/** `ingest:<sha256 kesik>` — kararlı, kısa ve içerikten bağımsız. */
export function idempotencyKeyFor(
  contentId: string,
  platform: Platform,
  accountId: string,
): string {
  return `ingest:${sha256Hex(`${contentId}:${platform}:${accountId}`).slice(0, 48)}`;
}

/** İçerik + ad → depolama anahtarı. AYNI İÇERİK aynı anahtarı üretir. */
export function storageKeyFor(body: Buffer, fileName: string): string {
  return storageKeyForDigest(sha256Hex(body), fileName);
}

export function storageKeyForDigest(digest: string, fileName: string): string {
  return `uploads/${digest.slice(0, 2)}/${digest}/${safeName(fileName)}`;
}

/**
 * Depo anahtarı güvenliği: `assertSafeKey` sürücü harfi, `..` ve ayrılmış
 * cihaz adlarını reddeder. Bu yüzden UZANTI dışındaki dosya adı KULLANILMAZ —
 * istemciden gelen `../../.env` gibi bir ad burada geçemez.
 */
function safeName(fileName: string): string {
  const ext = extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `dosya${ext.startsWith(".") ? ext : ".bin"}`;
}

function fileNameFromUrl(url: string): string {
  try {
    const name = basename(new URL(url).pathname);
    if (name.length > 0) return name;
  } catch {
    /* geçersiz adres zaten şemada elendi */
  }
  return "indirilen-dosya.bin";
}

function mimeFor(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function emptyInfo(path: string, bytes: number): MediaInfo {
  return {
    path,
    bytes,
    container: null,
    videoCodec: null,
    audioCodec: null,
    pixelFormat: null,
    width: null,
    height: null,
    fps: null,
    durationSec: null,
    bitrate: null,
    hasAudio: false,
  };
}

/**
 * İçerik özeti.
 *
 * Metin de kabul edilir: idempotency anahtarı ve URL gibi DEĞİŞKEN girdiler
 * de özetlenir ve `createHash().update()` ikisini de zaten destekler. Yalnız
 * ikisini birleştirip ayrı `sha256OfString` yazmak aynı işlemi iki yerden
 * yazmak demektir.
 */
export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function stamp(deps: IngestDeps): string {
  const n = Math.floor((deps.random ?? Math.random)() * 1e9).toString(36);
  return `${deps.clock.now().getTime().toString(36)}-${n}`;
}

class MediaTooLargeError extends Error {
  constructor() {
    super("medya boyut tavanı aşıldı");
    this.name = "MediaTooLargeError";
  }
}

/** Bayt sayacı: tavan aşılırsa akış HATA fırlatarak kesilir. */
class ByteLimitStream extends Transform {
  private seen = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    this.seen += chunk.length;
    if (this.seen > this.limit) {
      callback(new MediaTooLargeError());
      return;
    }
    callback(null, chunk);
  }
}