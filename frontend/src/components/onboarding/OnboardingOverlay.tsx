import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useOnboarding } from "../../context/OnboardingContext";

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconX() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M9.78 3.22a.75.75 0 0 1 0 1.06L6.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

// ── Flow diagram for Step 1 ───────────────────────────────────────────────────

const PIPELINE = [
  { label: "Dataset",     color: "text-blue-400",    bg: "bg-blue-500/10 border-blue-500/30" },
  { label: "Pipeline",    color: "text-violet-400",  bg: "bg-violet-500/10 border-violet-500/30" },
  { label: "Run",         color: "text-cyan-400",    bg: "bg-cyan-500/10 border-cyan-500/30" },
  { label: "Artifacts",   color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  { label: "Analysis",    color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/30" },
  { label: "Publication", color: "text-pink-400",    bg: "bg-pink-500/10 border-pink-500/30" },
];

function FlowDiagram() {
  return (
    <div className="flex flex-col items-center gap-0 my-4">
      {PIPELINE.map((step, i) => (
        <div key={step.label} className="flex flex-col items-center">
          <div className={`rounded-lg border px-5 py-2 text-sm font-semibold ${step.color} ${step.bg} min-w-[140px] text-center`}>
            {step.label}
          </div>
          {i < PIPELINE.length - 1 && (
            <div className="flex flex-col items-center my-1">
              <div className="w-px h-3 bg-white/15" />
              <svg viewBox="0 0 8 6" className="w-2 h-1.5 text-white/25" fill="currentColor">
                <path d="M0 0l4 6 4-6z" />
              </svg>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Nav items for Step 2 ─────────────────────────────────────────────────────

const NAV_ITEMS = [
  { label: "Datasets",       desc: "Register and validate BIDS dataset folders — the starting point for every analysis." },
  { label: "Pipelines",      desc: "Browse and configure neuroimaging tools: MRIQC, fMRIPrep, BrainChop, and more." },
  { label: "Runs",           desc: "Monitor every pipeline execution — logs, status, results, and full provenance." },
  { label: "Workflows",      desc: "Build reusable pipeline chains with a drag-and-drop visual editor." },
  { label: "Library",        desc: "Save, reload, and share workflow plans across sessions." },
  { label: "Remote Hosts",   desc: "Configure SSH-accessible compute nodes for GPU or HPC execution." },
];

// ── Pipeline list for Step 4 ─────────────────────────────────────────────────

const PIPELINE_LIST = [
  { name: "MRIQC",                  cat: "Quality Control",  color: "text-green-400" },
  { name: "BrainChop",              cat: "Segmentation",     color: "text-blue-400" },
  { name: "Functional Connectivity",cat: "Connectivity",     color: "text-violet-400" },
  { name: "Seed Connectivity",      cat: "Connectivity",     color: "text-violet-400" },
  { name: "Atlas ROI Extraction",   cat: "Connectivity",     color: "text-violet-400" },
  { name: "Graph Analysis",         cat: "Connectivity",     color: "text-violet-400" },
];

// ── Step definitions ──────────────────────────────────────────────────────────

interface StepDef {
  title: string;
  content: React.ReactNode;
}

function buildSteps(_completeTour: () => void, _skipTour: () => void): StepDef[] {
  return [
    // Step 1 — Philosophy
    {
      title: "How NeuroForge thinks",
      content: (
        <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
          <p>
            Most neuroimaging tools produce files. NeuroForge organises those
            files into <span className="text-white font-semibold">Artifacts</span> — typed,
            searchable outputs that know where they came from.
          </p>
          <FlowDiagram />
          <p className="text-xs text-gray-500 text-center">
            Every step in this chain is tracked automatically.
          </p>
          <p>
            You import a Dataset, run a Pipeline, get a Run with Artifacts, feed
            those Artifacts into further Analyses, and export a Methods section
            ready for publication — all without leaving NeuroForge.
          </p>
        </div>
      ),
    },

    // Step 2 — Sidebar
    {
      title: "Finding your way around",
      content: (
        <div className="space-y-3">
          <p className="text-sm text-gray-300 leading-relaxed">
            Everything lives in the sidebar. Here's what each section does:
          </p>
          <div className="space-y-2">
            {NAV_ITEMS.map((item) => (
              <div key={item.label} className="flex gap-3 rounded-md bg-surface-overlay/50 px-3 py-2">
                <span className="text-sm font-semibold text-accent min-w-[100px] shrink-0">{item.label}</span>
                <span className="text-xs text-gray-400 leading-relaxed">{item.desc}</span>
              </div>
            ))}
          </div>
        </div>
      ),
    },

    // Step 3 — Datasets
    {
      title: "Start with a dataset",
      content: (
        <div className="space-y-4 text-sm text-gray-300 leading-relaxed">
          <p>
            NeuroForge works with{" "}
            <span className="text-white font-semibold">BIDS-formatted datasets</span>.
            BIDS is the community standard for organising neuroimaging data.
          </p>
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 space-y-2">
            <p className="text-blue-300 font-semibold text-xs uppercase tracking-wide">To get started:</p>
            <ol className="list-decimal list-inside space-y-1.5 text-gray-300 text-xs leading-relaxed">
              <li>Click <span className="font-semibold text-white">Datasets</span> in the sidebar.</li>
              <li>Click <span className="font-semibold text-white">+ Import dataset</span>.</li>
              <li>Enter the full path to your BIDS folder on disk.</li>
              <li>NeuroForge validates the structure and registers it automatically.</li>
            </ol>
          </div>
          <p className="text-xs text-gray-500">
            Your files are never modified — NeuroForge reads them in place.
          </p>
        </div>
      ),
    },

    // Step 4 — Pipelines
    {
      title: "Choose a pipeline",
      content: (
        <div className="space-y-3">
          <p className="text-sm text-gray-300 leading-relaxed">
            Pipelines are wrappers around established neuroimaging tools.
            Each one produces a specific set of{" "}
            <span className="text-white font-semibold">Artifacts</span>.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {PIPELINE_LIST.map((p) => (
              <div key={p.name} className="rounded-md border border-white/8 bg-surface-overlay/50 p-2.5">
                <p className={`text-xs font-semibold ${p.color}`}>{p.name}</p>
                <p className="text-xs text-gray-600 mt-0.5">{p.cat}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            NeuroForge checks which tools are installed before letting you run.
            It never launches a tool you don't have.
          </p>
        </div>
      ),
    },

    // Step 5 — Runs
    {
      title: "Runs: everything in one place",
      content: (
        <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
          <p>
            When you launch a pipeline, NeuroForge creates a{" "}
            <span className="text-white font-semibold">Run</span>. Every run records:
          </p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Status", desc: "queued → running → success / failed" },
              { label: "Logs",   desc: "Full stdout / stderr, live-streamed" },
              { label: "Results",desc: "Inline viewers for key outputs" },
              { label: "Methods",desc: "Auto-generated methods prose" },
              { label: "Compare",desc: "Side-by-side with another run" },
              { label: "Provenance", desc: "Tool version, params, timestamps" },
            ].map((item) => (
              <div key={item.label} className="rounded-md border border-white/8 bg-surface-overlay/40 p-2.5">
                <p className="text-xs font-semibold text-accent">{item.label}</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            Runs are permanent. You can go back to any run at any time.
          </p>
        </div>
      ),
    },

    // Step 6 — Artifacts + Run Next
    {
      title: "Artifacts are first-class",
      content: (
        <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
          <p>
            Unlike file managers, NeuroForge knows what each file{" "}
            <span className="text-white font-semibold">is</span> — a connectivity
            matrix, a brain mask, a QC report. These are{" "}
            <span className="text-white font-semibold">Artifacts</span>.
          </p>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
            <p className="text-emerald-400 font-semibold text-xs uppercase tracking-wide">Run Next</p>
            <p className="text-xs text-gray-300 leading-relaxed">
              NeuroForge's defining feature. After a run completes, it shows you
              every pipeline that can consume its outputs — pre-wired and ready to
              launch in one click.
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Example: FC run → "Run Next" → Graph Analysis, already pointed at
              the right matrix file.
            </p>
          </div>
          <p className="text-xs text-gray-400">
            The Artifact Explorer lets you browse, preview, and download every
            artifact produced by a dataset's analyses.
          </p>
        </div>
      ),
    },

    // Step 7 — Workflow Builder
    {
      title: "Workflow Builder",
      content: (
        <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
          <p>
            The{" "}
            <span className="text-white font-semibold">Workflow Builder</span> lets
            you chain pipelines into a reusable plan before running anything.
          </p>
          <div className="rounded-lg border border-white/8 bg-surface-overlay/40 p-3">
            <div className="flex items-center gap-2 mb-3">
              {["Template", "Chain", "Execution"].map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                  <span className="rounded bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{s}</span>
                  {i < 2 && <span className="text-gray-600 text-xs">→</span>}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Start from a pre-built template (e.g. fMRIPrep → FC → Graph
              Analysis) or build your own chain step by step. Workflows are
              saved to the Library and can be shared as JSON.
            </p>
          </div>
          <p className="text-xs text-gray-500">
            Workflows are planning tools — you still review and confirm each step
            before it runs.
          </p>
        </div>
      ),
    },

    // Step 8 — Methods Studio
    {
      title: "Methods Studio",
      content: (
        <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
          <p>
            After running analyses, go to a dataset's{" "}
            <span className="text-white font-semibold">Methods Studio</span>.
            NeuroForge generates a complete Methods section automatically.
          </p>
          <div className="space-y-2">
            {[
              { label: "Methods prose",   desc: "Publication-ready paragraph per pipeline" },
              { label: "Citations",       desc: "BibTeX-formatted references for every tool" },
              { label: "Software table",  desc: "Tool name, version, container image" },
              { label: "Parameters",      desc: "Full parameter record per run" },
              { label: "Provenance",      desc: "Lineage from raw data to final output" },
            ].map((item) => (
              <div key={item.label} className="flex gap-3 items-start rounded-md bg-surface-overlay/50 px-3 py-2">
                <span className="text-xs font-semibold text-accent min-w-[120px] shrink-0">{item.label}</span>
                <span className="text-xs text-gray-400">{item.desc}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            Export as Markdown or copy directly into your paper.
          </p>
        </div>
      ),
    },
  ];
}

// ── Welcome screen ────────────────────────────────────────────────────────────

function WelcomeScreen({
  onGetStarted,
  onSkip,
}: {
  onGetStarted: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-8 h-full gap-6">
      {/* Logo mark */}
      <div className="flex flex-col items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-accent/20 border border-accent/30 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor" className="w-7 h-7 text-accent">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">NeuroForge</h1>
          <p className="text-sm text-gray-400 mt-1">Local-first neuroimaging research platform.</p>
        </div>
      </div>

      {/* Mission */}
      <p className="text-sm text-gray-300 max-w-sm leading-relaxed">
        Wrap established neuroimaging tools in a guided interface that runs entirely
        on your machine — no command line, no data uploads, fully reproducible.
      </p>

      {/* Primary actions */}
      <div className="flex flex-col gap-2 w-full max-w-xs">
        <button
          onClick={onGetStarted}
          className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-[#1e1e2e]"
          autoFocus
        >
          Get Started — 3 min tour
        </button>
        <Link
          to="/datasets"
          onClick={onSkip}
          className="rounded-lg border border-white/15 px-6 py-2.5 text-sm font-medium text-gray-300 hover:border-white/30 hover:text-white transition-colors text-center focus:outline-none focus:ring-2 focus:ring-white/20"
        >
          Import a Dataset
        </Link>
        <button
          onClick={onSkip}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors py-1 focus:outline-none focus:underline"
        >
          Skip tour
        </button>
      </div>

      {/* Secondary links */}
      <div className="flex items-center gap-4 text-xs text-gray-600">
        <a
          href="https://github.com/SadhanaArivoli/neuroforge"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-400 transition-colors"
        >
          GitHub
        </a>
        <span>·</span>
        <span className="text-gray-700">Docs coming soon</span>
        <span>·</span>
        <span className="text-gray-700">v0.1.0-alpha</span>
      </div>
    </div>
  );
}

// ── Finish screen ─────────────────────────────────────────────────────────────

function FinishScreen({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-8 h-full gap-6">
      <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="w-7 h-7 text-emerald-400">
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div>
        <h2 className="text-xl font-bold text-white">You're ready.</h2>
        <p className="text-sm text-gray-400 mt-1">
          Restart this tour any time from the Help menu.
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full max-w-xs">
        <Link
          to="/datasets"
          onClick={onDone}
          autoFocus
          className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover transition-colors text-center focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Import a Dataset
        </Link>
        <Link
          to="/pipelines"
          onClick={onDone}
          className="rounded-lg border border-white/15 px-6 py-2.5 text-sm font-medium text-gray-300 hover:border-white/30 hover:text-white transition-colors text-center focus:outline-none focus:ring-2 focus:ring-white/20"
        >
          Explore Pipelines
        </Link>
        <button
          onClick={onSkip}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors py-1"
        >
          Go to Home
        </button>
      </div>
    </div>
  );
}

// ── Progress dots ─────────────────────────────────────────────────────────────

function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Tour progress">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          role="tab"
          aria-selected={i === current}
          aria-label={`Step ${i + 1} of ${total}`}
          className={`rounded-full transition-all duration-300 ${
            i === current
              ? "w-4 h-1.5 bg-accent"
              : i < current
              ? "w-1.5 h-1.5 bg-accent/50"
              : "w-1.5 h-1.5 bg-white/15"
          }`}
        />
      ))}
    </div>
  );
}

// ── Main overlay ──────────────────────────────────────────────────────────────

type Screen = "welcome" | "step" | "finish";

export function OnboardingOverlay() {
  const { tourOpen, completeTour, skipTour } = useOnboarding();
  const [screen, setScreen] = useState<Screen>("welcome");
  const [stepIdx, setStepIdx] = useState(0);
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const panelRef = useRef<HTMLDivElement>(null);

  const steps = buildSteps(completeTour, skipTour);
  const totalSteps = steps.length;

  // Reset to welcome screen when tour reopens
  useEffect(() => {
    if (tourOpen) {
      setScreen("welcome");
      setStepIdx(0);
    }
  }, [tourOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!tourOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { skipTour(); return; }
      if (screen !== "step") return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); handleNext(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp")  { e.preventDefault(); handleBack(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOpen, screen, stepIdx]);

  // Focus trap — keep focus inside panel
  useEffect(() => {
    if (tourOpen && panelRef.current) {
      const firstFocusable = panelRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    }
  }, [tourOpen, screen, stepIdx]);

  function handleNext() {
    setDir("forward");
    if (stepIdx < totalSteps - 1) {
      setStepIdx((i) => i + 1);
    } else {
      setScreen("finish");
    }
  }

  function handleBack() {
    setDir("back");
    if (stepIdx > 0) {
      setStepIdx((i) => i - 1);
    } else {
      setScreen("welcome");
    }
  }

  void dir; // reserved for future slide animation

  if (!tourOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="NeuroForge onboarding tour"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={skipTour}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-surface shadow-2xl shadow-black/50 flex flex-col"
        style={{ minHeight: "480px", maxHeight: "90vh" }}
      >
        {/* Close button */}
        <button
          onClick={skipTour}
          aria-label="Close tour"
          className="absolute top-3 right-3 rounded-md p-1.5 text-gray-500 hover:text-gray-300 hover:bg-white/8 transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
        >
          <IconX />
        </button>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {screen === "welcome" && (
            <WelcomeScreen
              onGetStarted={() => { setScreen("step"); setStepIdx(0); }}
              onSkip={skipTour}
            />
          )}

          {screen === "step" && (
            <div className="px-6 py-6">
              {/* Step header */}
              <div className="mb-4">
                <span className="text-xs font-mono text-gray-600">
                  Step {stepIdx + 1} of {totalSteps}
                </span>
                <h2 className="text-base font-bold text-white mt-1">
                  {steps[stepIdx].title}
                </h2>
              </div>
              {/* Step body */}
              <div>{steps[stepIdx].content}</div>
            </div>
          )}

          {screen === "finish" && (
            <FinishScreen onDone={completeTour} onSkip={completeTour} />
          )}
        </div>

        {/* Footer nav (only for step screen) */}
        {screen === "step" && (
          <div className="border-t border-white/8 px-6 py-3 flex items-center justify-between shrink-0">
            <ProgressDots total={totalSteps} current={stepIdx} />
            <div className="flex items-center gap-2">
              <button
                onClick={handleBack}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 hover:bg-white/8 transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
              >
                <IconArrowLeft />
                Back
              </button>
              <button
                onClick={handleNext}
                className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {stepIdx < totalSteps - 1 ? "Next" : "Finish"}
                {stepIdx < totalSteps - 1 && <IconArrowRight />}
              </button>
            </div>
          </div>
        )}

        {/* Skip link (welcome + step screens) */}
        {screen !== "finish" && (
          <div className="text-center pb-3 shrink-0">
            <button
              onClick={skipTour}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors focus:outline-none focus:underline"
            >
              {screen === "welcome" ? "Already familiar? Skip" : "Skip tour"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
