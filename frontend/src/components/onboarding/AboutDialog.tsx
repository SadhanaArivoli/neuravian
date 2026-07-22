import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

interface AboutInfo {
  app_name: string;
  version: string;
  backend_version: string;
  frontend_version: string;
  git_commit: string;
  python_version: string;
  platform: string;
  license: string;
  github: string;
}

async function fetchAbout(): Promise<AboutInfo> {
  const r = await fetch("/api/about");
  if (!r.ok) throw new Error("Version details are temporarily unavailable.");
  return r.json() as Promise<AboutInfo>;
}

function Row({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs text-gray-500 min-w-[140px] shrink-0">{label}</span>
      <span className="text-xs text-gray-300 font-mono break-all">{value ?? "—"}</span>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function AboutDialog({ onClose }: Props) {
  const { data, isLoading, isError, refetch } = useQuery<AboutInfo>({
    queryKey: ["about"],
    queryFn: fetchAbout,
    staleTime: 60_000,
  });

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="About Neuravian"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-surface shadow-2xl shadow-black/50 p-6"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-accent">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Neuravian</h2>
            <p className="text-xs text-gray-500">Local-first neuroimaging research platform</p>
          </div>
        </div>

        {isLoading ? (
          <p className="text-xs text-gray-500 animate-pulse py-4 text-center">Loading…</p>
        ) : isError ? (
          <div className="mb-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-center">
            <p className="text-xs text-amber-200">Version details are temporarily unavailable.</p>
            <button onClick={() => void refetch()} className="mt-2 text-xs font-medium text-accent hover:underline">Retry</button>
          </div>
        ) : (
          <div className="rounded-lg border border-white/8 bg-surface-raised px-3 py-1 mb-5">
            <Row label="Version"          value={data?.version} />
            <Row label="Git commit"       value={data?.git_commit} />
            <Row label="Frontend"         value={data?.frontend_version} />
            <Row label="Backend"          value={data?.backend_version} />
            <Row label="Python"           value={data?.python_version} />
            <Row label="Platform"         value={data?.platform} />
            <Row label="License"          value={data?.license} />
          </div>
        )}

        <div className="flex items-center justify-between">
          <a
            href="https://github.com/SadhanaArivoli/neuravian"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:text-accent-hover transition-colors flex items-center gap-1"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
          <button
            onClick={onClose}
            className="rounded-md bg-surface-overlay px-4 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-surface-overlay/80 transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
