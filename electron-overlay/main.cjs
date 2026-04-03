const { app, BrowserWindow, ipcMain, screen } = require("electron");
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

function logOverlay(text) {
  console.log(`[overlay] ${text}`);
}

function logOverlayWarn(text) {
  console.warn(`[overlay] ${text}`);
}

function logOverlayError(text, error) {
  if (error === undefined) {
    console.error(`[overlay] ${text}`);
    return;
  }
  console.error(`[overlay] ${text}`, error);
}

process.on("uncaughtException", (error) => {
  logOverlayError("uncaughtException in overlay main process", error);
});

process.on("unhandledRejection", (reason) => {
  logOverlayError("unhandledRejection in overlay main process", reason);
});

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
  logOverlay(`Creating overlay window for clientId=${clientId}`);
  const targetDisplay = screen.getPrimaryDisplay();
  const bounds = targetDisplay?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
  logOverlay(`Overlay window bounds x=${bounds.x} y=${bounds.y} width=${bounds.width} height=${bounds.height}`);

  overlayWindow = new BrowserWindow({
    width: Math.max(1, Number(bounds.width) || 1920),
    height: Math.max(1, Number(bounds.height) || 1080),
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    show: true,
    transparent: true,
    frame: false,
    resizable: false,
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

  const resolvedOverlayUrl =
    overlayUrlArg && /^https?:\/\//i.test(overlayUrlArg)
      ? overlayUrlArg
      : `http://127.0.0.1:3500/overlay?clientId=${encodeURIComponent(clientId)}`;

  const wc = overlayWindow.webContents;
  wc.on("did-start-loading", () => {
    logOverlay(`Loading overlay webpage: ${resolvedOverlayUrl}`);
  });

  wc.on("dom-ready", () => {
    logOverlay("Overlay webpage DOM ready");
  });

  wc.on("did-finish-load", () => {
    logOverlay(`Connected to webpage: ${wc.getURL()}`);
  });

  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    logOverlayError(`Webpage load failed code=${errorCode} url=${validatedURL} description=${errorDescription}`);
  });

  wc.on("javascript-dialog-opening", (event, message, defaultPrompt, type, url) => {
    event.preventDefault();
    logOverlayWarn(
      `Suppressed javascript dialog type=${String(type || "unknown")} url=${String(url || "")} message=${String(message || "")} defaultPrompt=${String(defaultPrompt || "")}`,
    );
  });

  wc.on("render-process-gone", (_event, details) => {
    logOverlayError(`Renderer process gone: reason=${String(details?.reason || "unknown")} exitCode=${String(details?.exitCode ?? "unknown")}`);
  });

  wc.on("console-message", (_event, details) => {
    const level = Number(details?.level ?? 0);
    const message = String(details?.message ?? "");
    const line = Number(details?.lineNumber ?? 0);
    const sourceId = String(details?.sourceId ?? "");

    if (message.includes("Electron Security Warning")) {
      return;
    }

    const prefix = `renderer-console level=${level} line=${line} source=${sourceId || "(unknown)"}`;
    if (level >= 2) {
      logOverlayWarn(`${prefix} ${message}`);
      return;
    }
    logOverlay(`${prefix} ${message}`);
  });

  overlayWindow.loadURL(resolvedOverlayUrl).catch((error) => {
    logOverlayError(`Failed to load remote overlay URL (${resolvedOverlayUrl})`, error);
  });

  overlayWindow.on("closed", () => {
    logOverlay("Overlay window closed");
    overlayWindow = null;
    clickThroughEnabled = null;
  });
}

app.whenReady().then(() => {
  logOverlay(`debug window mode: ${debugOverlayWindow ? "enabled" : "disabled"}`);
  logOverlay(`userData path: ${userDataPath}`);
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
  logOverlay(text);
});

ipcMain.on("overlay-set-click-through", (_event, payload) => {
  const ignore = typeof payload === "object" && payload !== null
    ? Boolean(payload.ignore)
    : Boolean(payload);
  setWindowClickThrough(ignore);
});
