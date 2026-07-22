import type { ButtonHTMLAttributes, FormEvent, ReactNode } from "react";

// ── Page layout ────────────────────────────────────────────────────────────────

export function Page({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-7xl p-6 lg:p-8 ${className}`}>{children}</div>;
}

export function PageHeader({
  eyebrow, title, subtitle, children,
}: {
  eyebrow?: string; title: string; subtitle?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
        )}
        <h1 className="mt-1 text-2xl font-bold text-white">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-gray-400">{subtitle}</div>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}

// ── Data display ───────────────────────────────────────────────────────────────

export function MetricCard({
  label, value, detail,
}: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-surface-raised p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-white">{value}</p>
      {detail && <p className="mt-1 text-xs text-gray-500">{detail}</p>}
    </div>
  );
}

export type BadgeTone = "slate" | "cloud" | "success" | "warning" | "danger";

export function Badge({
  children, tone = "slate",
}: { children: ReactNode; tone?: BadgeTone }) {
  const style: Record<BadgeTone, string> = {
    slate: "border-white/10 bg-white/5 text-gray-300",
    cloud: "border-accent/20 bg-accent/10 text-accent",
    success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    warning: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    danger: "border-red-400/20 bg-red-400/10 text-red-300",
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${style[tone]}`}>
      {children}
    </span>
  );
}

// ── Buttons ────────────────────────────────────────────────────────────────────

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function PrimaryButton({ children, ...props }: BtnProps) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-gray-950 transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent/60 focus:ring-offset-2 focus:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, ...props }: BtnProps) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-white/10 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/25 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function DangerButton({ children, ...props }: BtnProps) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-red-400/25 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-400/5 hover:text-red-200 focus:outline-none focus:ring-2 focus:ring-red-400/30 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// ── Banners ────────────────────────────────────────────────────────────────────

export type BannerTone = "info" | "success" | "warning" | "danger";

const BANNER_CLS: Record<BannerTone, string> = {
  info: "border-accent/20 bg-accent/5 text-accent",
  success: "border-emerald-400/20 bg-emerald-400/5 text-emerald-200",
  warning: "border-amber-400/20 bg-amber-400/5 text-amber-200",
  danger: "border-red-400/20 bg-red-400/5 text-red-300",
};

export function InfoBanner({
  tone = "info", title, children, actions,
}: {
  tone?: BannerTone; title?: string; children: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-4 ${BANNER_CLS[tone]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {title && <p className="text-sm font-semibold">{title}</p>}
          <div className={`text-xs ${title ? "mt-1" : ""} text-current/80`}>{children}</div>
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ── States ─────────────────────────────────────────────────────────────────────

export function EmptyState({
  title, subtitle, action,
}: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 p-10 text-center">
      <p className="text-sm font-medium text-gray-400">{title}</p>
      {subtitle && <p className="mt-1 text-xs text-gray-600">{subtitle}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 py-16">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      <p className="text-sm text-gray-400">{label}</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  title = "We couldn't load this section",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 p-6 text-center">
      <p className="text-sm font-semibold text-red-300">{title}</p>
      <p className="mt-1 text-xs text-gray-400">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 rounded text-xs text-accent hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent/50">
          Retry
        </button>
      )}
    </div>
  );
}

// ── Form helpers ───────────────────────────────────────────────────────────────

export function FormField({
  label, error, children, hint,
}: { label: string; error?: string | null; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-gray-400">
      {label}
      <div className="mt-1">{children}</div>
      {hint && !error && <p className="mt-1 text-[10px] text-gray-600">{hint}</p>}
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </label>
  );
}

const INPUT_CLS = "w-full rounded border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-accent/50 focus:outline-none";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={INPUT_CLS} />;
}

export function SelectInput(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode },
) {
  return (
    <select {...props} className={INPUT_CLS}>
      {props.children}
    </select>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────────

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/8 bg-surface-raised p-5 ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Section divider ────────────────────────────────────────────────────────────

export function SectionDivider({ label }: { label?: string }) {
  if (!label) return <hr className="border-white/8" />;
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-white/8" />
      <span className="text-[10px] uppercase tracking-widest text-gray-600">{label}</span>
      <div className="h-px flex-1 bg-white/8" />
    </div>
  );
}

// ── Drawer (slide-in panel) ────────────────────────────────────────────────────

export function Drawer({
  title, subtitle, onClose, children, width = "max-w-2xl",
}: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-label={title}
    >
      <div className={`h-full w-full ${width} overflow-y-auto border-l border-white/10 bg-surface shadow-2xl`}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-white/8 bg-surface px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-white/10 px-3 py-1 text-sm text-gray-300 transition-colors hover:text-white"
          >
            Close
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

export function TabBar<T extends string>({
  tabs, active, onChange,
}: { tabs: readonly T[]; active: T; onChange: (tab: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-white/8">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`px-3 py-2 text-xs capitalize transition-colors ${
            active === tab
              ? "border-b-2 border-accent text-accent"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

// ── Confirm dialog (inline) ────────────────────────────────────────────────────

export function ConfirmAction({
  label, confirmLabel = "Confirm", tone = "danger", onConfirm,
}: {
  label: string; confirmLabel?: string; tone?: "danger" | "warning"; onConfirm: () => void | Promise<void>;
}) {
  const colorClass = tone === "danger" ? "text-red-300 border-red-400/20 hover:text-red-200" : "text-amber-300 border-amber-400/20 hover:text-amber-200";
  return (
    <div className="flex items-center gap-3">
      <p className="text-xs text-gray-400">{label}</p>
      <button
        onClick={() => void onConfirm()}
        className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${colorClass}`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

// ── Form ────────────────────────────────────────────────────────────────────────

export function Form({
  onSubmit, children, className = "",
}: { onSubmit: (e: FormEvent) => void; children: ReactNode; className?: string }) {
  return (
    <form onSubmit={onSubmit} className={className}>
      {children}
    </form>
  );
}
