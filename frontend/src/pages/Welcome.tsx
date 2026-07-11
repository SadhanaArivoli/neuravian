import { Link } from "react-router-dom";

// ── Icons ─────────────────────────────────────────────────────────────────────
// Inline SVG — no icon library dependency.

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M9 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function IconCpu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconList() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3" cy="6" r="1" />
      <circle cx="3" cy="12" r="1" />
      <circle cx="3" cy="18" r="1" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconBarChart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

// ── Compute profile badge ─────────────────────────────────────────────────────

const PROFILE_BADGE = {
  "local-ok": { label: "Local OK", className: "bg-green-900/50 text-green-300 border border-green-800" },
  "local-slow": { label: "Slow locally", className: "bg-amber-900/50 text-amber-300 border border-amber-800" },
  "local-unsafe": { label: "Cloud recommended", className: "bg-red-900/50 text-red-300 border border-red-800" },
} as const;

const CATEGORY_LABEL: Record<string, string> = {
  conversion: "Conversion",
  validation: "Validation",
  quality_control: "Quality control",
  segmentation: "Segmentation",
  preprocessing: "Preprocessing",
  deidentification: "De-identification",
  connectivity: "Connectivity",
};

// ── Static pipeline data ──────────────────────────────────────────────────────
// Mirrors the YAML manifests; if a new pipeline is added to YAML, add it here too.

const PIPELINES = [
  {
    id: "dcm2niix",
    name: "dcm2niix",
    category: "conversion",
    profile: "local-ok" as const,
    blurb: "Converts raw DICOM files to NIfTI/BIDS format in seconds.",
  },
  {
    id: "bids-validator",
    name: "BIDS Validator",
    category: "validation",
    profile: "local-ok" as const,
    blurb: "Checks whether a dataset conforms to the BIDS standard.",
  },
  {
    id: "brainchop",
    name: "BrainChop",
    category: "segmentation",
    profile: "local-ok" as const,
    blurb: "Removes skull and non-brain tissue from structural MRI in-browser.",
  },
  {
    id: "mriqc",
    name: "MRIQC",
    category: "quality_control",
    profile: "local-ok" as const,
    blurb: "Automatic image quality metrics for structural and functional MRI.",
  },
  {
    id: "fastsurfer",
    name: "FastSurfer",
    category: "segmentation",
    profile: "local-slow" as const,
    blurb: "CNN-based whole-brain segmentation and cortical surface reconstruction.",
  },
  {
    id: "fmriprep",
    name: "fMRIPrep",
    category: "preprocessing",
    profile: "local-unsafe" as const,
    blurb: "Robust fMRI preprocessing: motion correction, normalization, and more.",
  },
  {
    id: "pydeface",
    name: "pydeface",
    category: "deidentification",
    profile: "local-unsafe" as const,
    blurb: "Removes facial features from T1w images to protect participant identity.",
  },
  {
    id: "functional-connectivity",
    name: "Functional Connectivity",
    category: "connectivity",
    profile: "local-ok" as const,
    blurb: "Computes atlas-based Pearson connectivity matrices from fMRIPrep outputs.",
  },
] as const;

// ── Workflow steps ────────────────────────────────────────────────────────────

const WORKFLOW_STEPS = [
  { icon: <IconFolder />, label: "Import Data" },
  { icon: <IconList />, label: "Choose Pipeline" },
  { icon: <IconSliders />, label: "Configure" },
  { icon: <IconPlay />, label: "Run" },
  { icon: <IconBarChart />, label: "Visualize" },
] as const;

// ── Why cards ─────────────────────────────────────────────────────────────────

const WHY_CARDS = [
  {
    icon: <IconTerminal />,
    title: "No command line required",
    body: "Configure, launch, and monitor neuroimaging tools through a guided interface — no shell expertise needed.",
  },
  {
    icon: <IconLock />,
    title: "Your data stays local",
    body: "NeuroForge runs entirely on your machine. No data is uploaded, logged, or shared externally.",
  },
  {
    icon: <IconLayers />,
    title: "Seven tools, one interface",
    body: "Switch between conversion, QC, segmentation, and preprocessing without changing tools or learning new CLIs.",
  },
  {
    icon: <IconCheck />,
    title: "Empirically tested profiles",
    body: "Compute profiles reflect real benchmark results on Apple Silicon — not marketing estimates.",
  },
] as const;

// ── Section heading ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-6">
      {children}
    </p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Welcome() {
  return (
    <div className="min-h-full">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 pt-12 sm:pt-20 pb-10 sm:pb-16 border-b border-white/5">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-4 sm:mb-5">
            <span className="inline-block w-1.5 h-5 rounded-full bg-accent" />
            <span className="text-xs font-mono text-gray-500 tracking-wider">v0.1.0-alpha</span>
          </div>
          <h1 className="text-xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-white mb-3 sm:mb-4 leading-snug overflow-hidden">
            Neuroimaging pipelines
            <br />
            <span className="text-accent">without the command line.</span>
          </h1>
          <p className="text-base sm:text-lg text-gray-400 mb-6 sm:mb-8 max-w-xl">
            NeuroForge wraps established neuroimaging tools — FSL, FreeSurfer,
            fMRIPrep, and more — in a guided interface that runs entirely on
            your machine.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <Link
              to="/pipelines"
              className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface"
            >
              Get Started →
            </Link>
            <Link
              to="/datasets"
              className="rounded-md border border-white/15 px-5 py-2.5 text-sm font-medium text-gray-300 hover:border-white/30 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-surface"
            >
              Import a Dataset
            </Link>
          </div>
          <div className="mt-6 sm:mt-8 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-600 font-mono">
            <span>12 pipelines</span>
            <span className="text-gray-700">·</span>
            <span>3 compute profiles</span>
            <span className="text-gray-700">·</span>
            <span>100% local</span>
            <span className="text-gray-700">·</span>
            <span>Apache 2.0</span>
          </div>
        </div>
      </section>

      {/* ── Value cards ───────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 py-10 sm:py-14 border-b border-white/5">
        <SectionHeading>Why NeuroForge</SectionHeading>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl">
          {[
            {
              icon: <IconShield />,
              title: "Self-Hosted",
              body: "Your data never leaves your machine. No cloud accounts, no upload prompts.",
            },
            {
              icon: <IconClipboard />,
              title: "Reproducible",
              body: "Every run logs tool versions, parameters, inputs, and outputs automatically.",
            },
            {
              icon: <IconCpu />,
              title: "Hardware-Aware",
              body: "Compute profiles tell you what will run on your hardware before you start.",
            },
          ].map(({ icon, title, body }) => (
            <div
              key={title}
              className="rounded-lg border border-white/8 bg-surface-raised p-5"
            >
              <div className="text-accent mb-3">{icon}</div>
              <h3 className="text-sm font-semibold text-gray-100 mb-1.5">{title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 py-10 sm:py-14 border-b border-white/5">
        <SectionHeading>How it works</SectionHeading>
        <div className="flex items-start gap-0 max-w-3xl overflow-x-auto pb-2">
          {WORKFLOW_STEPS.map((step, i) => (
            <div key={step.label} className="flex items-start shrink-0">
              <div className="flex flex-col items-center gap-2 w-28">
                <div className="w-12 h-12 rounded-xl bg-surface-raised border border-white/8 flex items-center justify-center text-accent shrink-0">
                  {step.icon}
                </div>
                <span className="text-xs text-gray-400 text-center leading-snug px-1">
                  {step.label}
                </span>
              </div>
              {i < WORKFLOW_STEPS.length - 1 && (
                <div className="flex items-center mt-5 shrink-0 w-8">
                  <div className="flex-1 h-px bg-white/10" />
                  <svg viewBox="0 0 6 10" className="w-1.5 h-2.5 text-gray-600 shrink-0" fill="currentColor">
                    <path d="M0 0l6 5-6 5V0z" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Pipeline grid ─────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 py-10 sm:py-14 border-b border-white/5" id="pipelines">
        <SectionHeading>Included Pipelines</SectionHeading>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 max-w-5xl">
          {PIPELINES.map((p) => {
            const badge = PROFILE_BADGE[p.profile];
            return (
              <div
                key={p.id}
                className="rounded-lg border border-white/8 bg-surface-raised p-4 flex flex-col gap-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-100 leading-tight">
                    {p.name}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
                <span className="text-xs text-gray-500 uppercase tracking-wider">
                  {CATEGORY_LABEL[p.category] ?? p.category}
                </span>
                <p className="text-xs text-gray-400 leading-relaxed">{p.blurb}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-6">
          <Link
            to="/pipelines"
            className="text-sm text-accent hover:text-accent-hover transition-colors"
          >
            Configure and run a pipeline →
          </Link>
        </div>
      </section>

      {/* ── Why NeuroForge ────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 py-10 sm:py-14 border-b border-white/5">
        <SectionHeading>What makes it different</SectionHeading>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
          {WHY_CARDS.map(({ icon, title, body }) => (
            <div
              key={title}
              className="rounded-lg border border-white/8 bg-surface-raised p-5"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-accent shrink-0">{icon}</span>
                <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
              </div>
              <p className="text-sm text-gray-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Hardware compatibility ────────────────────────────────────────── */}
      <section className="px-4 sm:px-8 py-10 sm:py-14 border-b border-white/5">
        <SectionHeading>Hardware compatibility</SectionHeading>
        <p className="text-sm text-gray-400 mb-8 max-w-xl">
          Each pipeline carries a compute profile based on empirical testing,
          including Apple Silicon M-series under Docker. Know before you run.
        </p>

        {/* Profile explanations */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mb-8">
          {[
            {
              dot: "bg-green-500",
              label: "Local OK",
              className: "border-green-800/50",
              desc: "Completes in seconds to a few minutes on typical consumer hardware.",
            },
            {
              dot: "bg-amber-500",
              label: "Slow locally",
              className: "border-amber-800/50",
              desc: "May take 15–90 minutes. Works locally, but plan accordingly.",
            },
            {
              dot: "bg-red-500",
              label: "Cloud recommended",
              className: "border-red-800/50",
              desc: "Resource-intensive. Cloud or HPC is recommended for production use.",
            },
          ].map(({ dot, label, className, desc }) => (
            <div
              key={label}
              className={`rounded-lg border bg-surface-raised p-4 ${className}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                <span className="text-sm font-semibold text-gray-100">{label}</span>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>

        {/* Pipeline → profile table */}
        <div className="max-w-sm rounded-lg border border-white/8 bg-surface-raised overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/5">
            <span className="text-xs font-medium text-gray-500">Pipeline profiles at a glance</span>
          </div>
          <div className="divide-y divide-white/5">
            {PIPELINES.map((p) => {
              const badge = PROFILE_BADGE[p.profile];
              return (
                <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-gray-300">{p.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="px-4 py-2.5 border-t border-white/5">
            <p className="text-xs text-gray-600">
              Tested on Apple Silicon M-series · Docker Desktop
            </p>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="px-4 sm:px-8 py-8 sm:py-10">
        <div className="flex items-center justify-between flex-wrap gap-4 max-w-5xl">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-gray-300">NeuroForge</span>
            <span className="text-gray-700 text-sm">·</span>
            <span className="text-xs text-gray-600 font-mono">v0.1.0-alpha</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-gray-500">
            <a
              href="https://github.com/sadhana-r/neuroforge"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-gray-300 transition-colors"
            >
              <IconGitHub />
              GitHub
            </a>
            <span>Apache 2.0</span>
            <span className="text-gray-700">
              Docs coming soon
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
