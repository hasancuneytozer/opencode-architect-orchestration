/**
 * `api_keys` tablosu.
 *
 * GÜVENLİK KURALI: ham anahtar ASLA saklanmaz. Yalnızca
 *   * `digest` — sha256(ham anahtar) hex, UNIQUE, karşılaştırma için
 *   * `prefix` — ilk 8 karakter, arayüzde tanımak için gösterilir
 * tutulur. Veritabanına sızan bir yedek, `prefix` dışında anahtarı geri
 * vermez; `prefix` zaten istemcinin bile bildiği bir parçadır.
 */
import { createHash } from "node:crypto";
import { type Db, type IdFactory, nowIso, uuid } from "./../base.js";
import { fromJson, toJson } from "./../json.js";

interface Row {
  id: string;
  name: string;
  prefix: string;
  digest: string;
  scopes_json: string;
  project_name: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function toModel(r: Row): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: fromJson<string[]>(r.scopes_json, []),
    projectName: r.project_name,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

/** sha256 özet. Karşılaştırma sabit zamanlı olmalı ama digest'te sır yok. */
export function digestKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/** Gösterilecek ön ek: ilk 8 karakter. */
export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, 8);
}

export interface CreateApiKeyInput {
  id?: string;
  name: string;
  /** Ham anahtar. Burada yalnızca özete çevrilir, saklanmaz. */
  rawKey: string;
  scopes?: string[];
  projectName?: string | null;
}

export class ApiKeyRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  /** Anahtarı üretir ve kaydeder. Ham anahtar yalnızca çağırana döner. */
  create(input: CreateApiKeyInput): { record: ApiKeyRecord; rawKey: string } {
    const row: Row = {
      id: input.id ?? this.ids(),
      name: input.name,
      prefix: keyPrefix(input.rawKey),
      digest: digestKey(input.rawKey),
      scopes_json: toJson(input.scopes ?? []),
      project_name: input.projectName ?? null,
      last_used_at: null,
      revoked_at: null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, digest, scopes_json, project_name,
                               last_used_at, revoked_at, created_at)
         VALUES (@id, @name, @prefix, @digest, @scopes_json, @project_name,
                 @last_used_at, @revoked_at, @created_at)`,
      )
      .run(row);
    return { record: toModel(row), rawKey: input.rawKey };
  }

  getById(id: string): ApiKeyRecord | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM api_keys WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  /**
   * Ham anahtardan kayıt bulur. `revoked` parametresi iptal edilmiş anahtarın
   * kabul edilip edilmediğini belirler.
   */
  lookup(rawKey: string, opts: { allowRevoked?: boolean } = {}): ApiKeyRecord | null {
    const digest = digestKey(rawKey);
    const r = opts.allowRevoked
      ? this.db.prepare<[string], Row>("SELECT * FROM api_keys WHERE digest = ?").get(digest)
      : this.db
          .prepare<[string], Row>(
            "SELECT * FROM api_keys WHERE digest = ? AND revoked_at IS NULL",
          )
          .get(digest);
    return r ? toModel(r) : null;
  }

  /** Doğru anahtardan gelen isteği işaretler. */
  touch(id: string, at = nowIso()): boolean {
    return this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id).changes > 0;
  }

  revoke(id: string, at = nowIso()): boolean {
    return this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, id).changes > 0;
  }

  list(limit = 100): ApiKeyRecord[] {
    return this.db
      .prepare<[number], Row>(
        "SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(toModel);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
  }
}
