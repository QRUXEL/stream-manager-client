const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayApi", {
  onState: (handler) => {
    ipcRenderer.on("overlay-state", (_event, payload) => {
      handler(payload);
    });
  },
  onClientId: (handler) => {
    ipcRenderer.on("overlay-client-id", (_event, payload) => {
      handler(payload);
    });
  },
  log: (payload) => {
    ipcRenderer.send("overlay-log", payload);
  },
  setClickThrough: (ignore) => {
    ipcRenderer.send("overlay-set-click-through", { ignore: Boolean(ignore) });
  },
});
