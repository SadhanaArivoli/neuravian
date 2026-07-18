/// <reference types="vite/client" />

interface NeuroForgeDesktopBridge {
  detectViewers(): Promise<Array<{
    viewerId: "freeview" | "mricrogl";
    displayName: string;
    installed: boolean;
    executable: string | null;
    reason: string | null;
  }>>;
  syncRun(runId: number): Promise<{ runId: number; downloaded: string[]; reused: string[] }>;
  launchViewer(request: {
    viewerId: "freeview" | "mricrogl";
    runId: number;
    files: Array<{ relativePath: string; overlay?: boolean }>;
    opacity?: number;
    freesurferLut?: boolean;
  }): Promise<boolean>;
}

interface Window {
  neuroforgeDesktop?: NeuroForgeDesktopBridge;
}
