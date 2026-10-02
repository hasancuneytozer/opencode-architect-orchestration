/**
 * Repository gidiş-dönüş testleri.
 * "Alan kaybı yok" burada kanıtlanır: yazdığımız her alan geri okunduğunda
 * AYNI olmalı. Özellikle JSON sütunları (info, findings, tags, copy, metadata,
 * detail) düz metne çevrilip geri parse edildiği için en kayıp yeri orasıdır.
 */
import { afterEach, describe, expect, it } from "vitest";
import { digestKey, keyPrefix } from "../../src/db/index.js";
import { openTempDb, sampleFindings, sampleInfo, seed, type TempDb } from "./helpers.js";

let tmp: TempDb | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

describe("ProjectRepo", () => {
  it("oluştur → oku → güncelle → sil", () => {
    tmp = openTempDb();
    const p = tmp.repos.projects.create({ name: "AI reklamları", notes: "ilk not" });

    expect(p.id).toBeTruthy();
    expect(tmp.repos.projects.getById(p.id)).toEqual(p);
    expect(tmp.repos.projects.findByName("AI reklamları")?.id).toBe(p.id);

    expect(tmp.repos.projects.setNotes(p.id, "ikinci not")).toBe(true);
    expect(tmp.repos.projects.getById(p.id)?.notes).toBe("ikinci not");

    expect(tmp.repos.projects.ensure("AI reklamları").id).toBe(p.id);
    expect(tmp.repos.projects.count()).toBe(1);

    expect(tmp.repos.projects.remove(p.id)).toBe(true);
    expect(tmp.repos.projects.getById(p.id)).toBeNull();
  });
});

describe("AssetRepo — JSON alanları dahil kayıpsız gidiş-dönüş", () => {
  it("MediaInfo ve findings alanlarının TAMAMI geri gelir", () => {
    tmp = openTempDb();
    const info = sampleInfo();
    const findings = sampleFindings();

    const created = tmp.repos.assets.create({
      storageKey: "2026/09/klip-9x16.mp4",
      originalName: "klip.mp4",
      bytes: 98_765_432,
      mimeType: "video/mp4",
      info,
      findings,
      coverKey: "2026/09/kapak.jpg",
    });

    const back = tmp.repos.assets.getById(created.id);
    expect(back).not.toBeNull();
    expect(back!.info).toEqual(info);
    expect(back!.findings).toEqual(findings);
    expect(back!.storageKey).toBe("2026/09/klip-9x16.mp4");
    expect(back!.bytes).toBe(98_765_432);
    expect(back!.coverKey).toBe("2026/09/kapak.jpg");
    expect(back!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("null alanlar null kalır, olmayan findings boş dizi olur", () => {
    tmp = openTempDb();
    const info = sampleInfo({
      container: null,
      videoCodec: null,
      audioCodec: null,
      pixelFormat: null,
      fps: null,
      durationSec: null,
      bitrate: null,
      hasAudio: false,
    });
    const a = tmp.repos.assets.create({
      storageKey: "bos.mp4",
      originalName: "bos.mp4",
      bytes: 0,
      mimeType: "video/mp4",
      info,
    });
    const back = tmp.repos.assets.getById(a.id)!;
    expect(back.info).toEqual(info);
    expect(back.findings).toEqual([]);
    expect(back.coverKey).toBeNull();
  });

  it("kapak anahtarı ve bulgular güncellenebilir", () => {
    tmp = openTempDb();
    const a = tmp.repos.assets.create({
      storageKey: "x.mp4",
      originalName: "x.mp4",
      bytes: 1,
      mimeType: "video/mp4",
      info: sampleInfo(),
      findings: [],
    });
    expect(tmp.repos.assets.setCoverKey(a.id, "x.jpg")).toBe(true);
    expect(tmp.repos.assets.getById(a.id)?.coverKey).toBe("x.jpg");

    const yeni = sampleFindings();
    expect(tmp.repos.assets.setFindings(a.id, yeni)).toBe(true);
    expect(tmp.repos.assets.getById(a.id)?.findings).toEqual(yeni);
  });

  it("aynı storage_key iki kez kullanılamaz", () => {
    tmp = openTempDb();
    const mk = (key: string) =>
      tmp!.repos.assets.create({
        storageKey: key,
        originalName: "a",
        bytes: 1,
        mimeType: "video/mp4",
        info: sampleInfo(),
      });
    mk("ayni.mp4");
    expect(() => mk("ayni.mp4")).toThrow(/UNIQUE constraint failed/i);
  });
});

describe("ContentRepo — tags/copy/metadata JSON gidiş-dönüşü", () => {
  it("etiketler, platform metinleri ve üstveri kayıpsız döner", () => {
    tmp = openTempDb();
    const { project, asset } = seed(tmp.repos);

    const copy = {
      instagram: { caption: "9:16 dikey reklam", hashtags: ["reels", "ai"], privacy: "public" as const },
      youtube: { title: "Başlık", description: "Açıklama", madeForShorts: true },
    };
    const metadata = { source: "ai", jobId: 42, nested: { ok: true, list: [1, 2, 3] } };

    const created = tmp.repos.contents.create({
      projectId: project.id,
      assetId: asset.id,
      state: "ready",
      campaign: "kampanya-1",
      tags: ["yaz", "bahar", "promo"],
      copy,
      scheduledAt: "2026-10-01T09:00:00.000Z",
      timezone: "Europe/Istanbul",
      metadata,
    });

    const back = tmp.repos.contents.getById(created.id)!;
    expect(back.tags).toEqual(["yaz", "bahar", "promo"]);
    expect(back.copy).toEqual(copy);
    expect(back.metadata).toEqual(metadata);
    expect(back.state).toBe("ready");
    expect(back.scheduledAt).toBe("2026-10-01T09:00:00.000Z");
    expect(back.timezone).toBe("Europe/Istanbul");
  });

  it("kısmi update yalnızca verilen alanları değiştirir", () => {
    tmp = openTempDb();
    const { project, asset } = seed(tmp.repos);
    const c = tmp.repos.contents.create({
      projectId: project.id,
      assetId: asset.id,
      tags: ["a"],
      metadata: { x: 1 },
    });

    expect(tmp.repos.contents.update(c.id, { tags: ["b", "c"] })).toBe(true);
    const back = tmp.repos.contents.getById(c.id)!;
    expect(back.tags).toEqual(["b", "c"]);
    expect(back.metadata).toEqual({ x: 1 }); // dokunulmadı
    expect(back.campaign).toBeNull(); // dokunulmadı
  });

  it("geçersiz state repository katmanında da reddedilir (erken hata)", () => {
    tmp = openTempDb();
    const { project, asset } = seed(tmp.repos);
    const c = tmp.repos.contents.create({ projectId: project.id, assetId: asset.id });
    // @ts-expect-error — kasıtlı geçersiz durum
    expect(() => tmp!.repos.contents.setState(c.id, "olmayan")).toThrow(/Geçersiz içerik durumu/);
  });
});

describe("AccountRepo / CredentialRepo", () => {
  it("hesap gidiş-dönüşü ve (platform, external_id) benzersizliği", () => {
    tmp = openTempDb();
    const a = tmp.repos.accounts.create({
      platform: "instagram",
      externalId: "1784140000",
      displayName: "Marka",
      username: "marka",
      label: "ana",
    });
    expect(tmp.repos.accounts.getById(a.id)).toEqual(a);
    expect(tmp.repos.accounts.findByExternal("instagram", "1784140000")?.id).toBe(a.id);

    expect(() =>
      tmp!.repos.accounts.create({
        platform: "instagram",
        externalId: "1784140000",
        displayName: "Kopya",
      }),
    ).toThrow(/UNIQUE constraint failed/i);

    expect(tmp.repos.accounts.setStatus(a.id, "needs_reauth")).toBe(true);
    expect(tmp.repos.accounts.getById(a.id)?.status).toBe("needs_reauth");
    expect(tmp.repos.accounts.listActive()).toHaveLength(0);
    // @ts-expect-error — kasıtlı geçersiz durum
    expect(() => tmp!.repos.accounts.setStatus(a.id, "yok")).toThrow(/Geçersiz hesap durumu/);
  });

  it("kimlik bilgileri ŞİFRELİ metin olarak saklanır ve aynen geri gelir", () => {
    tmp = openTempDb();
    const { account } = seed(tmp.repos);

    const saved = tmp.repos.credentials.save({
      accountId: account.id,
      platform: "instagram",
      accessTokenEnc: "U0VBRElURl9nQ==", // şifreli metin
      refreshTokenEnc: "UkZSRVNfRW5j",
      tokenExpiresAt: "2026-12-31T23:59:59.000Z",
      scopes: ["instagram_basic", "instagram_content_publish"],
    });

    expect(saved.accessTokenEnc).toBe("U0VBRElURl9nQ==");
    expect(tmp.repos.credentials.getByAccountId(account.id)).toEqual(saved);
    expect(saved.scopes).toEqual(["instagram_basic", "instagram_content_publish"]);
  });

  it("save upsert'tir; ikinci kayıt üstüne yazar", () => {
    tmp = openTempDb();
    const { account } = seed(tmp.repos);
    tmp.repos.credentials.save({
      accountId: account.id,
      platform: "instagram",
      accessTokenEnc: "eski",
    });
    const ikinci = tmp.repos.credentials.save({
      accountId: account.id,
      platform: "instagram",
      accessTokenEnc: "yeni",
    });
    expect(ikinci.accessTokenEnc).toBe("yeni");

    const n = tmp.db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM credentials WHERE account_id = ?")
      .get(account.id);
    expect(n?.n).toBe(1);
  });

  it("needsRefresh süreye göre çalışır", () => {
    tmp = openTempDb();
    const { account } = seed(tmp.repos);
    const exp = new Date();
    tmp.repos.credentials.save({
      accountId: account.id,
      platform: "tiktok",
      accessTokenEnc: "x",
      tokenExpiresAt: exp.toISOString(),
    });
    expect(tmp.repos.credentials.needsRefresh(account.id, exp.getTime() - 1000)).toBe(false);
    expect(tmp.repos.credentials.needsRefresh(account.id, exp.getTime() + 1000)).toBe(true);
  });
});

describe("ApiKeyRepo", () => {
  it("ham anahtar SAKLANMAZ; yalnızca sha256 özeti ve 8 karakterlik ön ek tutulur", () => {
    tmp = openTempDb();
    const raw = "sp_9f8e7d6c5b4a_test_gizli_kısım";
    const { record } = tmp.repos.apiKeys.create({ name: "ci", rawKey: raw, scopes: ["ingest"] });

    expect(record.prefix).toBe("sp_9f8e7");
    expect(record.prefix.length).toBe(8);
    expect(record.prefix).toBe(keyPrefix(raw));

    const row = tmp.db
      .prepare<[string], { digest: string; prefix: string }>(
        "SELECT digest, prefix FROM api_keys WHERE id = ?",
      )
      .get(record.id)!;
    expect(row.digest).toBe(digestKey(raw));
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);

    // Ham anahtarın kendisi tabloda hiçbir yerde geçmiyor.
    const all = tmp.db
      .prepare<[], { sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.sql ?? "")
      .join(" ");
    for (const [k, v] of Object.entries(tmp.db.prepare<[], Record<string, unknown>>("SELECT * FROM api_keys").all()[0] ?? {})) {
      expect(`${k}=${String(v)}`, `sütun ${k} ham anahtarı sızdırıyor`).not.toContain("gizli_kısım");
    }
    expect(all).not.toContain(raw);
  });

  it("lookup ham anahtardan çalışır; yanlış anahtar ve iptal edilmiş anahtar reddedilir", () => {
    tmp = openTempDb();
    const raw = "sp_aaaabbbbcccc_butun_anahtar";
    const { record } = tmp.repos.apiKeys.create({ name: "ci", rawKey: raw });

    expect(tmp.repos.apiKeys.lookup(raw)?.id).toBe(record.id);
    expect(tmp.repos.apiKeys.lookup("sp_yanlis")).toBeNull();

    expect(tmp.repos.apiKeys.touch(record.id)).toBe(true);
    expect(tmp.repos.apiKeys.getById(record.id)?.lastUsedAt).not.toBeNull();

    tmp.repos.apiKeys.revoke(record.id);
    expect(tmp.repos.apiKeys.lookup(raw)).toBeNull();
    expect(tmp.repos.apiKeys.lookup(raw, { allowRevoked: true })?.id).toBe(record.id);
    expect(tmp.repos.apiKeys.list()).toHaveLength(0);
  });
});

describe("AuditRepo / SettingsRepo", () => {
  it("denetim kaydı JSON detayıyla kayıpsız döner ve hedefe göre listelenir", () => {
    tmp = openTempDb();
    const { project, content } = seed(tmp.repos);
    const detail = { jobId: "j1", reason: "süre doldu", sayi: 3, liste: ["a"] };

    const e = tmp.repos.audit.record({
      actor: "scheduler",
      action: "publish.enqueued",
      targetType: "content",
      targetId: content.id,
      detail,
    });

    expect(tmp.repos.audit.getById(e.id)?.detail).toEqual(detail);
    expect(tmp.repos.audit.listForTarget("content", content.id)).toHaveLength(1);
    expect(tmp.repos.audit.listForTarget("content", project.id)).toHaveLength(0);
    expect(tmp.repos.audit.listByAction("publish.enqueued")).toHaveLength(1);
    expect(tmp.repos.audit.count()).toBe(1);
  });

  it("settings okuma varsayılana düşer, yazma/üstüne yazma çalışır", () => {
    tmp = openTempDb();
    expect(tmp.repos.settings.get("yok", { a: 1 })).toEqual({ a: 1 });
    expect(tmp.repos.settings.has("yok")).toBe(false);

    tmp.repos.settings.set("sessiz-saat", { baslangic: "23:00", bitis: "07:00" });
    expect(tmp.repos.settings.get("sessiz-saat", null)).toEqual({ baslangic: "23:00", bitis: "07:00" });
    expect(tmp.repos.settings.has("sessiz-saat")).toBe(true);

    tmp.repos.settings.set("sessiz-saat", { baslangic: "22:00", bitis: "06:00" });
    expect(tmp.repos.settings.get("sessiz-saat", null)).toEqual({ baslangic: "22:00", bitis: "06:00" });
    expect(tmp.repos.settings.list()).toHaveLength(1);

    expect(tmp.repos.settings.delete("sessiz-saat")).toBe(true);
    expect(tmp.repos.settings.has("sessiz-saat")).toBe(false);
  });
});
