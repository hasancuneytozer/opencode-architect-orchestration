/**
 * `credentials` tablosu.
 *
 * ÖNEMLİ NOT — kriptografi bu paketin işi DEĞİLDİR:
 *   * `access_token_enc` / `refresh_token_enc` düz metin DEĞİLDİR; şifreli
 *     metindir (ör. AES-256-GCM, sonuç base64).
 *   * Çözme/şifreleme `src/security/crypto.ts` yapacaktır. Bu repository
 *     yalnızca sütunları hazır tutar, `*_enc` alanına dokunmadan yazar ve
 *     alanı aynen döndürür.
 *   * Böylece veri katmanının testleri bir anahtar yönetimine bağımlı olmaz.
 */
import type { Platform } from "../../contract/index.js";
import { type Db, assertPlatform, nowIso } from "./../base.js";
import { fromJson, toJson } from "./../json.js";

interface Row {
  account_id: string;
  platform: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  scopes_json: string;
  provider_user_id: string | null;
  updated_at: string;
}

export interface CredentialRecord {
  accountId: string;
  platform: Platform;
  /** Şifreli erişim belirteci. Çözecek olan adaptördür. */
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  providerUserId: string | null;
  updatedAt: string;
}

function toModel(r: Row): CredentialRecord {
  return {
    accountId: r.account_id,
    platform: r.platform as Platform,
    accessTokenEnc: r.access_token_enc,
    refreshTokenEnc: r.refresh_token_enc,
    tokenExpiresAt: r.token_expires_at,
    scopes: fromJson<string[]>(r.scopes_json, []),
    providerUserId: r.provider_user_id,
    updatedAt: r.updated_at,
  };
}

export interface UpsertCredentialInput {
  accountId: string;
  platform: Platform;
  accessTokenEnc: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string[];
  providerUserId?: string | null;
}

export class CredentialRepo {
  constructor(private readonly db: Db) {}

  /** Hesabın tek kimlik kaydı vardır; upsert. */
  save(input: UpsertCredentialInput): CredentialRecord {
    assertPlatform(input.platform);
    const row: Row = {
      account_id: input.accountId,
      platform: input.platform,
      access_token_enc: input.accessTokenEnc,
      refresh_token_enc: input.refreshTokenEnc ?? null,
      token_expires_at: input.tokenExpiresAt ?? null,
      scopes_json: toJson(input.scopes ?? []),
      provider_user_id: input.providerUserId ?? null,
      updated_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO credentials (account_id, platform, access_token_enc, refresh_token_enc,
                                  token_expires_at, scopes_json, provider_user_id, updated_at)
         VALUES (@account_id, @platform, @access_token_enc, @refresh_token_enc,
                 @token_expires_at, @scopes_json, @provider_user_id, @updated_at)
         ON CONFLICT(account_id) DO UPDATE SET
           platform          = excluded.platform,
           access_token_enc  = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           token_expires_at  = excluded.token_expires_at,
           scopes_json       = excluded.scopes_json,
           provider_user_id  = excluded.provider_user_id,
           updated_at        = excluded.updated_at`,
      )
      .run(row);
    return toModel(row);
  }

  getByAccountId(accountId: string): CredentialRecord | null {
    const r = this.db
      .prepare<[string], Row>("SELECT * FROM credentials WHERE account_id = ?")
      .get(accountId);
    return r ? toModel(r) : null;
  }

  /** Yenileme sonrası yalnızca token alanları değişir. */
  updateTokens(
    accountId: string,
    patch: { accessTokenEnc?: string; refreshTokenEnc?: string | null; tokenExpiresAt?: string | null },
  ): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { account_id: accountId, updated_at: nowIso() };
    if (patch.accessTokenEnc !== undefined) {
      sets.push("access_token_enc = @access_token_enc");
      params.access_token_enc = patch.accessTokenEnc;
    }
    if ("refreshTokenEnc" in patch) {
      sets.push("refresh_token_enc = @refresh_token_enc");
      params.refresh_token_enc = patch.refreshTokenEnc ?? null;
    }
    if ("tokenExpiresAt" in patch) {
      sets.push("token_expires_at = @token_expires_at");
      params.token_expires_at = patch.tokenExpiresAt ?? null;
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = @updated_at");
    return (
      this.db
        .prepare(`UPDATE credentials SET ${sets.join(", ")} WHERE account_id = @account_id`)
        .run(params).changes > 0
    );
  }

  /** Belirteci `expiryEpochMs` içinde dolacaksa true. */
  needsRefresh(accountId: string, expiryEpochMs: number): boolean {
    const r = this.getByAccountId(accountId);
    if (!r?.tokenExpiresAt) return false;
    const t = Date.parse(r.tokenExpiresAt);
    return !Number.isNaN(t) && t <= expiryEpochMs;
  }

  listByPlatform(platform: Platform): CredentialRecord[] {
    assertPlatform(platform);
    return this.db
      .prepare<[string], Row>("SELECT * FROM credentials WHERE platform = ? ORDER BY updated_at DESC")
      .all(platform)
      .map(toModel);
  }

  remove(accountId: string): boolean {
    return this.db.prepare("DELETE FROM credentials WHERE account_id = ?").run(accountId).changes > 0;
  }
}
