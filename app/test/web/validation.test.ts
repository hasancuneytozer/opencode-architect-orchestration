/**
 * `web/src/lib/validation.ts` — şiddet grupları, provisional sayacı,
 * "yayına hazır" kararı.
 */
import { describe, expect, it } from "vitest";

import type { ValidationFinding } from "../../src/contract/index.js";
import {
  countBySeverity,
  countProvisional,
  emptyGroups,
  filterBySeverity,
  findingCodeLabel,
  findingDetail,
  groupBySeverity,
  isPublishReady,
  platformReport,
  provisionalFindings,
  sortFindings,
  summarize,
} from "../../web/src/lib/validation.js";

const f = (
  code: string,
  severity: ValidationFinding["severity"],
  extra: Partial<ValidationFinding> = {},
): ValidationFinding => ({
  code,
  severity,
  message: `${code} kuralı`,
  ...extra,
});

const FINDINGS: ValidationFinding[] = [
  f("aspect_ratio", "error", { observed: "1:1", limit: "9:16" }),
  f("duration_max", "warning", { observed: "62 sn", limit: "60 sn", provisional: true }),
  f("fps_range", "info", { observed: "30", limit: "24-60" }),
  f("file_size_max", "warning", { observed: "90 MB", limit: "100 MB" }),
];

describe("groupBySeverity", () => {
  it("üç grubu ayırır", () => {
    const groups = groupBySeverity(FINDINGS);
    expect(groups.error).toHaveLength(1);
    expect(groups.warning).toHaveLength(2);
    expect(groups.info).toHaveLength(1);
  });

  it("grupları birbirinden bağımsız döndürür", () => {
    const groups = groupBySeverity(FINDINGS);
    expect(groups.error.some((x) => x.code === "fps_range")).toBe(false);
  });

  it("null ve boş girdide çökmez", () => {
    expect(groupBySeverity(null)).toEqual(emptyGroups());
    expect(groupBySeverity(undefined)).toEqual(emptyGroups());
    expect(groupBySeverity([])).toEqual(emptyGroups());
  });
});

describe("filterBySeverity / countBySeverity", () => {
  it("tek şiddeti süzer", () => {
    expect(filterBySeverity(FINDINGS, "warning").map((x) => x.code)).toEqual([
      "duration_max",
      "file_size_max",
    ]);
  });

  it("sayar", () => {
    expect(countBySeverity(FINDINGS)).toEqual({ error: 1, warning: 2, info: 1 });
    expect(countBySeverity(null)).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

describe("provisional sınırlar", () => {
  it("doğrulanmamış sınırları ayırır ve sayar", () => {
    expect(provisionalFindings(FINDINGS).map((x) => x.code)).toEqual(["duration_max"]);
    expect(countProvisional(FINDINGS)).toBe(1);
  });

  it("provisional işareti olmayan bulgu sayılmaz", () => {
    expect(countProvisional([f("x", "error", { provisional: false })])).toBe(0);
    expect(countProvisional([f("x", "error")])).toBe(0);
  });

  it("null'da sıfır", () => {
    expect(countProvisional(null)).toBe(0);
  });
});

describe("isPublishReady — tek bir error yeter", () => {
  it("tek error varsa yayına hazır değildir", () => {
    expect(isPublishReady(FINDINGS)).toBe(false);
  });

  it("yalnız uyarı/bilgi yayına engel değildir", () => {
    expect(isPublishReady([f("a", "warning"), f("b", "info")])).toBe(true);
  });

  it("bulgu yoksa hazırdır", () => {
    expect(isPublishReady([])).toBe(true);
    expect(isPublishReady(null)).toBe(true);
  });

  it("provisional olan error da engeldir", () => {
    expect(isPublishReady([f("a", "error", { provisional: true })])).toBe(false);
  });
});

describe("summarize", () => {
  it("tüm sayaçları tek yerde toplar", () => {
    const s = summarize(FINDINGS);
    expect(s).toEqual({ errors: 1, warnings: 2, infos: 1, provisional: 1, total: 4, ready: false });
  });

  it("boş girdide sıfır ve hazır", () => {
    expect(summarize(null).ready).toBe(true);
    expect(summarize(null).total).toBe(0);
  });
});

describe("findingDetail — ölçülen ve sınır gösterilir", () => {
  it("ölçülen ve sınırı birleştirir", () => {
    expect(findingDetail(FINDINGS[0]!)).toBe("aspect_ratio kuralı (ölçülen 1:1 · sınır 9:16)");
  });

  it("yalnız sınır varsa onu yazar", () => {
    expect(findingDetail(f("a", "warning", { limit: "60" }))).toBe("a kuralı (sınır 60)");
  });

  it("alan yoksa mesajı aynen döner", () => {
    expect(findingDetail(f("a", "info"))).toBe("a kuralı");
  });
});

describe("sortFindings", () => {
  it("hata → uyarı → bilgi sırasına dizer", () => {
    const sorted = sortFindings(FINDINGS);
    expect(sorted.map((x) => x.severity)).toEqual(["error", "warning", "warning", "info"]);
  });

  it("girdi dizisini değiştirmez", () => {
    const copy = [...FINDINGS];
    sortFindings(FINDINGS);
    expect(FINDINGS).toEqual(copy);
  });

  it("null'da boş dizi", () => {
    expect(sortFindings(null)).toEqual([]);
  });
});

describe("bulgu kodu etiketleri", () => {
  it("bilinen kodu insan diline çevirir", () => {
    expect(findingCodeLabel("aspect_ratio")).toBe("En boy oranı");
    expect(findingCodeLabel("duration_max")).toBe("Azami süre");
  });

  it("bilinmeyen kodu olduğu gibi bırakır (uydurma etiket yok)", () => {
    expect(findingCodeLabel("bilinmeyen_kural")).toBe("bilinmeyen_kural");
  });
});

describe("platformReport", () => {
  it("platform başına özet üretir", () => {
    const row = platformReport("instagram", FINDINGS);
    expect(row.platform).toBe("instagram");
    expect(row.summary.errors).toBe(1);
    expect(row.provisionalCodes).toEqual(["duration_max"]);
    expect(row.findings[0]?.severity).toBe("error");
  });

  it("bulgu yoksa sıfır özet", () => {
    const row = platformReport("tiktok", []);
    expect(row.summary.total).toBe(0);
    expect(row.summary.ready).toBe(true);
    expect(row.provisionalCodes).toEqual([]);
  });
});