/**
 * Hesaplar — liste + panelden OAuth "Bağlan" akışı.
 *
 * Sunucu tarafı (`src/http/server.ts`):
 *   `GET /api/v1/auth/:platform/start`   → `{ok, data:{url}}` (OAuth sağlayıcısı)
 *   `GET /api/v1/auth/:platform/callback` → 303 `/#/accounts?linked=<p>&ok=1`
 *                                          ya da `/#/accounts?linked=<p>&error=<kod>`
 *
 * İki kural:
 *  - Dönüş bildiriminin METNİ `returnNotice` üretir; `?error=` değeri ham kod
 *    olabilir ve hiçbir dalda gövdeye girmez.
 *  - `needs_reauth` hesaplar AYRI bölümde durur: o hesaplar yayın yapamaz,
 *    karışık liste içinde kaybolup unutulur.
 *
 * Hesap bağlantısını KALDIRMA ucu hâlâ yok → o düğme dürüstçe devre dışıdır
 * (gizlenmez; nedeni yazılır).
 */
import { useMemo, useRef, useState } from "react";

import { authStart, endpoints, listAccounts } from "../api/endpoints.js";
import { useAsync } from "../api/hooks.js";
import { Badge, CopyableKey } from "../components/Badge.js";
import { PlatformBadge } from "../components/PlatformBits.js";
import {
  Button,
  EmptyState,
  ErrorBox,
  Loading,
  Panel,
  UnavailableButton,
} from "../components/Ui.js";
import {
  canConnect,
  connectLabel,
  connectStateFor,
  missingKeysFor,
  returnNotice,
  statusTone,
} from "../lib/accounts.js";
import { ACCOUNT_STATUS_META, platformLabel } from "../lib/labels.js";
import { DASH, formatRelativeTime } from "../lib/format.js";
import type { Platform } from "../api/types.js";

const NO_DISCONNECT_ENDPOINT =
  "Sunucuda hesap bağlantısını kaldırma ucu yok (kaldırma için `accounts` satırı elle silinmeli). Bağlanma yalnızca yeni/yenilenen yetkilendirme içindir.";

const DOC_FILE = "docs/KIMLIK-KURULUMU.md";

/** `Button` bileşeni odak halkası tanımlamıyor; kart düğmelerinde eklenir. */
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function Accounts() {
  const accounts = useAsync(() => listAccounts(), []);
  const setup = useAsync(() => endpoints.setup(), []);
  const nowMs = Date.now();

  /**
   * Dönüş adresi `#/accounts?…` olduğu için sorgu `location.search` DEĞİL,
   * `location.hash` içindedir (`src/http/server.ts` → `accountsHashPath`).
   * Geri çağırma 303 + tam sayfa yüklemesi yaptığı için `useState` ilk değeri
   * bir kez okumak YETERLİDİR.
   */
  const [notice] = useState(() => returnNotice(window.location.hash));
  /** Hangi platformun akışı başlatıldı — düğme metni buradan beslenir. */
  const [redirecting, setRedirecting] = useState<Platform | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  /**
   * Çift tıklama kilidi. `busy` state'i render sonrası geçerli olur; aynı
   * karede iki tık iki `state` gönderimi demektir ve iki OAuth `state` üretilir.
   * Ref anında karar verir.
   */
  const starting = useRef(false);
  const accountList = useRef<HTMLDivElement>(null);

  const list = accounts.data ?? [];
  const platforms = setup.data?.platforms ?? [];

  const sorted = useMemo(() => {
    const weight = (status: string): number =>
      status === "needs_reauth" ? 0 : status === "active" ? 1 : 2;
    return [...list].sort((a, b) => {
      const w = weight(a.status) - weight(b.status);
      if (w !== 0) return w;
      return platformLabel(a.platform).localeCompare(platformLabel(b.platform), "tr");
    });
  }, [list]);

  const needsReauth = sorted.filter((a) => a.status === "needs_reauth");
  const ready = sorted.filter((a) => a.status !== "needs_reauth");

  /**
   * OAuth akışını başlatır ve tarayıcıyı sağlayıcıya götürür.
   *
   * Başarılıysa `starting` KİLİTLİ kalır: sayfa zaten ayrılıyor. Başarısızsa
   * kilit açılır — yoksa kullanıcı tek denemeden sonra çıkmaz durumda kalırdı.
   */
  async function startConnect(platform: Platform): Promise<void> {
    if (starting.current) return;
    starting.current = true;
    setRedirecting(platform);
    setStartError(null);
    try {
      const url = await authStart(platform);
      window.location.href = url;
    } catch (cause) {
      starting.current = false;
      setRedirecting(null);
      setStartError(cause);
    }
  }

  /** "Yönet": bağlı hesapları gösteren bölüme odaklanır (satır içi yönetim yok). */
  function focusAccountList(): void {
    accountList.current?.scrollIntoView({ block: "start" });
    accountList.current?.focus();
  }

  return (
    <div className="space-y-3">
      {notice.kind === null ? null : (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          aria-live={notice.kind === "error" ? "assertive" : "polite"}
          className={`rounded border px-3 py-2 text-[13px] ${
            notice.kind === "error"
              ? "border-danger/60 bg-danger/15 text-danger"
              : "border-ok/60 bg-ok/15 text-ok"
          }`}
        >
          {notice.text}
        </div>
      )}

      <Panel title="Bağlan" subtitle="GET /api/v1/auth/:platform/start">
        {setup.loading ? <Loading label="Platform yapılandırması okunuyor…" /> : null}
        {setup.error !== null ? (
          <ErrorBox error={setup.error} context="Platform yapılandırması okunamadı" />
        ) : null}
        {startError === null ? null : (
          <ErrorBox error={startError} context="Bağlanma başlatılamadı" />
        )}

        {setup.data === null ? null : (
          <ul className="grid gap-2 sm:grid-cols-3">
            {platforms.map((platform) => {
              const own = list.filter((account) => account.platform === platform.platform);
              const state = connectStateFor(platform.platform, platform.configured, list);
              const label = connectLabel(platform.platform, state);
              const allowed = canConnect(platform.platform, platform.configured);
              const missing = missingKeysFor(platform.platform, platform);
              const busy = redirecting !== null;
              const connecting = redirecting === platform.platform;
              return (
                <li
                  key={platform.platform}
                  className={`rounded border px-2.5 py-2 ${
                    allowed ? "border-line bg-elev" : "border-danger/50 bg-danger/10"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PlatformBadge platform={platform.platform} full />
                    <Badge tone={allowed ? "ok" : "danger"}>
                      {platform.configured ? "yapılandırıldı" : "yapılandırılmadı"}
                    </Badge>
                  </div>

                  <p className="mt-1.5 text-[11px] text-muted">
                    bağlı hesap: {own.length === 0 ? "yok" : own.length}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      variant={label === "Bağlan" || label === "Yeniden bağlan" ? "primary" : "ghost"}
                      busy={connecting}
                      disabled={!allowed || busy}
                      className={FOCUS_RING}
                      ariaLabel={`${platformLabel(platform.platform)} — ${label}`}
                      title={
                        allowed
                          ? `${platformLabel(platform.platform)} OAuth ekranı açılır`
                          : "Önce eksik .env anahtarlarını tanımlayın"
                      }
                      onClick={() => {
                        if (label === "Yönet") focusAccountList();
                        else void startConnect(platform.platform);
                      }}
                    >
                      {label}
                    </Button>
                    {connecting ? (
                      <span role="status" aria-live="polite" className="text-[11px] text-muted">
                        Yönlendiriliyor…
                      </span>
                    ) : null}
                  </div>

                  {platform.configured ? null : (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-muted">
                          eksik anahtar{missing.length === 1 ? "" : "lar"}:
                        </span>
                        {missing.length === 0 ? (
                          <span className="text-[11px] text-faint">
                            sunucu anahtar adı bildirmedi (OAuth sağlayıcısı bu sunucuda kurulu
                            olmayabilir)
                          </span>
                        ) : (
                          missing.map((key) => <CopyableKey key={key} envKey={key} />)
                        )}
                      </div>
                      <p className="text-[11px] text-faint">
                        Doküman:{" "}
                        <a
                          className="text-accent underline"
                          href={`docs/${platform.docAnchor ?? "KIMLIK-KURULUMU.md"}`}
                          title="Depo kökündeki dosya; panel sunucusundan servis edilmiyorsa dosyayı elle açın"
                        >
                          {DOC_FILE}
                        </a>
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {needsReauth.length > 0 ? (
        <Panel
          title="Yeniden yetkilendirme gerekli"
          subtitle={`${needsReauth.length} hesap yayın yapamaz`}
        >
          <p className="mb-2 text-[12px] text-fg">
            Bu hesapların erişim bilgisi geçersiz. Yayın yapabilmeleri için OAuth ekranından
            yeniden yetkilendirme gerekir; eski hesap kaydı yerinde güncellenir.
          </p>
          <ul className="space-y-1.5">
            {needsReauth.map((account) => (
              <li
                key={account.id}
                className="rounded border border-danger/60 bg-danger/10 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <PlatformBadge platform={account.platform} full />
                  <Badge tone={statusTone(account.status)}>
                    {ACCOUNT_STATUS_META[account.status]?.label ?? "Bilinmeyen durum"}
                  </Badge>
                  {account.label === null ? null : <Badge tone="muted">{account.label}</Badge>}
                  <span className="ml-auto font-mono text-[10px] text-faint">
                    {formatRelativeTime(account.createdAt, nowMs)}
                  </span>
                </div>
                <p className="mt-1 text-[13px] font-medium text-fg">{account.displayName}</p>
                <p className="text-[11px] text-muted">
                  {account.username === null ? DASH : `@${account.username}`} · externalId{" "}
                  <span className="font-mono">{account.externalId}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-danger">
                  {ACCOUNT_STATUS_META[account.status]?.help ??
                    "Sunucu bu hesap için tanımadığı bir durum gönderdi."}
                </p>
                <div className="mt-1.5">
                  <Button
                    variant="primary"
                    busy={redirecting === account.platform}
                    disabled={redirecting !== null}
                    className={FOCUS_RING}
                    ariaLabel={`${account.displayName} (${platformLabel(account.platform)}) — yeniden bağlan`}
                    onClick={() => void startConnect(account.platform)}
                  >
                    Yeniden bağlan
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div ref={accountList} tabIndex={-1}>
        <Panel title="Bağlı hesaplar" subtitle={`${ready.length} kayıt`}>
          {accounts.loading ? <Loading /> : null}
          {accounts.error !== null ? (
            <ErrorBox error={accounts.error} onRetry={accounts.reload} />
          ) : null}

          {accounts.settled && accounts.error === null && sorted.length === 0 ? (
            <EmptyState
              title="Bağlı hesap yok."
              hint="Yukarıdaki platform kartından “Bağlan” düğmesine basın; OAuth ekranında izinleri onayladıktan sonra hesap burada listelenir."
            />
          ) : null}

          {ready.length === 0 ? null : (
            <ul className="space-y-1.5">
              {ready.map((account) => (
                <li key={account.id} className="rounded border border-line bg-elev px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PlatformBadge platform={account.platform} full />
                    <Badge tone={statusTone(account.status)}>
                      {ACCOUNT_STATUS_META[account.status]?.label ?? "Bilinmeyen durum"}
                    </Badge>
                    {account.label === null ? null : <Badge tone="muted">{account.label}</Badge>}
                    <span className="ml-auto font-mono text-[10px] text-faint">
                      {formatRelativeTime(account.createdAt, nowMs)}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] font-medium text-fg">{account.displayName}</p>
                  <p className="text-[11px] text-muted">
                    {account.username === null ? DASH : `@${account.username}`} · externalId{" "}
                    <span className="font-mono">{account.externalId}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-faint">
                    {ACCOUNT_STATUS_META[account.status]?.help ??
                      "Sunucu bu hesap için tanımadığı bir durum gönderdi."}
                  </p>
                  <div className="mt-1.5">
                    <UnavailableButton label="Bağlantıyı kaldır" reason={NO_DISCONNECT_ENDPOINT} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
