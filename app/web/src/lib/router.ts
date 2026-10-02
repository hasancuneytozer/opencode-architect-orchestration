/**
 * Minik yönlendirici. Paket KURULMAZ; `location.hash` üzerinden çalışır.
 * SAF (saf fonksiyonlar) — test edilebilir olsun diye ayrıldı.
 */

export const ROUTE_IDS = ["dashboard", "setup", "library", "content", "log", "accounts"] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export const DEFAULT_ROUTE: RouteId = "dashboard";

export interface RouteMeta {
  id: RouteId;
  path: string;
  label: string;
  hint: string;
}

export const ROUTES: Record<RouteId, RouteMeta> = {
  dashboard: { id: "dashboard", path: "/", label: "Panel", hint: "Sağlık, sürüm, zamanlayıcı" },
  setup: { id: "setup", path: "/setup", label: "Kimlik Kurulumu", hint: "Platform yapılandırması ve eksikler" },
  library: { id: "library", path: "/library", label: "Kütüphane", hint: "Videolar ve 9:16 doğrulama" },
  content: { id: "content", path: "/content", label: "İçerik & Takvim", hint: "Metin, zamanlama, onay" },
  log: { id: "log", path: "/log", label: "Yayın Günlüğü", hint: "İşler ve hata analizi" },
  accounts: { id: "accounts", path: "/accounts", label: "Hesaplar", hint: "Bağlı hesaplar ve erişim" },
};

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === "string" && (ROUTE_IDS as readonly string[]).includes(value);
}

/** "#/library?x=1" → "library". Tanınmayan her şey PANEL'e düşer. */
export function parseRoute(hash: string | null | undefined): RouteId {
  const raw = (hash ?? "").replace(/^#/, "").split("?")[0] ?? "";
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return isRouteId(cleaned) ? cleaned : DEFAULT_ROUTE;
}

export function routePath(id: RouteId): string {
  return ROUTES[id].path;
}

export function routeHash(id: RouteId): string {
  const path = routePath(id);
  return path === "/" ? "#/" : `#${path}`;
}

/** Hash içindeki sorgu parametreleri (`#library` yerine `#/library?p=2`). */
export function parseQuery(hash: string | null | undefined): Record<string, string> {
  const raw = (hash ?? "").replace(/^#/, "");
  const qIndex = raw.indexOf("?");
  if (qIndex === -1) return {};
  const query = raw.slice(qIndex + 1);
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const [key, value = ""] = pair.split("=");
    if (key === undefined || key === "") continue;
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}