/** `accounts` tablosu. */
import type { Account, Platform } from "../../contract/index.js";
import { type Db, type IdFactory, assertPlatform, nowIso, uuid } from "./../base.js";

export type AccountStatus = Account["status"];

interface Row {
  id: string;
  platform: string;
  external_id: string;
  display_name: string;
  username: string | null;
  status: string;
  label: string | null;
  created_at: string;
}

function toModel(r: Row): Account {
  return {
    id: r.id,
    platform: r.platform as Platform,
    externalId: r.external_id,
    displayName: r.display_name,
    username: r.username,
    status: r.status as AccountStatus,
    label: r.label,
    createdAt: r.created_at,
  };
}

const STATUSES = new Set<string>(["active", "needs_reauth", "disabled"]);

export interface CreateAccountInput {
  id?: string;
  platform: Platform;
  externalId: string;
  displayName: string;
  username?: string | null;
  status?: AccountStatus;
  label?: string | null;
}

export class AccountRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  create(input: CreateAccountInput): Account {
    assertPlatform(input.platform);
    const status = input.status ?? "active";
    if (!STATUSES.has(status)) throw new Error(`Geçersiz hesap durumu: "${status}"`);
    const row: Row = {
      id: input.id ?? this.ids(),
      platform: input.platform,
      external_id: input.externalId,
      display_name: input.displayName,
      username: input.username ?? null,
      status,
      label: input.label ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO accounts (id, platform, external_id, display_name, username, status, label, created_at)
         VALUES (@id, @platform, @external_id, @display_name, @username, @status, @label, @created_at)`,
      )
      .run(row);
    return toModel(row);
  }

  getById(id: string): Account | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM accounts WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  /** (platform, external_id) benzersiz; OAuth yenilemesinde aynı hesabı buluruz. */
  findByExternal(platform: Platform, externalId: string): Account | null {
    assertPlatform(platform);
    const r = this.db
      .prepare<[string, string], Row>(
        "SELECT * FROM accounts WHERE platform = ? AND external_id = ?",
      )
      .get(platform, externalId);
    return r ? toModel(r) : null;
  }

  listByPlatform(platform?: Platform, limit = 100): Account[] {
    if (platform) {
      assertPlatform(platform);
      return this.db
        .prepare<[string, number], Row>(
          "SELECT * FROM accounts WHERE platform = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(platform, limit)
        .map(toModel);
    }
    return this.db
      .prepare<[number], Row>("SELECT * FROM accounts ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(toModel);
  }

  /**
   * Bir platformun YAYINA HAZIR ilk hesabı.
   *
   * Gerekçe: ingest kuyruğa alırken platform başına "eşleşen aktif hesap"
   * arıyor; liste hâlinde alıp JS tarafında filtrelemek iki hesap arasındaki
   * seçim kuralını gizler. Tek satır, deterministik sıra (en yeni `active`
   * hesap) döndürür. `status` filtresi burada "aktif" anlamına gelir.
   */
  findActiveByPlatform(platform: Platform): Account | null {
    assertPlatform(platform);
    const r = this.db
      .prepare<[string], Row>(
        `SELECT * FROM accounts
         WHERE platform = ? AND status = 'active'
         ORDER BY created_at DESC, id LIMIT 1`,
      )
      .get(platform);
    return r ? toModel(r) : null;
  }

  /** Platform başına aktif hesap SAYISI (kurulum sihirbazı için). */
  countActiveByPlatform(): Record<Platform, number> {
    const rows = this.db
      .prepare<[], { platform: string; n: number }>(
        "SELECT platform, COUNT(*) AS n FROM accounts WHERE status = 'active' GROUP BY platform",
      )
      .all();
    const out: Record<Platform, number> = { instagram: 0, tiktok: 0, youtube: 0 };
    for (const r of rows) {
      if (r.platform in out) out[r.platform as Platform] = r.n;
    }
    return out;
  }

  listActive(limit = 100): Account[] {
    return this.db
      .prepare<[number], Row>(
        "SELECT * FROM accounts WHERE status = 'active' ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(toModel);
  }

  setStatus(id: string, status: AccountStatus): boolean {
    if (!STATUSES.has(status)) throw new Error(`Geçersiz hesap durumu: "${status}"`);
    return this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id).changes > 0;
  }

  updateProfile(
    id: string,
    patch: Partial<{ displayName: string; username: string | null; label: string | null }>,
  ): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if ("displayName" in patch) {
      sets.push("display_name = @display_name");
      params.display_name = patch.displayName;
    }
    if ("username" in patch) {
      sets.push("username = @username");
      params.username = patch.username ?? null;
    }
    if ("label" in patch) {
      sets.push("label = @label");
      params.label = patch.label ?? null;
    }
    if (sets.length === 0) return false;
    return this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = @id`).run(params).changes > 0;
  }

  /** Kaldırılırsa kimlik bilgileri CASCADE ile silinir, işler de CASCADE. */
  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }
}
