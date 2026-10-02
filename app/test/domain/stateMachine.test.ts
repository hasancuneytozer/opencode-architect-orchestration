/**
 * Durum makinesi testleri.
 *
 * İKİ KURAL KİLİTLENİR:
 *  1) Terminal durumdan HİÇBİR çıkış yok. `published` bir permalink'tir;
 *     geri dönmek aynı içeriği ikinci kez yayınlamaktır.
 *  2) `queued → published` reddedilir: hazırlanmadan yayınlanmış sayılamaz.
 * Reddedilen her geçiş GEREKÇELİDİR; üretimde "neden olmadı" bilinmezse
 * saatler harcanır.
 */
import { describe, expect, it } from "vitest";

import { ALL_JOB_STATES } from "../../src/contract/index.js";
import type { JobState } from "../../src/contract/index.js";
import {
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  TERMINAL_STATES,
  assertTransition,
  canRequeueForRetry,
  canTransition,
  explainTransition,
  isTerminal,
} from "../../src/domain/stateMachine.js";
import { aggregateContentState } from "../../src/domain/stateMachine.js";

const TERMINALS: JobState[] = ["published", "published_no_link", "failed", "canceled"];

describe("canTransition — tablo", () => {
  it("izin verilen geçişler kabul edilir", () => {
    expect(canTransition("queued", "preparing")).toBe(true);
    expect(canTransition("queued", "canceled")).toBe(true);
    expect(canTransition("preparing", "uploading")).toBe(true);
    expect(canTransition("preparing", "failed")).toBe(true);
    expect(canTransition("preparing", "queued")).toBe(true);
    expect(canTransition("uploading", "processing")).toBe(true);
    expect(canTransition("uploading", "queued")).toBe(true);
    expect(canTransition("processing", "published")).toBe(true);
    expect(canTransition("processing", "published_no_link")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
    expect(canTransition("processing", "queued")).toBe(true);
    expect(canTransition("processing", "canceled")).toBe(true);
  });

  it("REGRESYON: queued → published REDDEDİLİR", () => {
    expect(canTransition("queued", "published")).toBe(false);
    expect(canTransition("queued", "published_no_link")).toBe(false);
  });

  it("REGRESYON: terminal durumdan hiçbir yere çıkılamaz", () => {
    for (const from of TERMINALS) {
      for (const to of ALL_JOB_STATES) {
        expect(canTransition(from, to)).toBe(false);
        expect(explainTransition(from, to)).toBeTruthy();
      }
    }
  });

  it("kendine geçiş reddedilir (idempotent kayıt için geçiş çağrılmaz)", () => {
    for (const state of ALL_JOB_STATES) {
      expect(canTransition(state, state)).toBe(false);
      expect(explainTransition(state, state)).toContain("KENDİNE GEÇİŞ");
    }
  });

  it("aşamalar geriye atlanamaz", () => {
    expect(canTransition("queued", "uploading")).toBe(false);
    expect(canTransition("queued", "processing")).toBe(false);
    expect(canTransition("preparing", "processing")).toBe(false);
    expect(canTransition("preparing", "published")).toBe(false);
    expect(canTransition("uploading", "published")).toBe(false);
    expect(canTransition("processing", "uploading")).toBe(false);
    expect(canTransition("processing", "preparing")).toBe(false);
  });

  it("başarısız durum yalnız iş akışında ulaşılabilir", () => {
    expect(canTransition("queued", "failed")).toBe(false);
    expect(canTransition("preparing", "failed")).toBe(true);
    expect(canTransition("uploading", "failed")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
  });

  it("tablo tüm durumları kapsar ve yalnız ALLOWED_TRANSITIONS'e uyar", () => {
    for (const from of ALL_JOB_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
      }
      for (const to of ALL_JOB_STATES) {
        expect(canTransition(from, to)).toBe(ALLOWED_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("isTerminal tabloyla tutarlıdır", () => {
    for (const state of ALL_JOB_STATES) {
      expect(isTerminal(state)).toBe(TERMINALS.includes(state));
      expect(TERMINAL_STATES.has(state)).toBe(isTerminal(state));
    }
  });
});

describe("explainTransition — red gerekçesi", () => {
  it("izin verilen geçişte null döner", () => {
    expect(explainTransition("queued", "preparing")).toBeNull();
  });

  it("terminal durumlar duruma özel gerekçe üretir", () => {
    expect(explainTransition("published", "queued")).toContain("permalink");
    expect(explainTransition("canceled", "queued")).toContain("iptal");
    expect(explainTransition("failed", "queued")).toContain("canRequeueForRetry");
    expect(explainTransition("published_no_link", "failed")).toBeTruthy();
  });

  it("aşama atlama reddi açıklama içerir", () => {
    expect(explainTransition("queued", "published")).toContain("kuyruktayken");
    expect(explainTransition("uploading", "published")).toContain("yükleme");
    expect(explainTransition("processing", "uploading")).toContain("queued");
  });

  it("HER reddedilen çift için anlamlı gerekçe üretilir", () => {
    for (const from of ALL_JOB_STATES) {
      for (const to of ALL_JOB_STATES) {
        if (canTransition(from, to)) continue;
        const reason = explainTransition(from, to) as string;
        expect(reason.length).toBeGreaterThan(20);
        // Gerekçe ya durumu ya da izlenecek yolu adlandırır; boş veya jenerik
        // "geçersiz" mesajı üretmek, gerekçe üretmiş gibi görünmemelidir.
        expect(reason).not.toBe("geçersiz");
      }
    }
  });
});

describe("assertTransition", () => {
  it("izin verilen geçişte fırlatmaz", () => {
    expect(() => assertTransition("queued", "preparing")).not.toThrow();
  });

  it("reddedilen geçişte gerekçeli hata fırlatır", () => {
    expect(() => assertTransition("published", "queued")).toThrow(IllegalTransitionError);
    try {
      assertTransition("published", "queued");
      throw new Error("fırlatmalıydı");
    } catch (err) {
      const e = err as IllegalTransitionError;
      expect(e.from).toBe("published");
      expect(e.to).toBe("queued");
      expect(e.reason).toBeTruthy();
      expect(e.message).toContain("published → queued");
    }
  });
});

describe("canRequeueForRetry", () => {
  it("yalnız failed işi yeniden denemeye alır", () => {
    expect(canRequeueForRetry("failed")).toBe(true);
    expect(canRequeueForRetry("queued")).toBe(false);
    expect(canRequeueForRetry("published")).toBe(false);
    expect(canRequeueForRetry("canceled")).toBe(false);
  });

  it("bu bir durum geçişi DEĞİLDİR: assertTransition devreye girmez", () => {
    // failed → queued reddedilir; işçi yine de yeniden deneyebilir.
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canRequeueForRetry("failed")).toBe(true);
  });
});

describe("aggregateContentState", () => {
  it("hepsi yayınlandıysa published", () => {
    expect(aggregateContentState(["published", "published", "published"])).toBe("published");
  });

  it("hepsi yayınlandı (permalink'siz) ise de published", () => {
    expect(aggregateContentState(["published", "published_no_link"])).toBe("published");
  });

  it("hepsi iptal ise canceled", () => {
    expect(aggregateContentState(["canceled", "canceled"])).toBe("canceled");
  });

  it("başarılı + başarısız = partial", () => {
    expect(aggregateContentState(["published", "failed"])).toBe("partial");
    expect(aggregateContentState(["published", "published", "failed"])).toBe("partial");
  });

  it("başarılı + iptal = partial", () => {
    expect(aggregateContentState(["published", "canceled"])).toBe("partial");
  });

  it("hepsi terminal, en az biri başarısız ve başarı yoksa failed", () => {
    expect(aggregateContentState(["failed", "failed"])).toBe("failed");
    expect(aggregateContentState(["failed", "canceled"])).toBe("failed");
  });

  it("aktif durum varsa scheduled", () => {
    expect(aggregateContentState(["queued"])).toBe("scheduled");
    expect(aggregateContentState(["published", "queued"])).toBe("scheduled");
    expect(aggregateContentState(["failed", "uploading"])).toBe("scheduled");
    expect(aggregateContentState(["processing", "preparing"])).toBe("scheduled");
  });

  it("boş dizi scheduled (hepsi başarılı DEĞİLDİR)", () => {
    expect(aggregateContentState([])).toBe("scheduled");
  });

  it("tek iş durumu birebir yansıtılır", () => {
    expect(aggregateContentState(["published"])).toBe("published");
    expect(aggregateContentState(["failed"])).toBe("failed");
    expect(aggregateContentState(["canceled"])).toBe("canceled");
    expect(aggregateContentState(["uploading"])).toBe("scheduled");
  });
});