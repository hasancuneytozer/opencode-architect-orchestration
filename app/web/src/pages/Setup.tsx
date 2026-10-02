/**
 * Kimlik Kurulumu sihirbazı — `GET /api/v1/setup`.
 *
 * Bu ekran DURUM GÖSTERİR, yapılandırma yapmaz: hesap ekleme ucu sunucuda henüz
 * yok. Düğme gizlenmez; devre dışı bırakılır ve nedeni tooltip ile yazılır.
 */
import { useState } from "react";

import { endpoints } from "../api/endpoints.js";
import { useAction, useAsync } from "../api/hooks.js";
import { CopyableKey, Badge } from "../components/Badge.js";
import { PlatformBadge } from "../components/PlatformBits.js";
import {
  Button,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Panel,
  TextInput,
  UnavailableButton,
} from "../components/Ui.js";
import { formatRelativeTime, DASH } from "../lib/format.js";

const NO_ACCOUNT_ENDPOINT =
  "Sunucuda hesap ekleme ucu henüz yok (POST /v1/accounts → 501). Bu ekran yapılandırma yapmaz, yalnızca eksikleri gösterir.";

export function Setup() {
  const setup = useAsync(() => endpoints.setup(), []);
  const keys = useAsync(() => endpoints.ingestKeys(), []);
  const createKey = useAction();
  const [project, setProject] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const data = setup.data;
  const blockers = (data?.problems ?? []).filter((p) => p.severity === "blocker");
  const warnings = (data?.problems ?? []).filter((p) => p.severity === "warning");

  return (
    <div className="space-y-3">
      {setup.loading ? <Loading label="Kurulum durumu okunuyor…" /> : null}
      {setup.error !== null ? <ErrorBox error={setup.error} onRetry={setup.reload} /> : null}

      {data === null ? null : (
        <>
          <Panel title="Genel durum" subtitle="GET /api/v1/setup">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={data.mode === "live" ? "ok" : data.mode === "mock" ? "warn" : "idle"}>
                {data.mode === "live" ? "canlı" : data.mode === "mock" ? "sahte (mock)" : "mod bilinmiyor"}
              </Badge>
              <Badge tone={blockers.length > 0 ? "danger" : "ok"}>
                {blockers.length > 0 ? `${blockers.length} engelleyici sorun` : "engelleyici sorun yok"}
              </Badge>
              <Badge tone={warnings.length > 0 ? "warn" : "muted"}>
                {warnings.length > 0 ? `${warnings.length} uyarı` : "uyarı yok"}
              </Badge>
            </div>
          </Panel>

          <Panel title="Sorunlar" subtitle="blocker kırmızı, warning sarı">
            {data.problems.length === 0 ? (
              <EmptyState title="Kurulum sorunu yok." hint="Tüm platformlar yapılandırılmış görünüyor." />
            ) : (
              <ul className="space-y-1.5">
                {data.problems.map((problem) => {
                  const blocker = problem.severity === "blocker";
                  return (
                    <li
                      key={`${problem.code}-${problem.severity}`}
                      className={`rounded border px-2 py-1.5 ${
                        blocker ? "border-danger/50 bg-danger/10" : "border-warn/50 bg-warn/10"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={blocker ? "danger" : "warn"}>
                          {blocker ? "Engelleyici" : "Uyarı"}
                        </Badge>
                        <span className="font-mono text-[11px] text-faint">{problem.code}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-fg">{problem.message}</p>
                      {problem.envKeys.length === 0 ? null : (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="text-[11px] text-muted">Eksik anahtarlar:</span>
                          {problem.envKeys.map((key) => (
                            <CopyableKey key={key} envKey={key} />
                          ))}
                        </div>
                      )}
                      {problem.docAnchor === null ? null : (
                        <p className="mt-1 text-[11px] text-muted">Doküman: {problem.docAnchor}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Platformlar" subtitle="GET /api/v1/setup">
            <ul className="grid gap-2 sm:grid-cols-3">
              {data.platforms.map((platform) => (
                <li key={platform.platform} className="rounded border border-line bg-elev px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PlatformBadge platform={platform.platform} full />
                    <Badge tone={platform.configured ? "ok" : "danger"}>
                      {platform.configured ? "yapılandırıldı" : "yapılandırılmadı"}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted">
                    bağlı hesap: {platform.hasAccounts ? "var" : "yok"}
                  </p>
                  {platform.missing.length === 0 ? null : (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-muted">eksik:</span>
                      {platform.missing.map((key) => (
                        <CopyableKey key={key} envKey={key} />
                      ))}
                    </div>
                  )}
                  {platform.docAnchor === null ? null : (
                    <p className="mt-1 text-[11px] text-faint">doküman: {platform.docAnchor}</p>
                  )}
                  <div className="mt-2">
                    <UnavailableButton label="Hesap ekle" reason={NO_ACCOUNT_ENDPOINT} />
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}

      <Panel
        title="AI projesi anahtarı"
        subtitle="GET/POST /api/v1/ingest/keys"
        actions={
          <Button
            variant="primary"
            busy={createKey.busy}
            disabled={project.trim() === ""}
            onClick={() => {
              void createKey.run(async () => {
                const created = await endpoints.createIngestKey(project.trim());
                setFreshKey(created.key);
                keys.reload();
              });
            }}
          >
            Anahtar üret
          </Button>
        }
      >
        <div className="space-y-2">
          <Field
            label="Proje adı"
            htmlFor="ingest-project"
            hint="Anahtar bu proje adına bağlanır; dönen değer bir kez gösterilir."
          >
            <TextInput
              id="ingest-project"
              value={project}
              placeholder="ör. urun-campaign-2026-10"
              onChange={(e) => setProject(e.currentTarget.value)}
            />
          </Field>

          {createKey.error !== null ? <ErrorBox error={createKey.error} context="Anahtar üretilemedi" /> : null}

          {freshKey === null ? null : (
            <div className="rounded border border-ok/50 bg-ok/10 px-2 py-1.5">
              <p className="text-[12px] font-semibold text-ok">Anahtar (yalnızca şimdi gösteriliyor)</p>
              <p className="mt-1 break-all font-mono text-[11px] text-fg">{freshKey}</p>
              <Button
                variant="subtle"
                onClick={() => void navigator.clipboard?.writeText(freshKey).catch(() => undefined)}
              >
                Panoya kopyala
              </Button>
            </div>
          )}

          {keys.loading ? <Loading /> : null}
          {keys.error !== null ? <ErrorBox error={keys.error} onRetry={keys.reload} /> : null}
          {keys.data === null ? null : keys.data.keys.length === 0 ? (
            <EmptyState title="Anahtar yok." hint="AI projesi içerik göndermek için anahtar üretin." />
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <caption className="sr-only">Mevcut ingest anahtarları</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-1 font-medium">
                    Proje
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Önek
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Oluşturma
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Son kullanım
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.data.keys.map((key) => (
                  <tr key={key.id} className="border-b border-line-soft last:border-0">
                    <td className="py-1 text-fg">{key.project}</td>
                    <td className="py-1 font-mono text-muted">{key.prefix}</td>
                    <td className="py-1 text-muted">{formatRelativeTime(key.createdAt)}</td>
                    <td className="py-1 text-muted">
                      {key.lastUsedAt === null ? DASH : formatRelativeTime(key.lastUsedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}