/**
 * Şema kısıtları — veritabanı seviyesinde gerçekten reddedildiğini doğrular.
 * Repository'nin erken doğrulamasını değil, ŞEMAYI test ediyoruz; çünkü
 * repository'lerden başka yollarla da veri girilebilir.
 */
import { afterEach, describe, expect, it } from "vitest";
import { emptyInfo, newContent, openTempDb, seed, type TempDb } from "./helpers.js";

let tmp: TempDb | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

const ins = (db: TempDb["db"], sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

describe("CHECK kısıtları", () => {
  it("accounts.platform yalnızca instagram|tiktok|youtube kabul eder", () => {
    tmp = openTempDb();
    const db = tmp.db;
    const now = new Date().toISOString();

    for (const p of ["instagram", "tiktok", "youtube"]) {
      expect(() =>
        ins(
          db,
          "INSERT INTO accounts (id, platform, external_id, display_name, status, created_at) VALUES (?,?,?,?,?,?)",
          `a-${p}`,
          p,
          `e-${p}`,
          "ad",
          "active",
          now,
        ),
      ).not.toThrow();
    }

    expect(() =>
      ins(
        db,
        "INSERT INTO accounts (id, platform, external_id, display_name, status, created_at) VALUES (?,?,?,?,?,?)",
        "a-kotu",
        "facebook",
        "e-x",
        "ad",
        "active",
        now,
      ),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("publish_jobs.state yalnızca tanımlı SEKİZ durumu kabul eder", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos);
    const now = new Date().toISOString();
    const valid = [
      "queued",
      "preparing",
      "uploading",
      "processing",
      "published",
      "published_no_link",
      "failed",
      "canceled",
    ];

    for (const s of valid) {
      // Her durum için AYRI içerik: ux_publish_jobs_target (content, platform,
      // account) üçlüsünü korur, aynı içeriği iki kez kuyruğa girmesi zaten
      // ayrı bir testin konusu.
      const asset = tmp.repos.assets.create({
        storageKey: `${s}.mp4`,
        originalName: `${s}.mp4`,
        bytes: 1,
        mimeType: "video/mp4",
        info: { ...emptyInfo(), path: `${s}.mp4` },
      });
      const content = tmp.repos.contents.create({ projectId: project.id, assetId: asset.id });
      expect(() =>
        ins(
          tmp!.db,
          `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          `j-${s}`,
          content.id,
          account.id,
          "instagram",
          s,
          now,
          `idem-${s}`,
          now,
          now,
        ),
      ).not.toThrow();
    }

    // Geçersiz durum için AYRI bir içerik: döngüdeki son içeriği yeniden
    // kullanmak ux_publish_jobs_target UNIQUE kısıtına düşürür ve test,
    // kastettiği state CHECK'i yerine yanlış kısıtı ölçmeye başlardı.
    const kotu = newContent(tmp.repos, project.id, "gecersiz-durum.mp4");
    expect(() =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        "j-kotu",
        kotu.id,
        account.id,
        "instagram",
        "uploadinggg",
        now,
        "idem-kotu",
        now,
        now,
      ),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("idempotency_key UNIQUE kısıtı: mükerrer yayın engellenir", () => {
    tmp = openTempDb();
    const { project, account } = seed(tmp.repos, "tiktok");
    const now = new Date().toISOString();
    const mk = (key: string, storage: string) => {
      const asset = tmp!.repos.assets.create({
        storageKey: storage,
        originalName: storage,
        bytes: 1,
        mimeType: "video/mp4",
        info: { ...emptyInfo(), path: storage },
      });
      const content = tmp!.repos.contents.create({ projectId: project.id, assetId: asset.id });
      return () =>
        ins(
          tmp!.db,
          `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          `job-${storage}`,
          content.id,
          account.id,
          "tiktok",
          "queued",
          now,
          key,
          now,
          now,
        );
    };

    const ekle = mk("tt-init-abc", "bir.mp4");
    ekle();
    // Aynı anahtar: sunucuya gönderilecek istek aynı, ikinci yayın olur.
    expect(ekle).toThrow(/UNIQUE constraint failed/i);

    // Farklı anahtar kabul edilir.
    expect(mk("tt-init-xyz", "iki.mp4")).not.toThrow();
  });

  it("published_no_link CHECK kısıtını geçer, geçersiz durum hâlâ reddedilir", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "tiktok",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });

    // Yayın tamam, permalink çözümlenemedi (TikTok SELF_ONLY).
    expect(() =>
      ins(tmp!.db, "UPDATE publish_jobs SET state = 'published_no_link' WHERE id = ?", job.id),
    ).not.toThrow();
    expect(tmp.repos.jobs.getById(job.id)?.state).toBe("published_no_link");

    for (const kotu of ["published_no_linkk", "PUBLISHED_NO_LINK", "published-no-link", ""]) {
      expect(() =>
        ins(tmp!.db, "UPDATE publish_jobs SET state = ? WHERE id = ?", kotu, job.id),
      ).toThrow(/CHECK constraint failed/i);
    }
  });

  it("assets.derived_for_platform yalnızca tanımlı platformları kabul eder", () => {
    tmp = openTempDb();
    const { project, asset } = seed(tmp.repos);
    expect(
      tmp.repos.assets.create({
        projectId: project.id,
        storageKey: "turev.mp4",
        originalName: "turev.mp4",
        bytes: 1,
        mimeType: "video/mp4",
        info: { ...emptyInfo(), path: "turev.mp4" },
        derivedFromAssetId: asset.id,
        derivedForPlatform: "youtube",
      }).derivedForPlatform,
    ).toBe("youtube");

    expect(() =>
      ins(tmp!.db, "UPDATE assets SET derived_for_platform = 'myspace' WHERE storage_key = 'turev.mp4'"),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("publish_jobs.platform CHECK kısıtını da uygular", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos, "tiktok");
    const now = new Date().toISOString();
    // `idempotency_key` 003'te NOT NULL oldu; onsuz ham INSERT CHECK'ten ÖNCE
    // NOT NULL'da düşer ve test, platform kısıtını hiç sınamaz.
    expect(() =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        "j-p-kotu",
        content.id,
        account.id,
        "myspace",
        "queued",
        now,
        "idem-p-kotu",
        now,
        now,
      ),
    ).toThrow(/CHECK constraint failed/i);

    // Aynı satır, platform doğruysa kabul edilir: kısıt INSERT'i değil,
    // değeri reddediyor.
    expect(() =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        "j-p-iyi",
        newContent(tmp!.repos, tmp!.repos.contents.getById(content.id)!.projectId, "dogru-platform.mp4").id,
        account.id,
        "tiktok",
        "queued",
        now,
        "idem-p-iyi",
        now,
        now,
      ),
    ).not.toThrow();
  });

  it("contents.state CHECK kısıtı geçersiz durumu reddeder", () => {
    tmp = openTempDb();
    const { project, asset, content } = seed(tmp.repos);
    expect(() =>
      ins(
        tmp!.db,
        "UPDATE contents SET state = 'yayinda' WHERE id = ?",
        content.id,
      ),
    ).toThrow(/CHECK constraint failed/i);

    // Geçerli durumlar kabul edilir.
    for (const s of [
      "draft",
      "validating",
      "ready",
      "scheduled",
      "published",
      "partial",
      "failed",
      "canceled",
    ]) {
      expect(() => ins(tmp!.db, "UPDATE contents SET state = ? WHERE id = ?", s, content.id)).not.toThrow();
    }
    void project;
    void asset;
  });

  it("accounts.status CHECK kısıtı uygular", () => {
    tmp = openTempDb();
    const { account } = seed(tmp.repos);
    expect(() => ins(tmp!.db, "UPDATE accounts SET status = 'silik' WHERE id = ?", account.id)).toThrow(
      /CHECK constraint failed/i,
    );
  });

  it("attempts negatif olamaz", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const now = new Date().toISOString();
    // `idempotency_key` NOT NULL: onsuz hata `attempts` CHECK'ine ulaşamaz.
    expect(() =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, attempts, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        "j-neg",
        content.id,
        account.id,
        "instagram",
        "queued",
        now,
        -1,
        "idem-neg",
        now,
        now,
      ),
    ).toThrow(/CHECK constraint failed/i);

    // Aynı satır, attempts 0 ise kabul edilir: kısıt sayının kendisini değil,
    // negatif olmasını reddediyor.
    expect(() =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, attempts, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        "j-sifir",
        newContent(tmp!.repos, tmp!.repos.contents.getById(content.id)!.projectId, "sifir-dene.mp4").id,
        account.id,
        "instagram",
        "queued",
        now,
        0,
        "idem-sifir",
        now,
        now,
      ),
    ).not.toThrow();
  });
});

describe("yabancı anahtar (FOREIGN KEY)", () => {
  it("İçeriği olan projeyi silmeyi engeller (ON DELETE RESTRICT)", () => {
    tmp = openTempDb();
    const { project, content } = seed(tmp.repos);
    expect(() => tmp!.repos.projects.remove(project.id)).toThrow(/FOREIGN KEY/i);
    expect(tmp.repos.projects.getById(project.id)).not.toBeNull();
    expect(tmp.repos.contents.getById(content.id)).not.toBeNull();
  });

  it("İçeriği olan varlığı silmeyi engeller", () => {
    tmp = openTempDb();
    const { asset } = seed(tmp.repos);
    expect(() => tmp!.repos.assets.remove(asset.id)).toThrow(/FOREIGN KEY/i);
  });

  it("Yabancı anahtarı olmayan projeyi silmeye izin verir", () => {
    tmp = openTempDb();
    const p = tmp.repos.projects.create({ name: "bos-proje" });
    expect(() => tmp!.repos.projects.remove(p.id)).not.toThrow();
    expect(tmp.repos.projects.getById(p.id)).toBeNull();
  });

  it("Hesabı silince kimlik bilgileri ve işler CASCADE ile temizlenir", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    tmp.repos.credentials.save({
      accountId: account.id,
      platform: "instagram",
      accessTokenEnc: "şifreli",
    });
    const job = tmp.repos.jobs.create({
      contentId: content.id,
      platform: "instagram",
      accountId: account.id,
      scheduledAt: new Date().toISOString(),
    });

    tmp.repos.accounts.remove(account.id);

    expect(tmp.repos.credentials.getByAccountId(account.id)).toBeNull();
    expect(tmp.repos.jobs.getById(job.id)).toBeNull();
  });

  it("Olmayan projeye içerik yazılamaz", () => {
    tmp = openTempDb();
    const { asset } = seed(tmp.repos);
    expect(() =>
      tmp!.repos.contents.create({ projectId: "yok-boyle-bir-proje", assetId: asset.id }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("benzersizlik ve indeksler", () => {
  it("unique(content_id, platform, account_id): aynı içerik aynı hesaba iki kez kuyruğa giremez", () => {
    tmp = openTempDb();
    const { content, account } = seed(tmp.repos);
    const when = new Date().toISOString();
    // `idempotency_key` NOT NULL: onsuz UNIQUE beklentisi NOT NULL'a düşer.
    // Anahtarlar da AYRI olmalı — aynı anahtarı kullansaydık UNIQUE, hedef
    // üçlüsü değil ux_publish_jobs_idempotency indeksinden gelirdi ve test
    // yanlış kısıtı ölçmeye devam ederdi.
    const mk = (id: string) =>
      ins(
        tmp!.db,
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        content.id,
        account.id,
        "instagram",
        "queued",
        when,
        `idem-${id}`,
        when,
        when,
      );

    mk("j1");
    expect(() => mk("j2")).toThrow(/UNIQUE constraint failed/i);

    // Farklı hesap → farklı iş: kısıt üçlünün tamamını korur.
    const other = tmp.repos.accounts.create({
      platform: "instagram",
      externalId: "ext-2",
      displayName: "Başka",
    });
    expect(() => mk("j3")).toThrow(/UNIQUE constraint failed/i);
    // `ins` EAGER çalışır ve `run()` sonucunu döndürür: `expect(...).not.toThrow()`
    // bir nesneye uygulanamaz. Doğru (ve daha güçlü) beklenti: satır GERÇEKTEN
    // yazıldı. "Çokmadı" demek sessizce yok sayan bir INSERT'u da geçirirdi.
    const r = ins(
      tmp!.db,
      `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      "j4",
      content.id,
      other.id,
      "instagram",
      "queued",
      when,
      "idem-j4",
      when,
      when,
    );
    expect(r.changes).toBe(1);
    expect(tmp.repos.jobs.getById("j4")).not.toBeNull();
  });

  it("(state, scheduled_at) birleşik indeksi gerçekten var", () => {
    tmp = openTempDb();
    const idx = tmp.db
      .prepare<[], { name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'publish_jobs'",
      )
      .all();

    const compound = idx.find((i) => (i.sql ?? "").includes("state") && (i.sql ?? "").includes("scheduled_at"));
    expect(compound, "(state, scheduled_at) indeksi bulunmalıydı").toBeDefined();
    expect(compound?.name).toBe("ix_publish_jobs_state_scheduled");
  });

  it("Kiralama alanları (lease_owner, lease_expires_at) şemada yer alır", () => {
    tmp = openTempDb();
    const cols = tmp.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('publish_jobs')")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("lease_owner");
    expect(cols).toContain("lease_expires_at");
  });

  it("Zamanlayıcının sıra sorgusu tam tarama yapmaz (indeks kullanır)", () => {
    tmp = openTempDb();
    const plan = tmp.repos.jobs.explainDueQuery(new Date()).join(" | ");
    expect(plan).toMatch(/ix_publish_jobs|SEARCH/i);
    expect(plan).not.toMatch(/SCAN publish_jobs\b/i);
  });
});
