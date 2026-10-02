/** `contents` tablosu. JSON sütunları: tags_json, copy_json, metadata_json,
 *  quiet_hours_json, ai_disclosure_json. */
import {
  AiDisclosureSchema,
  QuietHoursSchema,
  type AiDisclosure,
  type ContentItem,
  type ContentState,
  type PerPlatformCopy,
  type QuietHours,
} from "../../contract/index.js";
import { type Db, type IdFactory, assertContentState, nowIso, uuid } from "./../base.js";
import { pageOffset, pageSize } from "./../paging.js";
import { fromJson, parseJson, toJson } from "./../json.js";

/**
 * AI bildirimi varsayılanı ŞEMADAN türetilir, elle yazılmaz: `AiDisclosureSchema`
 * her alana `.default()` verir. Sözleşmedeki varsayılanla repository varsayılanı
 * ayrışırsa, kullanıcıya "AI üretimi" bildirimi sessizce düşer — bu yüzden tek
 * kaynak şema.
 */
export const DEFAULT_AI_DISCLOSURE: AiDisclosure = AiDisclosureSchema.parse({});

interface Row {
  id: string;
  project_id: string;
  asset_id: string;
  state: string;
  campaign: string | null;
  tags_json: string;
  copy_json: string;
  scheduled_at: string | null;
  timezone: string;
  quiet_hours_json: string | null;
  metadata_json: string;
  ai_disclosure_json: string | null;
  requires_approval: number;
  approved_by: string | null;
  approved_at: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

function toModel(r: Row): ContentItem {
  return {
    id: r.id,
    projectId: r.project_id,
    assetId: r.asset_id,
    state: r.state as ContentState,
    campaign: r.campaign,
    tags: fromJson<string[]>(r.tags_json, []),
    copy: fromJson<PerPlatformCopy>(r.copy_json, {}),
    scheduledAt: r.scheduled_at,
    timezone: r.timezone,
    quietHours: parseJson<QuietHours | null>(r.quiet_hours_json, QuietHoursSchema.nullable(), null),
    metadata: fromJson<Record<string, unknown>>(r.metadata_json, {}),
    aiDisclosure: parseJson<AiDisclosure>(r.ai_disclosure_json, AiDisclosureSchema, DEFAULT_AI_DISCLOSURE),
    requiresApproval: r.requires_approval !== 0,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    batchId: r.batch_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateContentInput {
  id?: string;
  projectId: string;
  assetId: string;
  state?: ContentState;
  campaign?: string | null;
  tags?: string[];
  copy?: PerPlatformCopy;
  scheduledAt?: string | null;
  timezone?: string;
  quietHours?: QuietHours | null;
  metadata?: Record<string, unknown>;
  aiDisclosure?: AiDisclosure;
  /** Reklam içeriği onaysız yayına GİREMEZ; şema varsayılanı da 1'dir. */
  requiresApproval?: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
  batchId?: string | null;
}

/**
 * HTTP listeleme filtresi. Tüm alanlar isteğe bağlıdır; boş filtre tüm
 * kayıtları döner. `limit`/`offset` sayfalamadır.
 */
export interface ContentListFilter {
  state?: ContentState;
  projectId?: string;
  campaign?: string;
  /** `created_at >= from` (ISO-8601 UTC). */
  from?: string;
  /** `created_at <= to` (ISO-8601 UTC). */
  to?: string;
  limit?: number;
  offset?: number;
}

export type ContentPatch = Partial<{
  campaign: string | null;
  tags: string[];
  copy: PerPlatformCopy;
  scheduledAt: string | null;
  timezone: string;
  quietHours: QuietHours | null;
  metadata: Record<string, unknown>;
  aiDisclosure: AiDisclosure;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  batchId: string | null;
  state: ContentState;
}>;

export class ContentRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  create(input: CreateContentInput): ContentItem {
    if (input.state) assertContentState(input.state);
    const ts = nowIso();
    const row: Row = {
      id: input.id ?? this.ids(),
      project_id: input.projectId,
      asset_id: input.assetId,
      state: input.state ?? "draft",
      campaign: input.campaign ?? null,
      tags_json: toJson(input.tags ?? []),
      copy_json: toJson(input.copy ?? {}),
      scheduled_at: input.scheduledAt ?? null,
      timezone: input.timezone ?? "Europe/Istanbul",
      quiet_hours_json: input.quietHours ? toJson(input.quietHours) : null,
      metadata_json: toJson(input.metadata ?? {}),
      ai_disclosure_json: toJson(input.aiDisclosure ?? DEFAULT_AI_DISCLOSURE),
      requires_approval: (input.requiresApproval ?? true) ? 1 : 0,
      approved_by: input.approvedBy ?? null,
      approved_at: input.approvedAt ?? null,
      batch_id: input.batchId ?? null,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO contents (id, project_id, asset_id, state, campaign, tags_json,
                               copy_json, scheduled_at, timezone, quiet_hours_json,
                               metadata_json, ai_disclosure_json, requires_approval,
                               approved_by, approved_at, batch_id,
                               created_at, updated_at)
         VALUES (@id, @project_id, @asset_id, @state, @campaign, @tags_json,
                 @copy_json, @scheduled_at, @timezone, @quiet_hours_json,
                 @metadata_json, @ai_disclosure_json, @requires_approval,
                 @approved_by, @approved_at, @batch_id,
                 @created_at, @updated_at)`,
      )
      .run(row);
    return toModel(row);
  }

  getById(id: string): ContentItem | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM contents WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  listByProject(projectId: string, limit = 100, offset = 0): ContentItem[] {
    return this.db
      .prepare<[string, number, number], Row>(
        "SELECT * FROM contents WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
      )
      .all(projectId, limit, offset)
      .map(toModel);
  }

  listByState(state: ContentState, limit = 100): ContentItem[] {
    assertContentState(state);
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM contents WHERE state = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(state, limit)
      .map(toModel);
  }

  /**
   * HTTP listeleme filtresi (EKSİTME — mevcut davranış değişmez).
   *
   * Neden gerekli: panel "tüm içerikler" ekranında durum + proje + kampanya +
   * tarih aralığı + sayfalama istiyor. Mevcut `listByProject`/`listByState`
   * tekil filtre verir ve `offset` kabul etmez; birleştirmek için ayrı bir
   * yol yazmak yerine tek bir koşul üretici metot eklendi.
   */
  listFiltered(filter: ContentListFilter = {}): ContentItem[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.state !== undefined) {
      assertContentState(filter.state);
      where.push("state = @state");
      params.state = filter.state;
    }
    if (filter.projectId !== undefined) {
      where.push("project_id = @project_id");
      params.project_id = filter.projectId;
    }
    if (filter.campaign !== undefined) {
      where.push("campaign = @campaign");
      params.campaign = filter.campaign;
    }
    // `from`/`to` `created_at` üzerinde leksikografik karşılaştırılır; tarihler
    // ISO-8601 UTC metin olduğu için bu DOĞRU bir zaman sıralamasıdır.
    if (filter.from !== undefined) {
      where.push("created_at >= @from");
      params.from = filter.from;
    }
    if (filter.to !== undefined) {
      where.push("created_at <= @to");
      params.to = filter.to;
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    params.limit = pageSize(filter.limit);
    params.offset = pageOffset(filter.offset);
    return this.db
      .prepare<Record<string, unknown>, Row>(
        `SELECT * FROM contents${clause} ORDER BY created_at DESC, id LIMIT @limit OFFSET @offset`,
      )
      .all(params)
      .map(toModel);
  }

  listByBatch(batchId: string): ContentItem[] {
    return this.db
      .prepare<[string], Row>(
        "SELECT * FROM contents WHERE batch_id = ? ORDER BY created_at, id",
      )
      .all(batchId)
      .map(toModel);
  }

  /** Verilen içeriklerden en az biri bu platformda kuyruğa alınmış mı? */
  isScheduledForPlatform(id: string, platform: string): boolean {
    const r = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM publish_jobs
         WHERE content_id = ? AND platform = ?
           AND state NOT IN ('canceled','failed')`,
      )
      .get(id, platform);
    return (r?.n ?? 0) > 0;
  }

  setState(id: string, state: ContentState): boolean {
    assertContentState(state);
    return (
      this.db
        .prepare("UPDATE contents SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, nowIso(), id).changes > 0
    );
  }

  /**
   * Onay akışı. `approvedAt` verilmezse şimdi damgalanır: onay kaydı zaman
   * damgası olmadan anlamsızdır, ama damgayı çağırandan ALMAK da aynı hata
   * sınıfıdır (sistem saati tek doğruluk kaynağı).
   */
  approve(id: string, approvedBy: string): boolean {
    if (!approvedBy) throw new Error("approve için onaylayan (approvedBy) zorunludur.");
    const ts = nowIso();
    return (
      this.db
        .prepare(
          `UPDATE contents
           SET requires_approval = 0, approved_by = ?, approved_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(approvedBy, ts, ts, id).changes > 0
    );
  }

  update(id: string, patch: ContentPatch): boolean {
    if (patch.state) assertContentState(patch.state);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: nowIso() };
    if ("campaign" in patch) {
      sets.push("campaign = @campaign");
      params.campaign = patch.campaign ?? null;
    }
    if ("tags" in patch) {
      sets.push("tags_json = @tags_json");
      params.tags_json = toJson(patch.tags ?? []);
    }
    if ("copy" in patch) {
      sets.push("copy_json = @copy_json");
      params.copy_json = toJson(patch.copy ?? {});
    }
    if ("scheduledAt" in patch) {
      sets.push("scheduled_at = @scheduled_at");
      params.scheduled_at = patch.scheduledAt ?? null;
    }
    if ("timezone" in patch) {
      sets.push("timezone = @timezone");
      params.timezone = patch.timezone ?? "Europe/Istanbul";
    }
    if ("quietHours" in patch) {
      sets.push("quiet_hours_json = @quiet_hours_json");
      params.quiet_hours_json = patch.quietHours ? toJson(patch.quietHours) : null;
    }
    if ("metadata" in patch) {
      sets.push("metadata_json = @metadata_json");
      params.metadata_json = toJson(patch.metadata ?? {});
    }
    if ("aiDisclosure" in patch) {
      sets.push("ai_disclosure_json = @ai_disclosure_json");
      params.ai_disclosure_json = toJson(patch.aiDisclosure ?? DEFAULT_AI_DISCLOSURE);
    }
    if ("requiresApproval" in patch) {
      sets.push("requires_approval = @requires_approval");
      params.requires_approval = patch.requiresApproval ? 1 : 0;
    }
    if ("approvedBy" in patch) {
      sets.push("approved_by = @approved_by");
      params.approved_by = patch.approvedBy ?? null;
    }
    if ("approvedAt" in patch) {
      sets.push("approved_at = @approved_at");
      params.approved_at = patch.approvedAt ?? null;
    }
    if ("batchId" in patch) {
      sets.push("batch_id = @batch_id");
      params.batch_id = patch.batchId ?? null;
    }
    if ("state" in patch) {
      sets.push("state = @state");
      params.state = patch.state;
    }
    if (sets.length === 0) return false;
    return (
      this.db
        .prepare(`UPDATE contents SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`)
        .run(params).changes > 0
    );
  }

  /** Bir içeriğin platform bazlı özet durumu; arayüz liste ekranı için. */
  platformStates(id: string): Array<{ platform: string; state: string; jobId: string }> {
    return this.db
      .prepare<[string], { platform: string; state: string; id: string }>(
        "SELECT platform, state, id FROM publish_jobs WHERE content_id = ? ORDER BY platform",
      )
      .all(id)
      .map((r) => ({ platform: r.platform, state: r.state, jobId: r.id }));
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM contents WHERE id = ?").run(id).changes > 0;
  }
}
