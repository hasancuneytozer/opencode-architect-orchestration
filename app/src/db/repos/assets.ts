/** `assets` tablosu. */
import type { Asset, MediaInfo, Platform, ValidationFinding } from "../../contract/index.js";
import {
  type Db,
  type IdFactory,
  assertPlatform,
  normalizeFindings,
  normalizeMediaInfo,
  nowIso,
  uuid,
} from "./../base.js";
import { fromJson, toJson } from "./../json.js";
import { pageOffset, pageSize } from "./../paging.js";

interface Row {
  id: string;
  project_id: string | null;
  storage_key: string;
  original_name: string;
  bytes: number;
  mime_type: string;
  info_json: string;
  findings_json: string;
  cover_key: string | null;
  derived_from_asset_id: string | null;
  derived_for_platform: string | null;
  created_at: string;
}

function toModel(r: Row): Asset {
  return {
    id: r.id,
    projectId: r.project_id,
    storageKey: r.storage_key,
    originalName: r.original_name,
    bytes: r.bytes,
    mimeType: r.mime_type,
    info: fromJson<MediaInfo>(r.info_json, emptyInfo(r.storage_key, r.bytes)),
    findings: fromJson<ValidationFinding[]>(r.findings_json, []),
    coverKey: r.cover_key,
    derivedFromAssetId: r.derived_from_asset_id,
    derivedForPlatform: (r.derived_for_platform as Platform | null) ?? null,
    createdAt: r.created_at,
  };
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

export interface CreateAssetInput {
  id?: string;
  /** Hangi AI projesinin çıktısı. Kaynak varlıkta null olabilir. */
  projectId?: string | null;
  storageKey: string;
  originalName: string;
  bytes: number;
  mimeType: string;
  info: MediaInfo;
  findings?: ValidationFinding[];
  coverKey?: string | null;
  /** Transcoder çıktısı ise kaynak asset; platform başına bir kopya. */
  derivedFromAssetId?: string | null;
  derivedForPlatform?: Platform | null;
}

/** HTTP varlık listeleme filtresi. Tüm alanlar isteğe bağlıdır. */
export interface AssetListFilter {
  projectId?: string;
  /** Depoda aynı anahtarı olan varlığı bulmak için (çakışma tespiti). */
  storageKey?: string;
  limit?: number;
  offset?: number;
}

export class AssetRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  create(input: CreateAssetInput): Asset {
    if (input.derivedForPlatform !== undefined && input.derivedForPlatform !== null) {
      assertPlatform(input.derivedForPlatform);
    }
    const row: Row = {
      id: input.id ?? this.ids(),
      project_id: input.projectId ?? null,
      storage_key: input.storageKey,
      original_name: input.originalName,
      bytes: input.bytes,
      mime_type: input.mimeType,
      info_json: toJson(normalizeMediaInfo(input.info)),
      findings_json: toJson(normalizeFindings(input.findings)),
      cover_key: input.coverKey ?? null,
      derived_from_asset_id: input.derivedFromAssetId ?? null,
      derived_for_platform: input.derivedForPlatform ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO assets (id, project_id, storage_key, original_name, bytes, mime_type,
                             info_json, findings_json, cover_key,
                             derived_from_asset_id, derived_for_platform, created_at)
         VALUES (@id, @project_id, @storage_key, @original_name, @bytes, @mime_type,
                 @info_json, @findings_json, @cover_key,
                 @derived_from_asset_id, @derived_for_platform, @created_at)`,
      )
      .run(row);
    return toModel(row);
  }

  getById(id: string): Asset | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM assets WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  getByStorageKey(key: string): Asset | null {
    const r = this.db
      .prepare<[string], Row>("SELECT * FROM assets WHERE storage_key = ?")
      .get(key);
    return r ? toModel(r) : null;
  }

  /** Yalnızca transcoder çıktıları için: kaynak + hedef platform bağı. */
  listDerivedFrom(assetId: string): Asset[] {
    return this.db
      .prepare<[string], Row>(
        `SELECT * FROM assets
         WHERE derived_from_asset_id = ?
         ORDER BY derived_for_platform, created_at, id`,
      )
      .all(assetId)
      .map(toModel);
  }

  listByProject(projectId: string, limit = 100): Asset[] {
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?",
      )
      .all(projectId, limit)
      .map(toModel);
  }

  setCoverKey(id: string, coverKey: string | null): boolean {
    return this.db.prepare("UPDATE assets SET cover_key = ? WHERE id = ?").run(coverKey, id).changes > 0;
  }

  setProjectId(id: string, projectId: string | null): boolean {
    return (
      this.db.prepare("UPDATE assets SET project_id = ? WHERE id = ?").run(projectId, id).changes > 0
    );
  }

  /** Bulguları değiştirir (yeniden doğrulama sonrası). */
  setFindings(id: string, findings: ValidationFinding[]): boolean {
    return (
      this.db
        .prepare("UPDATE assets SET findings_json = ? WHERE id = ?")
        .run(toJson(normalizeFindings(findings)), id).changes > 0
    );
  }

  /**
   * HTTP listeleme filtresi (EKSİTME).
   *
   * Gerekçe: `GET /assets?projectId=` panelin ilk ekranı. Mevcut `list` proje
   * filtresi almaz, `listByProject` ise `offset` kabul etmez; ikisini birleştiren
   * tek koşul üretici eklendi (mevcut metotlar DOKUNULMADAN duruyor).
   */
  listFiltered(filter: AssetListFilter = {}): Asset[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.projectId !== undefined) {
      where.push("project_id = @project_id");
      params.project_id = filter.projectId;
    }
    if (filter.storageKey !== undefined) {
      where.push("storage_key = @storage_key");
      params.storage_key = filter.storageKey;
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    params.limit = pageSize(filter.limit);
    params.offset = pageOffset(filter.offset);
    return this.db
      .prepare<Record<string, unknown>, Row>(
        `SELECT * FROM assets${clause} ORDER BY created_at DESC, id LIMIT @limit OFFSET @offset`,
      )
      .all(params)
      .map(toModel);
  }

  list(limit = 100, offset = 0): Asset[] {
    return this.db
      .prepare<[number, number], Row>(
        "SELECT * FROM assets ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
      .map(toModel);
  }

  remove(id: string): boolean {
    // contents.asset_id ON DELETE RESTRICT: kullanan içerik varsa reddedilir.
    // Ayrıca derived_from_asset_id ON DELETE RESTRICT: türevi olan kaynak da
    // silinemez, aksi halde kopya havada kalır.
    return this.db.prepare("DELETE FROM assets WHERE id = ?").run(id).changes > 0;
  }
}
