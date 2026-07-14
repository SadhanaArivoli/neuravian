const bridge = window.neuroforgeDesktop;
const card = document.querySelector(".status-card");
const status = document.querySelector("#startup-status");
const detail = document.querySelector("#startup-detail");
const actions = document.querySelector("#startup-actions");
const retry = document.querySelector("#retry");
const copy = document.querySelector("#copy-diagnostics");
const install = document.querySelector("#install-docker");
const feedback = document.querySelector("#feedback");

const errors = new Set(["docker-missing", "docker-stopped", "compose-missing", "port-conflict", "failed"]);

bridge?.onStartupUpdate((update) => {
  status.textContent = update.title;
  detail.textContent = update.detail;
  card.dataset.error = String(errors.has(update.state));
  card.dataset.ready = String(update.state === "ready");
  actions.hidden = !update.recoverable;
  install.hidden = !update.dockerInstallUrl;
  feedback.textContent = "";
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
install?.addEventListener("click", () => bridge?.openDockerInstall());

document.documentElement.dataset.desktopShell = "ready";
