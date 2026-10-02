/**
 * Uygulama kabuğu ve yönlendirme.
 *
 * Kimlik yoksa giriş TAM EKRAN. Oturum varsa: üstte kalıcı durum çubuğu ve
 * **`mode === "mock"` ise SAHTE YAYIN MODU şeridi** — bu şerit kapatılamaz.
 */
import { useCallback, useEffect, useState } from "react";

import { endpoints } from "./api/endpoints.js";
import { isAuthError } from "./api/client.js";
import { useAction, useAsync } from "./api/hooks.js";
import { HealthBar, MockModeRibbon } from "./components/StatusBar.js";
import { Badge } from "./components/Badge.js";
import { Button, Loading } from "./components/Ui.js";
import { parseHealth } from "./lib/apiShape.js";
import { DEFAULT_ROUTE, ROUTES, ROUTE_IDS, parseRoute, routeHash } from "./lib/router.js";
import type { RouteId } from "./lib/router.js";
import { Accounts } from "./pages/Accounts.js";
import { Analytics } from "./pages/Analytics.js";
import { Content } from "./pages/Content.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Library } from "./pages/Library.js";
import { Log } from "./pages/Log.js";
import { Login } from "./pages/Login.js";
import { Setup } from "./pages/Setup.js";

/**
 * Analitik rotası `lib/router.ts`'in DIŞINDA tutulur.
 *
 * Neden: `ROUTE_IDS` sözleşmesi yalnız mevcut bölümleri tanır ve o dosya bu
 * paketin yazma yüzeyinde değil. Burada tek satır bir dizi eklemek yerine rota
 * AYRI bir kimlik olarak çözülür; `parseRoute` yalnız kendi tablosunu bilir ve
 * bilmediği bir yolu "Panel"e düşürür — yani `#/analytics` yazılsa bile ekran
 * değişmezdi.
 */
type PageRoute = RouteId | "analytics";

const ANALYTICS_PATH = "/analytics";

const ANALYTICS_META = {
  label: "Analitik",
  hint: "Ölçümler, kapsam, veri gecikmesi",
} as const;

/** `#/analytics?x=1` → `"analytics"`; diğer her şey `parseRoute`'a gider. */
function parsePageRoute(hash: string | null | undefined): PageRoute {
  const raw = (hash ?? "").replace(/^#/, "").split("?")[0] ?? "";
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned === "analytics") return "analytics";
  return parseRoute(hash);
}

function pageHash(route: PageRoute): string {
  return route === "analytics" ? `#${ANALYTICS_PATH}` : routeHash(route);
}

function pageMeta(route: PageRoute): { label: string; hint: string } {
  return route === "analytics" ? ANALYTICS_META : ROUTES[route];
}

function useHashRoute(): [PageRoute, (route: PageRoute) => void] {
  const [route, setRoute] = useState<PageRoute>(() => parsePageRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parsePageRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: PageRoute) => {
    window.location.hash = pageHash(next);
    setRoute(next);
  }, []);

  return [route, navigate];
}

function Page({
  route,
  navigate,
}: {
  route: PageRoute;
  navigate: (route: PageRoute) => void;
}) {
  switch (route) {
    case "setup":
      return <Setup />;
    case "library":
      return <Library />;
    case "content":
      return <Content />;
    case "log":
      return <Log />;
    case "accounts":
      return <Accounts />;
    case "analytics":
      return <Analytics onNavigate={(next) => navigate(next)} />;
    case "dashboard":
    default:
      return <Dashboard onNavigate={() => undefined} />;
  }
}

export function App() {
  const [route, navigate] = useHashRoute();
  const session = useAsync(() => endpoints.session(), []);
  const health = useAsync(() => endpoints.health(), [], session.data?.authenticated === true);
  const logout = useAction();

  const authenticated = session.data?.authenticated === true;
  const serverDown = session.settled && session.error !== null;
  const healthSummary = health.data === null ? null : parseHealth(health.data);

  useEffect(() => {
    if (window.location.hash === "") {
      window.location.hash = routeHash(DEFAULT_ROUTE);
    }
  }, []);

  if (session.loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loading label="Oturum durumu soruluyor…" />
      </main>
    );
  }

  if (!session.settled) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded border border-line bg-panel p-4">
          <h1 className="text-[14px] font-semibold text-fg">Sunucuya ulaşılamıyor</h1>
          <p className="mt-1 text-[12px] text-muted">
            Panel veri gösteremiyor. Bu bir hata değil, bağlantı yok — API çalışıyor olmalı.
          </p>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-elev p-2 font-mono text-[11px] text-danger">
            {String((session.error as { message?: string } | null)?.message ?? session.error ?? "")}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={session.reload}>
              Tekrar dene
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (isAuthError(session.error)) {
    return <Login onSignedIn={session.reload} />;
  }

  if (!authenticated) {
    // Sunucu yanıt verdi ama oturum açık değil → giriş ekranı.
    return <Login onSignedIn={session.reload} />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* SAHTE YAYIN MODU şeridi — mock modda veya sunucu yokken en üstte, kapatılamaz. */}
      <MockModeRibbon
        mode={healthSummary?.mode ?? session.data?.mode ?? null}
        serverDown={health.error !== null && health.settled}
      />

      <HealthBar
        health={
          healthSummary ?? {
            ok: false,
            version: null,
            uptimeSec: null,
            db: null,
            mode: session.data?.mode ?? null,
            scheduler: [],
          }
        }
        version={healthSummary?.version ?? null}
      />

      <div className="flex flex-1">
        <nav aria-label="Ana gezinme" className="w-56 shrink-0 border-r border-line bg-panel p-2">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
            Bölümler
          </p>
          <ul className="space-y-0.5">
            {ROUTE_IDS.map((id) => {
              const meta = ROUTES[id];
              const active = route === id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigate(id)}
                    className={`w-full rounded px-2 py-1.5 text-left text-[12px] ${
                      active ? "bg-accent/15 text-accent" : "text-fg hover:bg-elev"
                    }`}
                  >
                    <span className="block font-medium">{meta.label}</span>
                    <span className="block text-[10px] text-faint">{meta.hint}</span>
                  </button>
                </li>
              );
            })}
            {/* Analitik rotası `ROUTE_IDS` dışında (bkz. `parsePageRoute`). */}
            <li>
              <button
                type="button"
                aria-current={route === "analytics" ? "page" : undefined}
                onClick={() => navigate("analytics")}
                className={`w-full rounded px-2 py-1.5 text-left text-[12px] ${
                  route === "analytics" ? "bg-accent/15 text-accent" : "text-fg hover:bg-elev"
                }`}
              >
                <span className="block font-medium">{ANALYTICS_META.label}</span>
                <span className="block text-[10px] text-faint">{ANALYTICS_META.hint}</span>
              </button>
            </li>
          </ul>

          <div className="mt-3 border-t border-line pt-2">
            {healthSummary === null ? (
              <p className="px-1 text-[11px] text-muted">Sunucu durumu bilinmiyor.</p>
            ) : healthSummary.mode === "mock" ? (
              <p className="px-1 text-[11px] text-warn">
                Yayınlar sahte. Panel gerçek gönderim yapmıyor.
              </p>
            ) : null}
          </div>

          <div className="mt-3 space-y-1 border-t border-line pt-2">
            <Button
              variant="subtle"
              busy={logout.busy}
              onClick={() => {
                void logout
                  .run(async () => {
                    await endpoints.logout();
                  })
                  .then(() => session.reload());
              }}
            >
              Çıkış
            </Button>
            {logout.error !== null ? (
              <p className="text-[10px] text-danger">Çıkış başarısız.</p>
            ) : null}
          </div>
        </nav>

        <main className="min-w-0 flex-1 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h1 className="text-[15px] font-semibold text-fg">{pageMeta(route).label}</h1>
            <Badge tone="muted">{pageMeta(route).hint}</Badge>
          </div>

          {session.data !== null && session.data.configProblems.length > 0 ? (
            <div className="mb-3 rounded border border-warn/50 bg-warn/10 px-2 py-1.5 text-[11px]">
              <span className="font-semibold text-warn">
                {session.data.configProblems.length} yapılandırma sorunu var.
              </span>{" "}
              <button
                type="button"
                onClick={() => navigate("setup")}
                className="text-accent underline"
              >
                Kimlik Kurulumu ekranına git
              </button>
            </div>
          ) : null}

          {route === "dashboard" ? (
            <Dashboard onNavigate={navigate} />
          ) : (
            <Page route={route} navigate={navigate} />
          )}
        </main>
      </div>
    </div>
  );
}