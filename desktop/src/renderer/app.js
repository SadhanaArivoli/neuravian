const bridge = window.neuravianDesktop;
const card = document.querySelector(".status-card");
const status = document.querySelector("#startup-status");
const detail = document.querySelector("#startup-detail");
const actions = document.querySelector("#startup-actions");
const retry = document.querySelector("#retry");
const copy = document.querySelector("#copy-diagnostics");
const openLogs = document.querySelector("#open-logs");
const openBrowser = document.querySelector("#open-browser");
const openDocker = document.querySelector("#open-docker");
const install = document.querySelector("#install-docker");
const feedback = document.querySelector("#feedback");
const failureMeta = document.querySelector("#failure-meta");

const errors = new Set(["docker-missing", "docker-stopped", "compose-missing", "port-conflict", "failed"]);

function applyStartupUpdate(update) {
  status.textContent = update.title;
  detail.textContent = update.detail;
  card.dataset.error = String(errors.has(update.state));
  card.dataset.ready = String(update.state === "ready");
  actions.hidden = !update.recoverable;
  install.hidden = !update.dockerInstallUrl;
  openBrowser.hidden = !update.browserAvailable;
  openDocker.hidden = !update.dockerRelevant;
  failureMeta.hidden = !update.recoverable;
  failureMeta.textContent = update.recoverable
    ? `Failed stage: ${update.stage ?? "startup"} · elapsed ${((update.elapsedMs ?? 0) / 1000).toFixed(1)} s`
    : "";
  feedback.textContent = "";
  void bridge?.reportStartupStateReceived(update);
}

bridge?.onStartupUpdate(applyStartupUpdate);
void bridge?.getStartupState().then(applyStartupUpdate).catch(() => {
  applyStartupUpdate({ state: "failed", title: "Startup failed", detail: "The desktop startup bridge did not respond.", stage: "renderer state query", elapsedMs: 0, recoverable: true });
});

retry?.addEventListener("click", async () => {
  retry.disabled = true;
  await bridge?.retry();
  retry.disabled = false;
});
copy?.addEventListener("click", async () => {
  await bridge?.copyDiagnostics();
  feedback.textContent = "Diagnostics copied without credentials or private home paths.";
});
openLogs?.addEventListener("click", () => bridge?.openLogs());
openBrowser?.addEventListener("click", () => bridge?.openInBrowser());
openDocker?.addEventListener("click", () => bridge?.openDockerDesktop());
install?.addEventListener("click", () => bridge?.openDockerInstall());

document.documentElement.dataset.desktopShell = "ready";
