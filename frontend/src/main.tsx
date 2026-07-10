import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// After a frontend rebuild, lazy-loaded chunk filenames change. If the browser
// has a stale index.html referencing the old hashes the dynamic import fails.
// Reload once per session to pick up the new index.html; the flag prevents an
// infinite reload loop if the new build itself has a broken chunk.
(function installChunkErrorRecovery() {
  const FLAG = "nf_chunk_reload";

  function handleChunkError() {
    if (!sessionStorage.getItem(FLAG)) {
      sessionStorage.setItem(FLAG, "1");
      window.location.reload();
    }
  }

  window.addEventListener("error", (event) => {
    const msg = event.message ?? "";
    if (msg.includes("Failed to fetch dynamically imported module")) {
      handleChunkError();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const msg = String((event.reason as { message?: string })?.message ?? event.reason ?? "");
    if (
      msg.includes("Failed to fetch dynamically imported module") ||
      msg.includes("ChunkLoadError")
    ) {
      handleChunkError();
    }
  });
})();

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
