import type { ReactNode } from "react";
import { useOnboarding } from "../../context/OnboardingContext";
import { WorkbenchIcons } from "../../lib/iconRegistry";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  hint?: string;
}

function DefaultIcon() {
  return <WorkbenchIcons.archive className="h-8 w-8 text-gray-500" aria-hidden="true" />;
}

/**
 * Contextual empty state with optional hint (respects user's hint preference).
 */
export function EmptyState({ icon, title, description, action, hint }: Props) {
  const { state } = useOnboarding();

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-gradient-to-b from-white/[0.035] to-transparent px-8 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-surface-overlay shadow-lg shadow-black/20">{icon ?? <DefaultIcon />}</div>
      <p className="mb-1 text-base font-semibold text-gray-200">{title}</p>
      {description && (
        <p className="mb-5 text-sm leading-relaxed text-gray-400">{description}</p>
      )}
      {action && <div className="mb-4">{action}</div>}
      {hint && state.hintsEnabled && (
        <p className="mt-2 text-xs leading-relaxed text-gray-500">{hint}</p>
      )}
    </div>
  );
}
