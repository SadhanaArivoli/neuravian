export const VIEWER_RUNTIME_BUILD = "2026-07-19-viewer-contract-v1";

export const VIEWER_CHANNELS = {
  readArtifact: "viewers:read-artifact",
  assertDefaultScene: "viewers:assert-default-scene",
  launch: "viewers:launch",
} as const;

export interface ReadArtifactRequest {
  workspaceId: string;
  runId: number;
  relativePath: string;
}

export interface DefaultViewerSceneRequest {
  viewerId: "neuravian-viewer" | "freeview" | "mricrogl";
  workspaceId: string;
  runId: number;
  files: Array<{
    relativePath: string;
    intendedRole: "base image" | "overlay" | "segmentation";
  }>;
}

export interface ViewerRendererApi {
  viewerRuntimeBuild: string;
  readArtifact(input: ReadArtifactRequest): Promise<Uint8Array>;
  assertDefaultViewerScene(input: DefaultViewerSceneRequest): Promise<boolean>;
}
