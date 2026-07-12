/**
 * Onboarding state persistence via localStorage.
 *
 * Versioning: bump CURRENT_VERSION when a major release warrants re-showing
 * the tour to existing users. The stored version is compared on load; if
 * stored < current the tour is shown again.
 */

export const CURRENT_VERSION = 1;

const STORAGE_KEY = "nf_onboarding";

export interface OnboardingState {
  version: number;
  completed: boolean;
  skipped: boolean;
  firstLaunch: string | null;
  completedAt: string | null;
  hintsEnabled: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  version: CURRENT_VERSION,
  completed: false,
  skipped: false,
  firstLaunch: null,
  completedAt: null,
  hintsEnabled: true,
};

export function getOnboardingState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE, firstLaunch: new Date().toISOString() };
    const stored = JSON.parse(raw) as Partial<OnboardingState>;
    // If stored version is behind current, reset completed so the tour shows again
    if ((stored.version ?? 0) < CURRENT_VERSION) {
      return {
        ...DEFAULT_STATE,
        firstLaunch: stored.firstLaunch ?? new Date().toISOString(),
        hintsEnabled: stored.hintsEnabled ?? true,
        version: CURRENT_VERSION,
      };
    }
    return { ...DEFAULT_STATE, ...stored };
  } catch {
    return { ...DEFAULT_STATE, firstLaunch: new Date().toISOString() };
  }
}

export function setOnboardingState(patch: Partial<OnboardingState>): OnboardingState {
  const current = getOnboardingState();
  const next = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors (private browsing / quota exceeded)
  }
  return next;
}

export function markCompleted(): OnboardingState {
  return setOnboardingState({ completed: true, completedAt: new Date().toISOString() });
}

export function markSkipped(): OnboardingState {
  return setOnboardingState({ skipped: true });
}

export function resetOnboarding(): OnboardingState {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return getOnboardingState();
}

export function setHintsEnabled(enabled: boolean): OnboardingState {
  return setOnboardingState({ hintsEnabled: enabled });
}

/** Returns true when the tour overlay should be shown on mount. */
export function shouldShowTour(state: OnboardingState): boolean {
  return !state.completed && !state.skipped;
}
