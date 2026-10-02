import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

/** Yükleniyor / boş / hata — HER veri alanı için üçü de var. Boş liste ≠ hata. */
export function Loading({ label = "Yükleniyor…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-6 text-[13px] text-muted" role="status" aria-live="polite">
      <span className="sp-live inline-block h-2 w-2 rounded-full bg-info" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-line px-3 py-8 text-center">
      <p className="text-[13px] text-fg">{title}</p>
      {hint === undefined ? null : <p className="mt-1 text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

/** Hata kutusu: teknik mesajı gösterir, çözüm yolunu önerir, yeniden dener. */
export function ErrorBox({
  error,
  onRetry,
  context,
}: {
  error: unknown;
  onRetry?: () => void;
  context?: string;
}) {
  const message = errorText(error);
  const code = errorCode(error);
  return (
    <div className="rounded border border-danger/50 bg-danger/10 px-3 py-3" role="alert">
      <p className="text-[13px] font-semibold text-danger">
        {context === undefined ? "Hata" : context}
      </p>
      <p className="mt-1 text-[12px] text-fg">{message}</p>
      {code === null ? null : (
        <p className="mt-1 font-mono text-[11px] text-muted">hata kodu: {code}</p>
      )}
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-line bg-elev px-2 py-1 text-[12px] text-fg hover:border-accent/60"
        >
          Tekrar dene
        </button>
      )}
    </div>
  );
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "Bilinmeyen hata.";
}

export function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  dense = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}) {
  return (
    <section className="rounded border border-line bg-panel">
      {title === undefined && actions === undefined ? null : (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-fg">{title}</h2>
            {subtitle === undefined ? null : <p className="text-[11px] text-muted">{subtitle}</p>}
          </div>
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={dense ? "" : "p-3"}>{children}</div>
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-2">{children}</div>;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  error,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[11px] font-medium text-muted" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error === null || error === undefined ? null : (
        <span className="text-[11px] text-danger">{error}</span>
      )}
      {hint === undefined ? null : <span className="text-[11px] text-faint">{hint}</span>}
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded border border-line bg-elev px-2 py-1.5 text-[13px] text-fg placeholder:text-faint focus:border-accent";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${INPUT_CLASS} ${className}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea {...rest} className={`${INPUT_CLASS} resize-y leading-5 ${className}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select {...rest} className={`${INPUT_CLASS} ${className}`} />;
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-[#5b9dff]"
      />
      <label htmlFor={id} className="text-[12px] text-fg">
        {label}
        {hint === undefined ? null : <span className="block text-[11px] text-muted">{hint}</span>}
      </label>
    </div>
  );
}

export type ButtonVariant = "primary" | "ghost" | "danger" | "subtle";

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: "border-accent bg-accent/20 text-accent hover:bg-accent/30",
  ghost: "border-line bg-elev text-fg hover:border-accent/60",
  subtle: "border-transparent bg-transparent text-muted hover:text-fg",
  danger: "border-danger/50 bg-danger/10 text-danger hover:bg-danger/20",
};

export function Button({
  variant = "ghost",
  busy = false,
  disabled = false,
  ariaLabel,
  title,
  children,
  onClick,
  type = "button",
  className = "",
}: {
  variant?: ButtonVariant;
  busy?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={ariaLabel}
      aria-busy={busy}
      title={title}
      className={`rounded border px-2 py-1 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_CLASS[variant]} ${className}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

/** Devre dışı ama GİZLENMEYEN düğme (sunucu ucu henüz yok). Neden tooltip'te yazılı. */
export function UnavailableButton({
  label,
  reason,
  title,
}: {
  label: string;
  reason: string;
  title?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={`${reason}${title === undefined ? "" : ` — ${title}`}`}
        className="cursor-not-allowed rounded border border-line bg-elev px-2 py-1 text-[12px] text-faint"
      >
        {label}
      </button>
      <span
        className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn"
        title={reason}
      >
        501 · yakında
      </span>
      <span className="sr-only">{reason}</span>
    </span>
  );
}

/** Sekmeler — `role="tablist"` + ok tuşlarıyla gezinme. */
export function Tabs({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: Array<{ id: string; label: string; badge?: ReactNode }>;
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1 border-b border-line"
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const index = tabs.findIndex((t) => t.id === active);
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(index + delta + tabs.length) % tabs.length];
        if (next) onSelect(next.id);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium ${
              selected ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {tab.label}
            {tab.badge === undefined ? null : <span className="ml-1.5">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Onay diyaloğu: odak hapsi, Esc ile kapanır. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Vazgeç",
  variant = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded border border-line bg-panel p-4 shadow-xl"
      >
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        <div className="mt-2 text-[12px] text-fg">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={variant} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Karakter sayacı. Sınırı aşan metin KIRPILMAZ; kırmızı gösterilir. */
export function Counter({ used, max }: { used: number; max: number }) {
  const over = used > max;
  const remaining = max - used;
  const near = !over && remaining <= Math.max(1, Math.floor(max * 0.1));
  const tone = over ? "text-danger" : near ? "text-warn" : "text-muted";
  return (
    <span className={`font-mono text-[11px] ${tone}`} aria-live="polite">
      {used}/{max}
      {over ? ` · ${used - max} karakter fazla` : near ? " · sınıra yakın" : ""}
    </span>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-[11px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[12px] text-fg">{children}</dd>
    </div>
  );
}