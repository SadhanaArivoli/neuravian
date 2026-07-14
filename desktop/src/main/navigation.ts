export const LOCAL_FRONTEND_ORIGIN = "http://127.0.0.1:3000";

export function isInternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" || url.origin === LOCAL_FRONTEND_ORIGIN;
  } catch {
    return false;
  }
}

export function shouldOpenExternally(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return ["http:", "https:"].includes(url.protocol) && !isInternalUrl(rawUrl);
  } catch {
    return false;
  }
}
