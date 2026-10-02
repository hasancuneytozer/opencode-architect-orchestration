/**
 * Panel (kaba iskelet): sürüm, veritabanı durumu, mod, zamanlayıcı.
 * `mode === "mock"` ise şerit App düzeyinde her sayfada gösterilir.
 */
import { useState } from "react";

import { endpoints } from "../api/endpoints.js";
import { useAction, useAsync } from "../api/hooks.js";
import { StatusTable } from "../components/StatusBar.js";
import { Badge } from "../components/Badge.js";
import { Button, EmptyState, ErrorBox, Loading, Panel } from "../components/Ui.js";
import { parseHealth } from "../lib/apiShape.js";
import { formatRelativeTime, DASH } from "../lib/format.js";
import type { RouteId } from "../lib/router.js";

export function Dashboard({ onNavigate }: { onNavigate: (route: RouteId) => void }) {
  const health = useAsync(() => endpoints.health(), []);
  const scheduler = useAsync(() => endpoints.scheduler(), []);
  const tick = useAction();
  const [tickNote, setTickNote] = useState<string | null>(null);

  const parsed = health.data === null ? null : parseHealth(health.data);
  const rows = parsed === null ? [] : parsed.scheduler;

  return (
    <div className="space-y-3">
      {health.loading ? <Loading label="Sağlık bilgisi alınıyor…" /> : null}
      {health.error !== null ? (
        <ErrorBox
          error={health.error}
          onRetry={health.reload}
          context="Sunucuya ulaşılamadı"
        />
      ) : null}

      {parsed === null && health.settled && health.error === null ? (
        <EmptyState title="Sağlık verisi alınamadı." />
      ) : null}

      {parsed === null ? null : (
        <Panel title="Sunucu durumu" subtitle="GET /api/health">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={parsed.mode === "live" ? "ok" : parsed.mode === "mock" ? "warn" : "idle"}>
              {parsed.mode === "live"
                ? "Canlı mod — yayınlar gerçek"
                : parsed.mode === "mock"
                  ? "Sahte yayın modu — yayınlar gerçek değil"
                  : "Mod bilinmiyor"}
            </Badge>
            <Badge tone={parsed.ok ? "ok" : "danger"}>{parsed.ok ? "sağlıklı" : "sağlıksız"}</Badge>
            <span className="font-mono text-[11px] text-muted">
              {parsed.version ?? DASH} · db {parsed.db ?? DASH}
            </span>
          </div>
          <div className="mt-2">
            <StatusTable rows={rows} caption="Sağlık yanıtındaki alanlar" />
          </div>
        </Panel>
      )}

      <Panel
        title="Zamanlayıcı"
        subtitle="GET /api/v1/scheduler"
        actions={
          <Button
            variant="primary"
            busy={tick.busy}
            onClick={() => {
              void tick.run(async () => {
                const result = await endpoints.schedulerTick();
                scheduler.reload();
                setTickNote(
                  result === null || result === undefined
                    ? "İstek kabul edildi (yanıt gövdesi boş)."
                    : "İstek kabul edildi.",
                );
              });
            }}
          >
            Şimdi çalıştır
          </Button>
        }
      >
        {tick.error !== null ? <ErrorBox error={tick.error} context="Çalıştırma isteği başarısız" /> : null}
        {tickNote === null ? null : <p className="mb-1 text-[12px] text-ok">{tickNote}</p>}
        {scheduler.loading ? <Loading /> : null}
        {scheduler.error !== null ? <ErrorBox error={scheduler.error} onRetry={scheduler.reload} /> : null}
        {scheduler.settled && scheduler.error === null ? (
          <StatusTable rows={parseHealth({ scheduler: scheduler.data ?? {} }).scheduler} caption="Zamanlayıcı durumu" />
        ) : null}
      </Panel>

      <Panel title="Nereye?" subtitle="Kısayollar">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["setup", "Kimlik Kurulumu", "Eksik .env anahtarları ve bağlı hesaplar"],
              ["library", "Kütüphane", "Videolar ve 9:16 doğrulama raporu"],
              ["content", "İçerik & Takvim", "Metin, zamanlama, onay, yayın"],
              ["log", "Yayın Günlüğü", "İşler, hata sınıfları, yeniden deneme"],
              ["accounts", "Hesaplar", "Bağlı hesaplar ve erişim durumu"],
            ] as Array<[RouteId, string, string]>
          ).map(([route, label, hint]) => (
            <button
              key={route}
              type="button"
              onClick={() => onNavigate(route)}
              className="rounded border border-line bg-elev px-2.5 py-2 text-left hover:border-accent/60"
            >
              <span className="block text-[13px] font-medium text-fg">{label}</span>
              <span className="block text-[11px] text-muted">{hint}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Yenileme" subtitle={parsed === null ? DASH : formatRelativeTime(new Date().toISOString())}>
        <p className="text-[11px] text-muted">
          Panel veriyi açılışta bir kez çeker. Sunucu tarafında değişiklik olursa sayfayı yenileyin
          (F5) veya ilgili sayfadaki &quot;Tekrar dene&quot; düğmesini kullanın.
        </p>
      </Panel>
    </div>
  );
}