const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(1);

function readArgValue(flagName, fallbackValue) {
  const idx = args.findIndex((item) => item === flagName);
  if (idx < 0 || idx + 1 >= args.length) {
    return fallbackValue;
  }
  return String(args[idx + 1] || fallbackValue);
}

const clientId = readArgValue("--client-id", "client");
const stateFilePath = path.resolve(readArgValue("--overlay-state", path.join(process.cwd(), "overlay-state.json")));
const userDataPath = path.join(process.cwd(), "overlay-user-data", clientId);

try {
  fs.mkdirSync(userDataPath, { recursive: true });
} catch {
}

app.setPath("userData", userDataPath);

let overlayWindow = null;
let watchTimer = null;
let lastContentHash = "";

function readOverlayState() {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      streamId: null,
      playerName: "",
      team: "",
      platform: "",
      text: "",
    };
  }
}

function publishOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const payload = readOverlayState();
  const contentHash = JSON.stringify(payload);
  if (contentHash === lastContentHash) {
    return;
  }

  lastContentHash = contentHash;
  overlayWindow.webContents.send("overlay-state", payload);
}

function createWindow() {
  overlayWindow = new BrowserWindow({
    width: 900,
    height: 220,
    x: 20,
    y: 20,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");

  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayWindow.webContents.send("overlay-client-id", { clientId });
    publishOverlayState();
  });
}

function startWatcher() {
  if (watchTimer) {
    clearInterval(watchTimer);
  }

  watchTimer = setInterval(() => {
    publishOverlayState();
  }, 350);
}

app.whenReady().then(() => {
  createWindow();
  startWatcher();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.on("overlay-log", (_event, payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  console.log(`[overlay] ${text}`);
});
