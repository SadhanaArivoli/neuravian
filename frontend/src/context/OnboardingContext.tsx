import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  type OnboardingState,
  getOnboardingState,
  markCompleted,
  markSkipped,
  resetOnboarding,
  setHintsEnabled,
  shouldShowTour,
} from "../lib/onboarding";

interface OnboardingContextValue {
  state: OnboardingState;
  tourOpen: boolean;
  openTour: () => void;
  closeTour: () => void;
  completeTour: () => void;
  skipTour: () => void;
  restart: () => void;
  setHints: (enabled: boolean) => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OnboardingState>(getOnboardingState);
  const [tourOpen, setTourOpen] = useState(() => shouldShowTour(getOnboardingState()));

  // Re-sync if another tab changes localStorage
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "nf_onboarding") {
        const next = getOnboardingState();
        setState(next);
        setTourOpen(shouldShowTour(next));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const openTour = useCallback(() => setTourOpen(true), []);

  const closeTour = useCallback(() => setTourOpen(false), []);

  const completeTour = useCallback(() => {
    const next = markCompleted();
    setState(next);
    setTourOpen(false);
  }, []);

  const skipTour = useCallback(() => {
    const next = markSkipped();
    setState(next);
    setTourOpen(false);
  }, []);

  const restart = useCallback(() => {
    const next = resetOnboarding();
    setState(next);
    setTourOpen(true);
  }, []);

  const setHints = useCallback((enabled: boolean) => {
    const next = setHintsEnabled(enabled);
    setState(next);
  }, []);

  return (
    <OnboardingContext.Provider
      value={{ state, tourOpen, openTour, closeTour, completeTour, skipTour, restart, setHints }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used inside OnboardingProvider");
  return ctx;
}
