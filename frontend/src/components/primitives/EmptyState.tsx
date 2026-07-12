import type { ReactNode } from "react";
import { useOnboarding } from "../../context/OnboardingContext";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  hint?: string;
}

function DefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8 text-gray-600">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z" />
    </svg>
  );
}

/**
 * Contextual empty state with optional hint (respects user's hint preference).
 */
export function EmptyState({ icon, title, description, action, hint }: Props) {
  const { state } = useOnboarding();

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center max-w-sm mx-auto">
      <div className="mb-4">{icon ?? <DefaultIcon />}</div>
      <p className="text-sm font-semibold text-gray-300 mb-1">{title}</p>
      {description && (
        <p className="text-xs text-gray-500 leading-relaxed mb-4">{description}</p>
      )}
      {action && <div className="mb-4">{action}</div>}
      {hint && state.hintsEnabled && (
        <p className="text-xs text-gray-600 italic mt-2 leading-relaxed">{hint}</p>
      )}
    </div>
  );
}
