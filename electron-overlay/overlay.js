const root = document.getElementById("overlay-root");
const textNode = document.getElementById("overlay-text");
const metaNode = document.getElementById("overlay-meta");

let currentClientId = "client";

function render(payload) {
  const text = String(payload?.text || "").trim();
  const team = String(payload?.team || "").trim();
  const platform = String(payload?.platform || "").trim();

  if (!text) {
    root.classList.add("hidden");
    textNode.textContent = "";
    metaNode.textContent = "";
    return;
  }

  root.classList.remove("hidden");
  textNode.textContent = text;

  const details = [team, platform, currentClientId].filter((item) => item.length > 0).join(" | ");
  metaNode.textContent = details;
}

window.overlayApi.onState((payload) => {
  render(payload || {});
});

window.overlayApi.onClientId((payload) => {
  currentClientId = String(payload?.clientId || currentClientId);
});

window.overlayApi.log("overlay renderer ready");
