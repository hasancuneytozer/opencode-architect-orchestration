/**
 * Ingest API anahtarı üretimi.
 *
 * GÜVENLİK SÖZLEŞMESİ (tek kural, iki yerde tekrarlanmaz):
 *   * Ham anahtar YALNIZCA bir kez, üreten çağrıya döner.
 *   * Veritabanında yalnızca `sha256` özeti ve gösterilebilir `prefix` tutulur.
 *
 * Neden 32 bayt: 256 bit entropi. Anahtar `X-Api-Key` başlığıyla taşınır ve
 * tünelle internete açılan bir sunucuda kimliktir; 16 bayt (128 bit) kaba
 * kuvvetle denenebilir.
 *
 * Neden `sp_` öneki: `SP_INGEST_KEYS` ortam değişkenindeki anahtarlarla aynı
 * biçimi paylaşır, yanlışlıkla `Authorization: Bearer` yerine `X-Api-Key`
 * konulduğunda hata ayıklaması kolaylaşır. `keyPrefix()` ilk 8 karakteri
 * gösterdiği için önek tanıtıcıdır.
 */
import { randomBytes } from "node:crypto";
import type { ApiKeyRepo } from "../db/index.js";
import { keyPrefix } from "../db/index.js";

/** Anahtar öneki. `keyPrefix()` bunu gösterir. */
export const API_KEY_PREFIX = "sp_";
/** Anahtar malzemesi: 32 bayt → base64url. */
export const API_KEY_BYTES = 32;
/** Ingest anahtarının kabul edilen biçimi. */
export const API_KEY_PATTERN = /^sp_[A-Za-z0-9_-]{43}$/;

export interface NewApiKey {
  /** Yalnızca BİR KEZ gösterilir. Yeniden okunamaz. */
  key: string;
  prefix: string;
  id: string;
}

/** Ham anahtar üretir (henüz kaydedilmez). */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString("base64url")}`;
}

/** Biçim denetimi. Kayıt aramadan ÖNCE çalıştırılır. */
export function isApiKeyShaped(raw: string): boolean {
  return typeof raw === "string" && API_KEY_PATTERN.test(raw);
}

export interface CreateApiKeyOptions {
  /** Proje adı. Anahtarın hangi AI projesine ait olduğunu görünür kılar. */
  project?: string | null;
  /** `api-key create <proje>` komutundaki konum etiketi. */
  name?: string;
  scopes?: string[];
}

/**
 * Anahtarı üretir ve `api_keys` tablosuna yazar.
 *
 * Ham anahtar DB'ye GİRMEZ: repo `create()` çağrısında özet ve ön eke
 * indirger, dönen `rawKey` burada yalnızca çağırıya iletilir.
 */
export function createApiKey(repo: ApiKeyRepo, opts: CreateApiKeyOptions = {}): NewApiKey {
  const rawKey = generateApiKey();
  const name = opts.name?.trim() || (opts.project ? `ingest:${opts.project}` : "ingest");
  const { record } = repo.create({
    name,
    rawKey,
    scopes: opts.scopes ?? ["ingest"],
    projectName: opts.project ?? null,
  });
  return { key: rawKey, prefix: record.prefix || keyPrefix(rawKey), id: record.id };
}