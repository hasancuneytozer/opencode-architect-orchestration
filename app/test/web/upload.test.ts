/**
 * `web/src/lib/upload.ts` — yükleme çekirdeğinin SAF mantığı.
 *
 * Kapsam: dosya kabul/ret (tür, boyut, Instagram uyarısı), kuyruk hazırlama
 * (çift yükleme uyarısı, boyut sırası), ilerleme yüzdesi, durum makinesi
 * (`idle→uploading→done|error`), hata mesajı eşlemesi (HTTP → Türkçe) ve besleme
 * formunun multipart alanlarına çevrilmesi.
 *
 * Burada DOM yoktur: `<input type=file>` ve `XMLHttpRequest` YOK; bunlar
 * `components/UploadPanel.tsx` ile `api/client.ts`'in işidir. Bu yüzden test
 * paketinde jsdom kurmaya gerek yok.
 */
import { describe, expect, it } from "vitest";

import {
  FEED_PLATFORMS,
  HASHTAG_LIMIT,
  INSTAGRAM_MAX_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  activeUploads,
  advanceUpload,
  beginUpload,
  checkCandidate,
  completeUpload,
  countUploadsByState,
  emptyFeedForm,
  extensionOf,
  failUpload,
  filesFromInput,
  hasActiveUploads,
  instagramWarning,
  isSameFile,
  isVideoCandidate,
  nextUploadSeq,
  parseHashtags,
  prepareFiles,
  progressPercent,
  removeUpload,
  toIngestFields,
  uploadErrorMessage,
  uploadStatusLabel,
  type FileLike,
  type QueuedUpload,
} from "../../web/src/lib/upload.js";

const MB = 1024 * 1024;

const file = (over: Partial<FileLike> = {}): FileLike => ({
  name: "klip.mp4",
  size: 5 * MB,
  type: "video/mp4",
  ...over,
});

const queued = (over: Partial<QueuedUpload> = {}): QueuedUpload => ({
  id: "u1",
  name: "klip.mp4",
  size: 5 * MB,
  type: "video/mp4",
  state: "pending",
  percent: 0,
  loaded: 0,
  error: null,
  warnInstagram: false,
  ...over,
});

// ── Kabul kriterleri ────────────────────────────────────────────────────────

describe("kabul kriterleri", () => {
  it("mp4/mov/webm kabul edilir", () => {
    for (const name of ["a.mp4", "b.mov", "c.webm", "d.MKV"]) {
      expect(checkCandidate(file({ name, type: "" })).ok).toBe(true);
    }
  });

  it("accept niteliği video/* içerir", () => {
    expect(UPLOAD_ACCEPT).toBe("video/*");
  });

  it("resim/metin dosyası reddedilir ve sebebi Türkçedir", () => {
    const check = checkCandidate(file({ name: "kapak.png", type: "image/png" }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("Desteklenmeyen dosya türü");
  });

  it("boş dosya (0 bayt) reddedilir", () => {
    const check = checkCandidate(file({ size: 0 }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("0 bayt");
  });

  it("2 GB üstü dosya reddedilir (sunucu sınırı)", () => {
    const check = checkCandidate(file({ size: MAX_UPLOAD_BYTES + 1 }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("çok büyük");
  });

  it("tam 2 GB kabul edilir (sınır dahil)", () => {
    expect(checkCandidate(file({ size: MAX_UPLOAD_BYTES })).ok).toBe(true);
  });

  it("300 MB üstü dosyada Instagram uyarısı verilir ama ENGELLENMEZ", () => {
    const size = INSTAGRAM_MAX_BYTES + 1;
    const check = checkCandidate(file({ size }));
    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.warnInstagram).toBe(true);
    expect(instagramWarning(size)).toContain("300 MB");
  });

  it("300 MB altı dosyada uyarı yoktur", () => {
    expect(checkCandidate(file({ size: INSTAGRAM_MAX_BYTES })).warnInstagram).toBe(false);
    expect(instagramWarning(INSTAGRAM_MAX_BYTES)).toBeNull();
  });

  it("uzantı yoksa type alanı belirleyicidir", () => {
    expect(extensionOf("klip")).toBeNull();
    expect(extensionOf("klip.MP4")).toBe(".mp4");
    expect(isVideoCandidate(file({ name: "klip", type: "video/webm" }))).toBe(true);
    expect(isVideoCandidate(file({ name: "klip", type: "" }))).toBe(false);
  });
});

// ── Kuyruk hazırlama ────────────────────────────────────────────────────────

describe("kuyruk hazırlama", () => {
  it("geçerli dosyalar kuyruğa girer ve küçükten büyüğe sıralanır", () => {
    const out = prepareFiles(
      [file({ name: "buyuk.mp4", size: 900 * MB }), file({ name: "kucuk.mp4", size: 2 * MB })],
      [],
    );
    expect(out.accepted.map((i) => i.name)).toEqual(["kucuk.mp4", "buyuk.mp4"]);
    expect(out.rejected).toEqual([]);
  });

  it("ret edilen dosya gerekçesi listelenir", () => {
    const out = prepareFiles([file({ name: "notlar.txt", type: "text/plain" })], []);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.name).toBe("notlar.txt");
  });

  it("AYNI dosya iki kez seçilirse ikincisi kuyruğa GİRMEZ", () => {
    const first = prepareFiles([file()], []);
    const out = prepareFiles([file()], first.accepted);
    expect(out.accepted).toEqual([]);
    expect(out.duplicates).toHaveLength(1);
    expect(out.duplicates[0]?.reason).toContain("iki kez yüklenmedi");
  });

  it("aynı seçimde tekrarlanan dosya yalnız bir kez kabul edilir", () => {
    const out = prepareFiles([file(), file()], []);
    expect(out.accepted).toHaveLength(1);
    expect(out.duplicates).toHaveLength(1);
  });

  it("ad aynı ama boyut farklıysa çift sayılmaz", () => {
    expect(isSameFile(file(), file())).toBe(true);
    expect(isSameFile(file(), file({ size: 9 * MB }))).toBe(false);
  });

  it("Instagram uyarısı kabul edilen dosyaya taşınır", () => {
    const out = prepareFiles([file({ size: 350 * MB })], []);
    expect(out.accepted[0]?.warnInstagram).toBe(true);
    expect(out.warnings[0]).toContain("300 MB");
  });

  it("kimlikler art arda ve çakışmaz", () => {
    const a = prepareFiles([file({ name: "a.mp4" })], []);
    const b = prepareFiles([file({ name: "b.mp4" })], a.accepted);
    expect(a.accepted[0]?.id).toBe("u1");
    expect(b.accepted[0]?.id).toBe("u2");
    expect(nextUploadSeq(b.accepted)).toBe(3);
  });

  it("<input>.files dizisinden dosya okunur, boş girdi [] verir", () => {
    const list = { length: 2, 0: { name: "a.mp4", size: 10, type: "video/mp4" }, 1: null };
    expect(filesFromInput({ files: list })).toEqual([
      { name: "a.mp4", size: 10, type: "video/mp4" },
    ]);
    expect(filesFromInput(null)).toEqual([]);
    expect(filesFromInput({ files: { length: 0 } })).toEqual([]);
  });
});

// ── İlerleme ────────────────────────────────────────────────────────────────

describe("ilerleme yüzdesi", () => {
  it("0..100 aralığında tam sayı verir", () => {
    expect(progressPercent(0, 1000)).toBe(0);
    expect(progressPercent(500, 1000)).toBe(50);
    expect(progressPercent(1000, 1000)).toBe(100);
  });

  it("toplam bilinmiyorsa 0 döner, NaN yutmaz", () => {
    expect(progressPercent(500, null)).toBe(0);
    expect(progressPercent(500, 0)).toBe(0);
    expect(progressPercent(Number.NaN, 100)).toBe(0);
  });

  it("aşırı yüklemede 100'de tutulur", () => {
    expect(progressPercent(9999, 1000)).toBe(100);
  });
});

// ── Durum makinesi ──────────────────────────────────────────────────────────

describe("durum makinesi", () => {
  it("pending → uploading → done zinciri", () => {
    let list = [queued()];
    list = beginUpload(list, "u1");
    expect(list[0]?.state).toBe("uploading");
    list = advanceUpload(list, "u1", 250, 1000);
    expect(list[0]?.percent).toBe(25);
    list = completeUpload(list, "u1");
    expect(list[0]?.state).toBe("done");
    expect(list[0]?.percent).toBe(100);
  });

  it("uploading değilken ilerleme kaydı YOK sayılır", () => {
    const list = [queued({ state: "pending" })];
    expect(advanceUpload(list, "u1", 900, 1000)[0]?.percent).toBe(0);
  });

  it("hata durumu Türkçe gerekçe taşır", () => {
    const list = failUpload(beginUpload([queued()], "u1"), "u1", "Dosya çok büyük.");
    expect(list[0]?.state).toBe("error");
    expect(list[0]?.error).toBe("Dosya çok büyük.");
  });

  it("boş hata mesajı yutulmaz", () => {
    expect(failUpload([queued()], "u1", "")[0]?.error).toBe("Yükleme başarısız.");
  });

  it("satır düşürülebilir", () => {
    expect(removeUpload([queued(), queued({ id: "u2" })], "u1")).toHaveLength(1);
  });

  it("aktif sayacı ve sayım doğru", () => {
    const list = [queued({ id: "u1", state: "done" }), queued({ id: "u2", state: "uploading" })];
    expect(activeUploads(list).map((i) => i.id)).toEqual(["u2"]);
    expect(hasActiveUploads(list)).toBe(true);
    expect(countUploadsByState(list, "done")).toBe(1);
    expect(hasActiveUploads([queued({ state: "done" })])).toBe(false);
  });

  it("durum metinleri: bekliyor / yükleniyor %N / tamamlandı / hata", () => {
    expect(uploadStatusLabel(queued())).toBe("bekliyor");
    expect(uploadStatusLabel(queued({ state: "uploading", percent: 42 }))).toBe("yükleniyor %42");
    expect(uploadStatusLabel(queued({ state: "done" }))).toBe("tamamlandı");
    expect(uploadStatusLabel(queued({ state: "error" }))).toBe("hata");
  });
});

// ── Hata mesajı eşlemesi ────────────────────────────────────────────────────

describe("hata mesajı eşlemesi", () => {
  it("413 → dosya çok büyük (sunucu ayrıntısıyla)", () => {
    const msg = uploadErrorMessage({
      status: 413,
      code: "payload_too_large",
      message: "Gövde çok büyük (üst sınır aşıldı).",
    });
    expect(msg).toContain("çok büyük");
    expect(msg).toContain("üst sınır aşıldı");
  });

  it("415 → desteklenmeyen tür", () => {
    const msg = uploadErrorMessage({ status: 415, code: "unsupported_media_type", message: null });
    expect(msg).toContain("Desteklenmeyen dosya türü");
  });

  it("400 validation_failed → sunucunun Türkçe mesajı AYENEN gösterilir", () => {
    const serverText = "En az bir geçerli platform seçilmeli.";
    expect(
      uploadErrorMessage({ status: 400, code: "validation_failed", message: serverText }),
    ).toBe(serverText);
  });

  it("401 → oturum uyarısı", () => {
    expect(uploadErrorMessage({ status: 401, code: "unauthorized", message: "Oturum yok." })).toContain(
      "Oturum",
    );
  });

  it("ağ hatası (status null) sunucuya ulaşılamadı der", () => {
    expect(uploadErrorMessage({ status: null, code: "network_error", message: null })).toContain(
      "ulaşılamadı",
    );
  });

  it("iptal ayrı metin verir", () => {
    expect(uploadErrorMessage({ status: null, code: "aborted", message: null })).toBe(
      "Yükleme iptal edildi.",
    );
  });

  it("bilinmeyen 500 sunucu hatası olarak gösterilir", () => {
    expect(uploadErrorMessage({ status: 500, code: "internal_error", message: null })).toContain(
      "HTTP 500",
    );
  });
});

// ── Besleme formu ───────────────────────────────────────────────────────────

describe("besleme formu", () => {
  it("varsayılan: proje `genel` ve üç platform işaretli", () => {
    const form = emptyFeedForm();
    expect(form.project).toBe("genel");
    expect(form.platforms).toEqual([...FEED_PLATFORMS]);
  });

  it("platform listesi virgüllü dizeye çevrilir", () => {
    const fields = toIngestFields(emptyFeedForm(), ["instagram", "tiktok"]);
    expect(fields["platforms"]).toBe("instagram,tiktok");
    expect(fields["project"]).toBe("genel");
    expect(fields["autoSchedule"]).toBe("false");
  });

  it("bilinmeyen platform listeden düşer", () => {
    const fields = toIngestFields(emptyFeedForm(), ["instagram", "myspace"]);
    expect(fields["platforms"]).toBe("instagram");
  });

  it("açıklama ve hashtag'ler defaultCopy JSON alanına girer", () => {
    const form = { ...emptyFeedForm(), description: "Merhaba", hashtags: "#kahve #kahve" };
    const fields = toIngestFields(form, ["instagram"]);
    const copy = JSON.parse(fields["defaultCopy"] ?? "{}") as Record<string, unknown>;
    expect(copy["description"]).toBe("Merhaba");
    expect(copy["hashtags"]).toEqual(["kahve"]);
  });

  it("boş formda defaultCopy alanı GÖNDERİLMEZ", () => {
    expect(toIngestFields(emptyFeedForm(), ["instagram"])["defaultCopy"]).toBeUndefined();
  });

  it("hashtag ayrıştırma: # kaldırılır, tekrar elenir, boşlar düşer", () => {
    expect(parseHashtags("#a, b  #a\n#")).toEqual(["a", "b"]);
  });

  it("hashtag sınırı 30'dur", () => {
    const many = Array.from({ length: 40 }, (_, i) => `#t${i}`).join(" ");
    expect(parseHashtags(many)).toHaveLength(HASHTAG_LIMIT);
  });
});
