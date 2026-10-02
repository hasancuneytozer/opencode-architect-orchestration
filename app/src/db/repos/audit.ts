/** `audit_events` tablosu. */
import { type Db, type IdFactory, nowIso, uuid } from "./../base.js";
import { fromJson, toJson } from "./../json.js";

interface Row {
  id: string;
  at: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail_json: string;
}

function toModel(r: Row): {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
} {
  return {
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: fromJson<Record<string, unknown>>(r.detail_json, {}),
  };
}

export interface AuditInput {
  id?: string;
  at?: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  record(input: AuditInput): AuditRecord {
    const row: Row = {
      id: input.id ?? this.ids(),
      at: input.at ?? nowIso(),
      actor: input.actor,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      detail_json: toJson(input.detail ?? {}),
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, at, actor, action, target_type, target_id, detail_json)
         VALUES (@id, @at, @actor, @action, @target_type, @target_id, @detail_json)`,
      )
      .run(row);
    return toModel(row);
  }

  getById(id: string): AuditRecord | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM audit_events WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  /** Bir nesnenin geçmişi, yeni→eski. */
  listForTarget(targetType: string, targetId: string, limit = 100): AuditRecord[] {
    return this.db
      .prepare<[string, string, number], Row>(
        `SELECT * FROM audit_events
         WHERE target_type = ? AND target_id = ?
         ORDER BY at DESC, id LIMIT ?`,
      )
      .all(targetType, targetId, limit)
      .map(toModel);
  }

  listByAction(action: string, limit = 100): AuditRecord[] {
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM audit_events WHERE action = ? ORDER BY at DESC, id LIMIT ?",
      )
      .all(action, limit)
      .map(toModel);
  }

  listSince(iso: string, limit = 200): AuditRecord[] {
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM audit_events WHERE at >= ? ORDER BY at DESC, id LIMIT ?",
      )
      .all(iso, limit)
      .map(toModel);
  }

  count(): number {
    const r = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM audit_events").get();
    return r?.n ?? 0;
  }
}
