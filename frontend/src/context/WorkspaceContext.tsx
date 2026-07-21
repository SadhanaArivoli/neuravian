import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type WorkspaceSelection = "local" | "all" | `cloud:${string}`;

export interface LocalWorkspace {
  id: string;
  name: "Local NeuroForge";
}

interface WorkspaceContextValue {
  selected: WorkspaceSelection;
  select: (selection: WorkspaceSelection) => void;
  local: LocalWorkspace | null;
  cloudProfiles: WorkspaceProfile[];
}

const STORAGE_KEY = "neuroforge.desktop.selectedWorkspace";
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function normalizeWorkspaceSelection(value: string | null, profiles: WorkspaceProfile[]): WorkspaceSelection {
  if (value === "all" || value === "local") return value;
  if (value?.startsWith("cloud:") && profiles.some((profile) => `cloud:${profile.id}` === value)) {
    return value as WorkspaceSelection;
  }
  return "local";
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const desktop = window.neuroforgeDesktop;
  const [selected, setSelected] = useState<WorkspaceSelection>("local");
  const [local, setLocal] = useState<LocalWorkspace | null>(null);
  const [cloudProfiles, setCloudProfiles] = useState<WorkspaceProfile[]>([]);

  useEffect(() => {
    if (!desktop) return;
    void desktop.getLocalWorkspaceIdentity().then((identity) => {
      setLocal({ id: identity.workspaceId, name: "Local NeuroForge" });
    });
    void desktop.listWorkspaces().then((profiles) => {
      setCloudProfiles(profiles);
      setSelected(normalizeWorkspaceSelection(localStorage.getItem(STORAGE_KEY), profiles));
    }).catch(() => {
      setCloudProfiles([]);
      setSelected("local");
    });
  }, [desktop]);

  const select = useCallback((selection: WorkspaceSelection) => {
    setSelected(selection);
    localStorage.setItem(STORAGE_KEY, selection);
  }, []);

  const value = useMemo(() => ({ selected, select, local, cloudProfiles }), [selected, select, local, cloudProfiles]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider.");
  return value;
}
