const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(1);

function hasFlag(flagName) {
  return args.some((item) => {
    if (item === flagName) {
      return true;
    }

    if (typeof item === "string" && item.startsWith(`${flagName}=`)) {
      const value = String(item.slice(flagName.length + 1)).trim().toLowerCase();
      return value !== "0" && value !== "false" && value !== "off";
    }

    return false;
  });
}

function readArgValue(flagName, fallbackValue) {
  const equalsPrefix = `${flagName}=`;
  const equalsMatch = args.find((item) => typeof item === "string" && item.startsWith(equalsPrefix));
  if (equalsMatch) {
    return String(equalsMatch.slice(equalsPrefix.length) || fallbackValue);
  }

  const idx = args.findIndex((item) => item === flagName);
  if (idx < 0 || idx + 1 >= args.length) {
    return fallbackValue;
  }
  return String(args[idx + 1] || fallbackValue);
}

const overlayUrlArg = readArgValue("--overlay-url", "");
let clientIdFromUrl = "";
if (overlayUrlArg) {
  try {
    const parsed = new URL(overlayUrlArg);
    clientIdFromUrl = String(parsed.searchParams.get("clientId") || "").trim();
  } catch {
  }
}

const clientId = readArgValue("--client-id", clientIdFromUrl || "client");
const debugOverlayWindow = hasFlag("--overlay-debug") || hasFlag("--debug-overlay");

if (hasFlag("--debug")) {
  console.warn("[overlay] Ignoring reserved '--debug' flag. Use '--overlay-debug' instead.");
}
const userDataPath = path.join(process.cwd(), "overlay-user-data", clientId);

try {
  fs.mkdirSync(userDataPath, { recursive: true });
} catch {
}

app.setPath("userData", userDataPath);

let overlayWindow = null;
let clickThroughEnabled = null;

function setWindowClickThrough(ignore) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const next = Boolean(ignore);
  if (clickThroughEnabled === next) {
    return;
  }

  clickThroughEnabled = next;
  if (next) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
  }
}

function createWindow() {
  overlayWindow = new BrowserWindow({
    width: 900,
    height: 220,
    x: 20,
    y: 20,
    show: true,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    focusable: debugOverlayWindow,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: debugOverlayWindow ? `Stream Overlay - ${clientId}` : "Stream Overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setWindowClickThrough(true);
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.moveTop();

  const fallbackFile = path.join(__dirname, "overlay.html");
  const resolvedOverlayUrl =
    overlayUrlArg && /^https?:\/\//i.test(overlayUrlArg)
      ? overlayUrlArg
      : `http://127.0.0.1:3500/overlay?clientId=${encodeURIComponent(clientId)}`;

  overlayWindow.loadURL(resolvedOverlayUrl).catch((error) => {
    console.error(`[overlay] Failed to load remote overlay URL (${resolvedOverlayUrl}):`, error);
    overlayWindow.loadFile(fallbackFile).catch((fallbackError) => {
      console.error("[overlay] Failed to load fallback overlay file:", fallbackError);
    });
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    clickThroughEnabled = null;
  });
}

app.whenReady().then(() => {
  console.log(`[overlay] debug window mode: ${debugOverlayWindow ? "enabled" : "disabled"}`);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.on("overlay-log", (_event, payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  console.log(`[overlay] ${text}`);
});

ipcMain.on("overlay-set-click-through", (_event, payload) => {
  const ignore = typeof payload === "object" && payload !== null
    ? Boolean(payload.ignore)
    : Boolean(payload);
  setWindowClickThrough(ignore);
});
