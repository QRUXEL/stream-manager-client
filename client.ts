import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { join } from "node:path";

type StreamConfig = {
  id: string;
  name: string;
  url: string;
  extraArgs: string;
  team?: string;
  shortName?: string;
  playerName?: string;
  platform?: string;
  sourceSheetId?: string;
  sourceUrl?: string;
  playbackUrl?: string;
};

type ToggleValue<T> = {
  enabled: boolean;
  value: T;
};

type HlsGlobalSettings = {
  liveStartIndex: ToggleValue<number>;
  preferXStart: ToggleValue<boolean>;
  httpPersistent: ToggleValue<boolean>;
  maxReload: ToggleValue<number>;
  allowedExtensions: ToggleValue<string>;
};

type GlobalFfplaySettings = {
  lowLatency: ToggleValue<boolean>;
  loop: ToggleValue<boolean>;
  volume: ToggleValue<number>;
  logLevel: ToggleValue<"quiet" | "panic" | "fatal" | "error" | "warning" | "info" | "verbose" | "debug" | "trace">;
  alwaysOnTop: ToggleValue<boolean>;
  fullScreen: ToggleValue<boolean>;
  mute: ToggleValue<boolean>;
  rtspTransportTcp: ToggleValue<boolean>;
  syncMode: ToggleValue<"audio" | "video" | "ext">;
  hls: HlsGlobalSettings;
};

type ClientSettings = {
  playEnabled: boolean;
  screenIndex: number;
  screenWidth: number;
  windowX: number;
  windowY: number;
  showStats: boolean;
  fastDecode: boolean;
  genPts: boolean;
  extraArgs: string;
  playerBackend: "ffplay" | "gstreamer" | "mpv";
};

type RuntimeConfig = {
  stream: StreamConfig | null;
  globalFfplaySettings: GlobalFfplaySettings;
  clientSettings: ClientSettings;
  streamLatencyOffsetMs: number;
  serverPauseEnabled: boolean;
  serverPauseMessage: string;
};

const configuredServerUrl = Bun.env.SERVER_URL;
const clientId = Bun.env.CLIENT_ID || Bun.env.COMPUTERNAME || `client-${crypto.randomUUID().slice(0, 8)}`;
const clientName = Bun.env.CLIENT_NAME || clientId;
const clientDir = import.meta.dir;
const ffplayPath = join(clientDir, "ffplay.exe");
const gstreamerPath = String(Bun.env.GSTREAMER_PATH || "").trim() || "gst-play-1.0";
const gstreamerLaunchPath = String(Bun.env.GSTREAMER_LAUNCH_PATH || "").trim() || "gst-launch-1.0";
const gstreamerPlayerMode = String(Bun.env.GSTREAMER_PLAYER_MODE || "auto").trim().toLowerCase();
const mpvPath = String(Bun.env.MPV_PATH || "").trim() || "mpv.exe";
const persistedConfigPath = "./last-config.json";
const lockFilePath = "./client.lock";
const overlayAppDir = join(clientDir, "electron-overlay");
const overlayRestartDelayMs = 2000;
const overlayMinHealthyRunMs = 5000;
const overlayMaxConsecutiveCrashes = 5;
const overlayDebugEnabled = ["1", "true", "yes", "on"].includes(String(Bun.env.OVERLAY_DEBUG || "").trim().toLowerCase());
const exitCodeClientRestart = 90;
const exitCodeClientForceUpdate = 91;
const mdnsAddress = Bun.env.MDNS_MULTICAST_ADDRESS || "224.0.0.251";
const mdnsPort = Number(Bun.env.MDNS_PORT || "5353");
const discoveryTopic = "ffplay-admin-bun-v1";

let ws: WebSocket | null = null;
let reconnectDelayMs = 1000;
let activeProcess: ReturnType<typeof Bun.spawn> | null = null;
let desiredConfig: RuntimeConfig | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let delayedStartTimer: ReturnType<typeof setTimeout> | null = null;
let delayedStartUntilMs: number | null = null;
let overlayRestartTimer: ReturnType<typeof setTimeout> | null = null;
let lastRestartAt: string | null = null;
let currentCommandLine: string | null = null;
let lastDiscoveredServerUrl: string | null = null;
let overlayServerBaseUrl: string | null = null;
const logs: string[] = [];
const overlayLogs: string[] = [];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let lockFd: number | null = null;
let overlayProcess: ReturnType<typeof Bun.spawn> | null = null;
let overlayExpectedExit = false;
let overlayStartAtMs = 0;
let overlayConsecutiveCrashCount = 0;
let overlayLastRestartAt: string | null = null;
let overlayCommandLine: string | null = null;
let overlayLastCommandLine: string | null = null;
let videoTimestampText: string | null = null;
let videoTimestampUpdatedAt: string | null = null;
let appliedLatencyOffsetMs = 0;
let bufferWindowMs: number | null = null;
let bufferHeadroomMs: number | null = null;
let shuttingDown = false;
let gstreamerHelpTextCache: string | null = null;
const gstreamerExecutableAvailabilityCache = new Map<string, boolean>();
let resolvedMpvExecutablePath: string | null = null;
let mpvIpcPipePath: string | null = null;
let mpvPreviewDataUrl: string | null = null;
let mpvPreviewCapturedAt: string | null = null;
let mpvPreviewCaptureInFlight = false;
let lastMpvPreviewCaptureMs = 0;
const mpvPreviewCaptureIntervalMs = 4000;

function clearDelayedStartTimer() {
  if (delayedStartTimer) {
    clearTimeout(delayedStartTimer);
    delayedStartTimer = null;
  }
  delayedStartUntilMs = null;
}

function formatSecondsAsClock(totalSecondsRaw: number) {
  const totalSeconds = Number.isFinite(totalSecondsRaw) ? Math.max(0, totalSecondsRaw) : 0;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const millis = Math.floor((totalSeconds - wholeSeconds) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function resetVideoTimestamp() {
  videoTimestampText = null;
  videoTimestampUpdatedAt = null;
  bufferWindowMs = null;
  bufferHeadroomMs = null;
  mpvPreviewDataUrl = null;
  mpvPreviewCapturedAt = null;
}

function sendMpvIpcCommand(command: unknown[]) {
  return new Promise<boolean>((resolve) => {
    const pipePath = mpvIpcPipePath;
    if (!pipePath) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    try {
      const socket = createConnection(pipePath);
      socket.setTimeout(1500, () => {
        try {
          socket.destroy();
        } catch {
        }
        finish(false);
      });

      socket.on("error", () => {
        finish(false);
      });

      socket.on("connect", () => {
        try {
          const payload = JSON.stringify({ command }) + "\n";
          socket.write(payload, () => {
            try {
              socket.end();
            } catch {
            }
            finish(true);
          });
        } catch {
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
}

async function maybeCaptureMpvPreview() {
  if (!desiredConfig || desiredConfig.clientSettings.playerBackend !== "mpv" || !activeProcess) {
    return;
  }

  if (!mpvIpcPipePath || mpvPreviewCaptureInFlight) {
    return;
  }

  const now = Date.now();
  if (now - lastMpvPreviewCaptureMs < mpvPreviewCaptureIntervalMs) {
    return;
  }

  mpvPreviewCaptureInFlight = true;
  lastMpvPreviewCaptureMs = now;

  const tmpPath = join(clientDir, `mpv-preview-${clientId}.jpg`);
  try {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
      }
    }

    const sent = await sendMpvIpcCommand(["screenshot-to-file", tmpPath, "video"]);
    if (!sent) {
      return;
    }

    if (!existsSync(tmpPath)) {
      return;
    }

    const bytes = readFileSync(tmpPath);
    if (!bytes || bytes.length === 0) {
      return;
    }

    mpvPreviewDataUrl = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
    mpvPreviewCapturedAt = new Date().toISOString();
  } catch (error) {
    appendLog(`mpv preview capture failed: ${String(error)}`);
  } finally {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
    }
    mpvPreviewCaptureInFlight = false;
  }
}

async function writeToActivePlayerStdin(input: string) {
  if (!activeProcess) {
    return false;
  }

  const stdinStream = (activeProcess as any).stdin as WritableStream<Uint8Array> | undefined;
  if (!stdinStream || typeof (stdinStream as any).getWriter !== "function") {
    return false;
  }

  try {
    const writer = stdinStream.getWriter();
    await writer.write(textEncoder.encode(input));
    writer.releaseLock();
    return true;
  } catch (error) {
    appendLog(`Failed writing to player stdin: ${String(error)}`);
    return false;
  }
}

async function applyLiveSyncNudge(deltaMsRaw: unknown) {
  const deltaMs = Math.max(-5000, Math.min(5000, Math.round(Number(deltaMsRaw) || 0)));
  if (deltaMs === 0) {
    return false;
  }

  if (!desiredConfig) {
    return false;
  }

  if (desiredConfig.clientSettings.playerBackend === "mpv") {
    if (deltaMs > 0) {
      const paused = await sendMpvIpcCommand(["set_property", "pause", true]);
      if (!paused) {
        return false;
      }

      appendLog(`Applying live mpv sync nudge: +${deltaMs}ms pause`);
      setTimeout(() => {
        sendMpvIpcCommand(["set_property", "pause", false])
          .then((ok) => {
            if (!ok) {
              appendLog("Failed to resume mpv after sync nudge");
            }
          })
          .catch((error) => appendLog(`Failed to resume mpv after sync nudge: ${String(error)}`));
      }, deltaMs);
      return true;
    }

    const seekSeconds = Math.abs(deltaMs) / 1000;
    const seeked = await sendMpvIpcCommand(["seek", seekSeconds, "relative+exact"]);
    if (!seeked) {
      return false;
    }
    appendLog(`Applying live mpv sync nudge: ${deltaMs}ms seek forward`);
    return true;
  }

  if (desiredConfig.clientSettings.playerBackend !== "gstreamer" || deltaMs < 0) {
    return false;
  }

  const paused = await writeToActivePlayerStdin(" ");
  if (!paused) {
    return false;
  }

  appendLog(`Applying live gstreamer sync nudge: +${deltaMs}ms pause`);
  setTimeout(() => {
    writeToActivePlayerStdin(" ").catch((error) => appendLog(`Failed to resume after sync nudge: ${String(error)}`));
  }, deltaMs);
  return true;
}

function extractVideoTimestampFromFfplayLine(lineRaw: string) {
  const line = String(lineRaw || "").trim();
  if (!line) {
    return null;
  }

  const explicitTimeMatch = line.match(/\btime=(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\b/i);
  if (explicitTimeMatch?.[1]) {
    return explicitTimeMatch[1];
  }

  const ffplayStatsClockMatch = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s+M-V:/i);
  if (ffplayStatsClockMatch?.[1]) {
    return formatSecondsAsClock(Number(ffplayStatsClockMatch[1]));
  }

  const genericClockMatch = line.match(/\b(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\b/);
  if (genericClockMatch?.[1]) {
    return genericClockMatch[1];
  }

  return null;
}

function updateVideoTimestampFromFfplayLine(lineRaw: string) {
  const extracted = extractVideoTimestampFromFfplayLine(lineRaw);
  if (!extracted) {
    return;
  }

  videoTimestampText = extracted;
  videoTimestampUpdatedAt = new Date().toISOString();
}

function appendLog(line: string) {
  const clean = line.trim();
  if (!clean) {
    return;
  }

  const stamped = `[${new Date().toISOString()}] ${clean}`;
  logs.push(stamped);
  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }

  console.log(stamped);
}

function appendOverlayLog(line: string) {
  const clean = line.trim();
  if (!clean) {
    return;
  }

  const stamped = `[${new Date().toISOString()}] ${clean}`;
  logs.push(stamped);
  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }

  overlayLogs.push(stamped);
  if (overlayLogs.length > 500) {
    overlayLogs.splice(0, overlayLogs.length - 500);
  }

  console.log(stamped);
}

function splitArgs(input: string) {
  const result: string[] = [];
  const regex = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    result.push(match[1] ?? match[2]);
  }

  return result;
}

function quoteArg(arg: string) {
  if (/^[A-Za-z0-9_\-.:/\\]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function buildCommandLine(executable: string, args: string[]) {
  return [quoteArg(executable), ...args.map((arg) => quoteArg(arg))].join(" ");
}

function isPidRunning(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseSingleInstanceLock() {
  if (lockFd !== null) {
    try {
      closeSync(lockFd);
    } catch {
    }
    lockFd = null;
  }

  try {
    unlinkSync(lockFilePath);
  } catch {
  }
}

function findElectronExecutable() {
  const configured = String(Bun.env.ELECTRON_PATH || "").trim();
  const candidates = [
    configured,
    join(clientDir, "node_modules", ".bin", "electron.cmd"),
    join(clientDir, "node_modules", ".bin", "electron.exe"),
    join(clientDir, "node_modules", ".bin", "electron"),
  ].filter((item) => item.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildOverlayServerBaseUrl(wsUrl: string) {
  try {
    const parsed = new URL(wsUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function stopOverlayApp() {
  if (overlayRestartTimer) {
    clearTimeout(overlayRestartTimer);
    overlayRestartTimer = null;
  }

  if (!overlayProcess) {
    overlayCommandLine = null;
    return;
  }

  try {
    overlayExpectedExit = true;
    overlayProcess.kill();
  } catch (error) {
    appendOverlayLog(`Error while stopping overlay app: ${String(error)}`);
  }

  overlayProcess = null;
  overlayServerBaseUrl = null;
  overlayCommandLine = null;
}

function startOverlayApp(serverBaseUrl: string) {
  if (shuttingDown) {
    return;
  }

  const normalizedBaseUrl = String(serverBaseUrl || "").trim();
  if (!normalizedBaseUrl) {
    appendOverlayLog("Overlay URL is empty; skipping overlay start");
    return;
  }

  if (overlayProcess) {
    if (overlayServerBaseUrl === normalizedBaseUrl) {
      return;
    }

    appendOverlayLog(`Overlay target changed to ${normalizedBaseUrl}; restarting overlay app`);
    stopOverlayApp();
  }

  const electronPath = findElectronExecutable();
  if (!electronPath) {
    appendOverlayLog("Electron executable not found. Overlay app is disabled.");
    return;
  }

  const mainScriptPath = join(overlayAppDir, "main.cjs");
  const packageJsonPath = join(overlayAppDir, "package.json");
  if (!existsSync(mainScriptPath) || !existsSync(packageJsonPath)) {
    appendOverlayLog(`Overlay app not found at ${overlayAppDir}`);
    return;
  }

  const overlayUrl = `${normalizedBaseUrl}/overlay?clientId=${encodeURIComponent(clientId)}`;
  const overlayArgs = [
    overlayAppDir,
    "--overlay-url",
    overlayUrl,
  ];

  if (overlayDebugEnabled) {
    overlayArgs.push("--overlay-debug");
  }

  const command = electronPath.toLowerCase().endsWith(".cmd")
    ? ["cmd.exe", "/c", electronPath, ...overlayArgs]
    : [electronPath, ...overlayArgs];

  appendOverlayLog(`Starting overlay app: ${command.join(" ")}`);
  overlayCommandLine = command.join(" ");
  overlayLastCommandLine = overlayCommandLine;
  overlayExpectedExit = false;
  overlayStartAtMs = Date.now();
  const processRef = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    onExit(_, exitCode, signalCode, error) {
      const runtimeMs = Math.max(0, Date.now() - overlayStartAtMs);
      const expectedExit = overlayExpectedExit || shuttingDown;

      if (expectedExit) {
        appendOverlayLog(`Overlay app stopped (code=${exitCode}, signal=${signalCode})`);
        return;
      }

      const isCrash = exitCode !== 0;
      if (isCrash) {
        if (runtimeMs < overlayMinHealthyRunMs) {
          overlayConsecutiveCrashCount += 1;
        } else {
          overlayConsecutiveCrashCount = 1;
        }
      } else {
        overlayConsecutiveCrashCount = 0;
      }

      appendOverlayLog(
        `Overlay app exited unexpectedly (code=${exitCode}, signal=${signalCode}, error=${String(error || "none")}, runtimeMs=${runtimeMs}, crashCount=${overlayConsecutiveCrashCount})`,
      );
    },
  });

  overlayProcess = processRef;
  overlayServerBaseUrl = normalizedBaseUrl;
  overlayLastRestartAt = new Date().toISOString();
  pipeStreamToLogs(processRef.stdout, "overlay-out", appendOverlayLog).catch((error) =>
    appendOverlayLog(`overlay stdout pipe error: ${String(error)}`),
  );
  pipeStreamToLogs(processRef.stderr, "overlay-err", appendOverlayLog).catch((error) =>
    appendOverlayLog(`overlay stderr pipe error: ${String(error)}`),
  );

  processRef.exited.then(() => {
    const expectedExit = overlayExpectedExit || shuttingDown;
    if (overlayProcess !== processRef) {
      return;
    }

    overlayProcess = null;
    overlayExpectedExit = false;
    overlayCommandLine = null;
    if (shuttingDown) {
      return;
    }

    if (!expectedExit && overlayConsecutiveCrashCount >= overlayMaxConsecutiveCrashes) {
      appendOverlayLog(
        `Overlay app disabled after ${overlayConsecutiveCrashCount} consecutive startup crashes. Fix Electron overlay and restart client to retry.`,
      );
      return;
    }

    overlayRestartTimer = setTimeout(() => {
      overlayRestartTimer = null;
      if (overlayServerBaseUrl) {
        startOverlayApp(overlayServerBaseUrl);
      }
    }, overlayRestartDelayMs);
  });
}

function acquireSingleInstanceLock(): boolean {
  try {
    lockFd = openSync(lockFilePath, "wx");
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") {
      appendLog(`Failed to create client lock: ${String(error)}`);
      return false;
    }
  }

  try {
    const existing = JSON.parse(readFileSync(lockFilePath, "utf-8")) as { pid?: number };
    if (!isPidRunning(Number(existing.pid))) {
      unlinkSync(lockFilePath);
      lockFd = openSync(lockFilePath, "wx");
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
      appendLog("Recovered stale client lock");
      return true;
    }
  } catch {
    try {
      unlinkSync(lockFilePath);
      lockFd = openSync(lockFilePath, "wx");
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
      appendLog("Recovered invalid client lock");
      return true;
    } catch {
    }
  }

  appendLog("Another client instance is already running. Exiting this instance.");
  return false;
}

function registerShutdownHandlers() {
  process.on("exit", () => {
    shuttingDown = true;
    killFfplay();
    stopOverlayApp();
    releaseSingleInstanceLock();
  });

  process.on("SIGINT", () => {
    shuttingDown = true;
    killFfplay();
    stopOverlayApp();
    releaseSingleInstanceLock();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    shuttingDown = true;
    killFfplay();
    stopOverlayApp();
    releaseSingleInstanceLock();
    process.exit(0);
  });
}

function requestSupervisorAction(action: "restart" | "force_update") {
  appendLog(`Supervisor action requested: ${action}`);
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  clearDelayedStartTimer();

  if (overlayRestartTimer) {
    clearTimeout(overlayRestartTimer);
    overlayRestartTimer = null;
  }

  killFfplay();
  stopOverlayApp();
  releaseSingleInstanceLock();

  const code = action === "force_update" ? exitCodeClientForceUpdate : exitCodeClientRestart;
  setTimeout(() => process.exit(code), 50);
}

function normalizeRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Partial<RuntimeConfig>;
  const streamRaw = value.stream as Partial<StreamConfig> | null | undefined;
  const globalRaw = (value.globalFfplaySettings ?? {}) as Partial<GlobalFfplaySettings>;
  const clientRaw = (value.clientSettings ?? {}) as Partial<ClientSettings>;

  const stream: StreamConfig | null =
    streamRaw && typeof streamRaw === "object"
      ? {
          id: String(streamRaw.id ?? ""),
          name: String(streamRaw.name ?? "Unnamed stream"),
          url: String(streamRaw.url ?? ""),
          extraArgs: String(streamRaw.extraArgs ?? ""),
          team: String(streamRaw.team ?? ""),
          shortName: String(streamRaw.shortName ?? ""),
          playerName: String(streamRaw.playerName ?? ""),
          platform: String(streamRaw.platform ?? ""),
          sourceSheetId: String(streamRaw.sourceSheetId ?? ""),
          sourceUrl: String(streamRaw.sourceUrl ?? ""),
          playbackUrl: String(streamRaw.playbackUrl ?? ""),
        }
      : null;

  if (stream && !stream.url) {
    return null;
  }

  const volume = Number(globalRaw.volume);
  const screenIndex = Number(clientRaw.screenIndex);
  const screenWidth = Number(clientRaw.screenWidth);
  const windowX = Number(clientRaw.windowX);
  const windowY = Number(clientRaw.windowY);
  const logLevelRaw = String(globalRaw.logLevel ?? "info");
  const syncModeRaw = String(globalRaw.syncMode ?? "audio");
  const streamLatencyOffsetMsRaw = Number(value.streamLatencyOffsetMs ?? 0);
  const streamLatencyOffsetMs = Number.isFinite(streamLatencyOffsetMsRaw)
    ? Math.max(-120000, Math.min(120000, Math.round(streamLatencyOffsetMsRaw)))
    : 0;
  const serverPauseEnabled = Boolean(value.serverPauseEnabled);
  const serverPauseMessage = String(value.serverPauseMessage ?? "").trim();
  const allowedLogLevels = new Set(["quiet", "panic", "fatal", "error", "warning", "info", "verbose", "debug", "trace"]);
  const allowedSyncModes = new Set(["audio", "video", "ext"]);

  function normalizeToggleBoolean(input: unknown, fallbackValue: boolean): ToggleValue<boolean> {
    if (input && typeof input === "object" && "enabled" in (input as any)) {
      return {
        enabled: Boolean((input as any).enabled),
        value: Boolean((input as any).value),
      };
    }

    return {
      enabled: false,
      value: typeof input === "boolean" ? input : fallbackValue,
    };
  }

  function normalizeToggleNumber(input: unknown, fallbackValue: number, minValue: number, maxValue?: number): ToggleValue<number> {
    if (input && typeof input === "object" && "enabled" in (input as any)) {
      const rawValue = Number((input as any).value);
      const bounded = Number.isFinite(rawValue) ? Math.max(minValue, maxValue === undefined ? rawValue : Math.min(maxValue, rawValue)) : fallbackValue;
      return {
        enabled: Boolean((input as any).enabled),
        value: Math.round(bounded),
      };
    }

    const rawValue = Number(input);
    const bounded = Number.isFinite(rawValue) ? Math.max(minValue, maxValue === undefined ? rawValue : Math.min(maxValue, rawValue)) : fallbackValue;
    return {
      enabled: false,
      value: Math.round(bounded),
    };
  }

  function normalizeToggleEnum<T extends string>(input: unknown, allowed: Set<T>, fallbackValue: T): ToggleValue<T> {
    if (input && typeof input === "object" && "enabled" in (input as any)) {
      const rawValue = String((input as any).value);
      return {
        enabled: Boolean((input as any).enabled),
        value: allowed.has(rawValue as T) ? (rawValue as T) : fallbackValue,
      };
    }

    const rawValue = String(input ?? fallbackValue);
    return {
      enabled: false,
      value: allowed.has(rawValue as T) ? (rawValue as T) : fallbackValue,
    };
  }
  const hlsRaw = (globalRaw.hls && typeof globalRaw.hls === "object" ? globalRaw.hls : {}) as Partial<HlsGlobalSettings>;
  const liveStartIndex = hlsRaw.liveStartIndex && typeof hlsRaw.liveStartIndex === "object" ? hlsRaw.liveStartIndex : {};
  const preferXStart = hlsRaw.preferXStart && typeof hlsRaw.preferXStart === "object" ? hlsRaw.preferXStart : {};
  const httpPersistent = hlsRaw.httpPersistent && typeof hlsRaw.httpPersistent === "object" ? hlsRaw.httpPersistent : {};
  const maxReload = hlsRaw.maxReload && typeof hlsRaw.maxReload === "object" ? hlsRaw.maxReload : {};
  const allowedExtensions =
    hlsRaw.allowedExtensions && typeof hlsRaw.allowedExtensions === "object" ? hlsRaw.allowedExtensions : {};

  const liveStartIndexValue = Number((liveStartIndex as any).value);
  const maxReloadValue = Number((maxReload as any).value);

  return {
    stream,
    globalFfplaySettings: {
      lowLatency: normalizeToggleBoolean(globalRaw.lowLatency, true),
      loop: normalizeToggleBoolean(globalRaw.loop, false),
      volume: normalizeToggleNumber(globalRaw.volume, 100, 0, 200),
      logLevel: normalizeToggleEnum(globalRaw.logLevel, allowedLogLevels, "info") as ToggleValue<GlobalFfplaySettings["logLevel"]["value"]>,
      alwaysOnTop: normalizeToggleBoolean(globalRaw.alwaysOnTop, false),
      fullScreen: normalizeToggleBoolean(globalRaw.fullScreen, false),
      mute: normalizeToggleBoolean(globalRaw.mute, false),
      rtspTransportTcp: normalizeToggleBoolean(globalRaw.rtspTransportTcp, false),
      syncMode: normalizeToggleEnum(globalRaw.syncMode, allowedSyncModes, "audio") as ToggleValue<GlobalFfplaySettings["syncMode"]["value"]>,
      hls: {
        liveStartIndex: {
          enabled: Boolean((liveStartIndex as any).enabled),
          value: Number.isFinite(liveStartIndexValue) ? Math.floor(liveStartIndexValue) : -3,
        },
        preferXStart: {
          enabled: Boolean((preferXStart as any).enabled),
          value: Boolean((preferXStart as any).value),
        },
        httpPersistent: {
          enabled: Boolean((httpPersistent as any).enabled),
          value: Boolean((httpPersistent as any).value),
        },
        maxReload: {
          enabled: Boolean((maxReload as any).enabled),
          value: Number.isFinite(maxReloadValue) ? Math.max(0, Math.floor(maxReloadValue)) : 100,
        },
        allowedExtensions: {
          enabled: Boolean((allowedExtensions as any).enabled),
          value: String((allowedExtensions as any).value ?? ""),
        },
      },
    },
    clientSettings: {
      playEnabled: clientRaw.playEnabled ?? true,
      screenIndex: Number.isFinite(screenIndex) ? Math.max(0, Math.floor(screenIndex)) : 0,
      screenWidth: Number.isFinite(screenWidth) ? Math.max(320, Math.floor(screenWidth)) : 1920,
      windowX: Number.isFinite(windowX) ? Math.floor(windowX) : 0,
      windowY: Number.isFinite(windowY) ? Math.floor(windowY) : 0,
      showStats: Boolean(clientRaw.showStats),
      fastDecode: Boolean(clientRaw.fastDecode),
      genPts: Boolean(clientRaw.genPts),
      extraArgs: String(clientRaw.extraArgs ?? ""),
      playerBackend: (() => {
        const backend = String(clientRaw.playerBackend || "ffplay").trim().toLowerCase();
        if (backend === "gstreamer") {
          return "gstreamer";
        }
        if (backend === "mpv") {
          return "mpv";
        }
        return "ffplay";
      })(),
    },
    streamLatencyOffsetMs,
    serverPauseEnabled,
    serverPauseMessage,
  };
}

function saveLastConfig(config: RuntimeConfig) {
  try {
    writeFileSync(persistedConfigPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    appendLog(`Failed to persist last config: ${String(error)}`);
  }
}

function loadLastConfig(): RuntimeConfig | null {
  if (!existsSync(persistedConfigPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(persistedConfigPath, "utf-8"));
    return normalizeRuntimeConfig(parsed);
  } catch (error) {
    appendLog(`Failed to load last config: ${String(error)}`);
    return null;
  }
}

function send(type: string, payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({ type, payload }));
}

function discoverServerUrl(timeoutMs = 4000): Promise<string | null> {
  if (configuredServerUrl) {
    return Promise.resolve(configuredServerUrl);
  }

  return new Promise((resolve) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    let resolved = false;

    function done(url: string | null) {
      if (resolved) {
        return;
      }

      resolved = true;
      clearInterval(probeInterval);
      clearTimeout(timeoutTimer);
      try {
        socket.close();
      } catch {
      }
      resolve(url);
    }

    function sendProbe() {
      const probe = Buffer.from(
        JSON.stringify({
          type: "discover",
          topic: discoveryTopic,
          clientId,
          ts: new Date().toISOString(),
        }),
      );
      socket.send(probe, mdnsPort, mdnsAddress);
    }

    socket.on("error", (error) => {
      appendLog(`mDNS discovery error: ${String(error)}`);
      done(null);
    });

    socket.on("message", (buffer) => {
      let message: any;
      try {
        message = JSON.parse(buffer.toString("utf-8"));
      } catch {
        return;
      }

      if (message?.type !== "announce" || message?.topic !== discoveryTopic) {
        return;
      }

      const discoveredUrl = String(message.wsUrl || "").trim();
      if (!discoveredUrl) {
        return;
      }

      done(discoveredUrl);
    });

    const timeoutTimer = setTimeout(() => {
      done(lastDiscoveredServerUrl);
    }, timeoutMs);

    const probeInterval = setInterval(sendProbe, 1200);

    socket.bind(mdnsPort, () => {
      try {
        socket.addMembership(mdnsAddress);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
        sendProbe();
      } catch (error) {
        appendLog(`mDNS setup failed: ${String(error)}`);
        done(lastDiscoveredServerUrl);
      }
    });
  });
}

function publishHealth() {
  const nowMs = Date.now();
  const delayedStartRemainingMs = delayedStartUntilMs ? Math.max(0, delayedStartUntilMs - nowMs) : 0;
  const nextBufferWindowMs = delayedStartRemainingMs > 0
    ? delayedStartRemainingMs
    : activeProcess
      ? Math.max(0, appliedLatencyOffsetMs)
      : null;
  const nextBufferHeadroomMs = delayedStartRemainingMs > 0
    ? delayedStartRemainingMs
    : activeProcess
      ? Math.max(0, appliedLatencyOffsetMs)
      : null;

  bufferWindowMs = nextBufferWindowMs;
  bufferHeadroomMs = nextBufferHeadroomMs;

  maybeCaptureMpvPreview().catch((error) => appendLog(`mpv preview task failed: ${String(error)}`));

  send("client_health", {
    uptimeSec: Math.floor(process.uptime()),
    memoryRss: process.memoryUsage().rss,
    pid: process.pid,
    playing: Boolean(activeProcess),
    lastRestartAt,
    commandLine: currentCommandLine,
    overlayRunning: Boolean(overlayProcess),
    overlayPid: overlayProcess?.pid ?? null,
    overlayLastRestartAt,
    overlayCommandLine,
    overlayLastCommandLine,
    overlayCrashCount: overlayConsecutiveCrashCount,
    videoTimestamp: videoTimestampText,
    videoTimestampUpdatedAt,
    appliedLatencyOffsetMs,
    bufferWindowMs: nextBufferWindowMs,
    bufferHeadroomMs: nextBufferHeadroomMs,
    playerPreviewImageDataUrl: mpvPreviewDataUrl,
    playerPreviewCapturedAt: mpvPreviewCapturedAt,
  });
}

async function pipeStreamToLogs(
  stream: ReadableStream<Uint8Array> | null,
  label: string,
  logger: (line: string) => void = appendLog,
  onLine?: (line: string) => void,
) {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  let partial = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (partial) {
        logger(`${label}: ${partial}`);
      }
      break;
    }

    partial += textDecoder.decode(value, { stream: true });
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? "";

    for (const line of parts) {
      onLine?.(line);
      logger(`${label}: ${line}`);
    }
  }
}

function killFfplay() {
  clearDelayedStartTimer();

  if (!activeProcess) {
    currentCommandLine = null;
    appliedLatencyOffsetMs = 0;
    return;
  }

  appendLog("Stopping ffplay process");
  try {
    activeProcess.kill();
  } catch (error) {
    appendLog(`Error while stopping ffplay: ${String(error)}`);
  }
  activeProcess = null;
  currentCommandLine = null;
  appliedLatencyOffsetMs = 0;
  resetVideoTimestamp();
}

function spawnFfplayNow(config: RuntimeConfig) {
  const args = buildFfplayArgs(config);
  currentCommandLine = buildCommandLine(ffplayPath, args);
  appendLog(`Starting ffplay: ${ffplayPath} ${args.join(" ")}`);

  const processRef = Bun.spawn([ffplayPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    onExit(_, exitCode, signalCode, error) {
      appendLog(`ffplay exited (code=${exitCode}, signal=${signalCode}, error=${String(error || "none")})`);
    },
  });

  activeProcess = processRef;
  appliedLatencyOffsetMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  lastRestartAt = new Date().toISOString();

  pipeStreamToLogs(processRef.stdout, "stdout", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`stdout pipe error: ${String(error)}`));
  pipeStreamToLogs(processRef.stderr, "stderr", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`stderr pipe error: ${String(error)}`));

  processRef.exited.then(() => {
    if (activeProcess !== processRef) {
      return;
    }

    activeProcess = null;
    appliedLatencyOffsetMs = 0;
    resetVideoTimestamp();
    if (desiredConfig?.stream && desiredConfig.clientSettings.playEnabled && !desiredConfig.serverPauseEnabled) {
      appendLog("ffplay stopped unexpectedly; scheduling restart");
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (desiredConfig) {
          startPlayback(desiredConfig).catch((error) => appendLog(`Failed to restart playback: ${String(error)}`));
        }
      }, 1000);
    }
  });
}

function buildGstreamerArgs(config: RuntimeConfig) {
  const args: string[] = [];
  const wantsFullscreen = config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value;
  let fullscreenViaFlag = false;

  if (wantsFullscreen) {
    const fullscreenFlag = resolveGstreamerFullscreenFlag();
    if (fullscreenFlag) {
      args.push(fullscreenFlag);
      fullscreenViaFlag = true;
    }
  }

  // Interactive mode is required for key-driven fullscreen toggle fallback.
  if (!wantsFullscreen || fullscreenViaFlag) {
    args.push("--no-interactive");
  }

  if (config.stream?.url) {
    args.push(config.stream.url);
  }

  return { args, fullscreenViaFlag };
}

function getGstreamerHelpText() {
  if (gstreamerHelpTextCache !== null) {
    return gstreamerHelpTextCache;
  }

  try {
    const helpResult = Bun.spawnSync([gstreamerPath, "--help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutText = helpResult.stdout ? textDecoder.decode(helpResult.stdout).toLowerCase() : "";
    const stderrText = helpResult.stderr ? textDecoder.decode(helpResult.stderr).toLowerCase() : "";
    gstreamerHelpTextCache = `${stdoutText}\n${stderrText}`;
  } catch {
    gstreamerHelpTextCache = "";
  }

  return gstreamerHelpTextCache;
}

function resolveGstreamerFullscreenFlag() {
  const helpText = getGstreamerHelpText();
  if (!helpText) {
    return null;
  }

  if (helpText.includes("--fullscreen")) {
    return "--fullscreen";
  }

  if (helpText.includes("--full-screen")) {
    return "--full-screen";
  }

  if (helpText.match(/\s-f[,\s]/)) {
    return "-f";
  }

  return null;
}

function isPathLikeCommand(command: string) {
  return command.includes("\\") || command.includes("/");
}

function canRunGstreamerExecutable(command: string) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return false;
  }

  if (isPathLikeCommand(normalized) && !existsSync(normalized)) {
    return false;
  }

  if (gstreamerExecutableAvailabilityCache.has(normalized)) {
    return Boolean(gstreamerExecutableAvailabilityCache.get(normalized));
  }

  let available = false;
  try {
    const probe = Bun.spawnSync([normalized, "--version"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    available = probe.exitCode === 0;
  } catch {
    available = false;
  }

  gstreamerExecutableAvailabilityCache.set(normalized, available);
  return available;
}

function shouldUseGstLaunchForConfig(config: RuntimeConfig) {
  if (gstreamerPlayerMode === "gst-launch") {
    return true;
  }

  if (gstreamerPlayerMode === "gst-play") {
    return false;
  }

  const wantsFullscreen = config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value;
  if (!wantsFullscreen) {
    return false;
  }

  // When gst-play has no fullscreen flag support, gst-launch with d3d11videosink fullscreen is a better fit.
  return !Boolean(resolveGstreamerFullscreenFlag());
}

function buildGstreamerPlayArgs(config: RuntimeConfig) {
  const args: string[] = [];
  const wantsFullscreen = config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value;
  let fullscreenViaFlag = false;

  if (wantsFullscreen) {
    const fullscreenFlag = resolveGstreamerFullscreenFlag();
    if (fullscreenFlag) {
      args.push(fullscreenFlag);
      fullscreenViaFlag = true;
    }
  }

  // Interactive mode is required for key-driven fullscreen toggle fallback.
  if (!wantsFullscreen || fullscreenViaFlag) {
    args.push("--no-interactive");
  }

  if (config.stream?.url) {
    args.push(config.stream.url);
  }

  return { args, fullscreenViaFlag };
}

function buildGstreamerLaunchArgs(config: RuntimeConfig) {
  const streamUrl = String(config.stream?.url || "").trim();
  const wantsFullscreen = config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value;

  const sinkParts: string[] = ["d3d11videosink"];
  if (wantsFullscreen) {
    sinkParts.push("fullscreen=true");
  }

  const args: string[] = [
    "-e",
    "playbin",
    `uri=${streamUrl}`,
    `video-sink=${sinkParts.join(" ")}`,
  ];

  const muted = config.globalFfplaySettings.mute.enabled && config.globalFfplaySettings.mute.value;
  if (muted) {
    args.push("audio-sink=fakesink");
  } else {
    args.push("audio-sink=autoaudiosink");

    if (config.globalFfplaySettings.volume.enabled) {
      const volumePercent = Math.max(0, Math.min(200, Math.round(config.globalFfplaySettings.volume.value ?? 100)));
      const gstVolume = Math.max(0, Math.min(2, volumePercent / 100));
      args.push(`volume=${gstVolume.toFixed(3)}`);
    }
  }

  return { args, fullscreenViaFlag: wantsFullscreen };
}

function spawnGstreamerNow(config: RuntimeConfig) {
  const preferLaunch = shouldUseGstLaunchForConfig(config);
  const canRunPlay = canRunGstreamerExecutable(gstreamerPath);
  const canRunLaunch = canRunGstreamerExecutable(gstreamerLaunchPath);

  let executable = gstreamerPath;
  let plan = buildGstreamerPlayArgs(config);

  if (preferLaunch && canRunLaunch) {
    executable = gstreamerLaunchPath;
    plan = buildGstreamerLaunchArgs(config);
    appendLog("Using gst-launch for gstreamer playback");
  } else if (!preferLaunch && canRunPlay) {
    executable = gstreamerPath;
    plan = buildGstreamerPlayArgs(config);
  } else if (canRunPlay) {
    executable = gstreamerPath;
    plan = buildGstreamerPlayArgs(config);
    appendLog("Requested gst-launch mode is unavailable; using gst-play fallback");
  } else if (canRunLaunch) {
    executable = gstreamerLaunchPath;
    plan = buildGstreamerLaunchArgs(config);
    appendLog("gst-play is unavailable; using gst-launch fallback");
  } else {
    throw new Error(`No runnable gstreamer executable found (tried ${gstreamerPath} and ${gstreamerLaunchPath})`);
  }

  const { args, fullscreenViaFlag } = plan;
  currentCommandLine = buildCommandLine(executable, args);
  appendLog(`Starting gstreamer: ${executable} ${args.join(" ")}`);

  const processRef = Bun.spawn([executable, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    onExit(_, exitCode, signalCode, error) {
      appendLog(`gstreamer exited (code=${exitCode}, signal=${signalCode}, error=${String(error || "none")})`);
    },
  });

  activeProcess = processRef;
  appliedLatencyOffsetMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  lastRestartAt = new Date().toISOString();

  pipeStreamToLogs(processRef.stdout, "gst-stdout", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`gstreamer stdout pipe error: ${String(error)}`));
  pipeStreamToLogs(processRef.stderr, "gst-stderr", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`gstreamer stderr pipe error: ${String(error)}`));

  if (executable === gstreamerPath && config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value && !fullscreenViaFlag) {
    appendLog("GStreamer fullscreen flag is unavailable; attempting fullscreen toggle via stdin keypress (interactive mode)");
    setTimeout(() => {
      if (activeProcess !== processRef) {
        return;
      }
      writeToActivePlayerStdin("f").catch((error) => appendLog(`Failed to send fullscreen toggle to gstreamer: ${String(error)}`));
    }, 1200);
  }

  processRef.exited.then(() => {
    if (activeProcess !== processRef) {
      return;
    }

    activeProcess = null;
    appliedLatencyOffsetMs = 0;
    resetVideoTimestamp();
    if (desiredConfig?.stream && desiredConfig.clientSettings.playEnabled && !desiredConfig.serverPauseEnabled) {
      appendLog("gstreamer stopped unexpectedly; scheduling restart");
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (desiredConfig) {
          startPlayback(desiredConfig).catch((error) => appendLog(`Failed to restart playback: ${String(error)}`));
        }
      }, 1000);
    }
  });
}

function buildFfplayArgs(config: RuntimeConfig) {
  const args: string[] = [
    "-hide_banner",
    "-window_title",
    `ffplay-${clientId}`,
  ];

  if (config.globalFfplaySettings.logLevel.enabled) {
    args.push("-loglevel", config.globalFfplaySettings.logLevel.value);
  }

  const screenIndex = Math.max(0, Math.floor(config.clientSettings.screenIndex || 0));
  const screenWidth = Math.max(320, Math.floor(config.clientSettings.screenWidth || 1920));
  const windowX = Number.isFinite(config.clientSettings.windowX)
    ? Math.floor(config.clientSettings.windowX)
    : screenIndex * screenWidth;
  const windowY = Number.isFinite(config.clientSettings.windowY) ? Math.floor(config.clientSettings.windowY) : 0;

  args.push("-left", String(windowX));
  args.push("-top", String(windowY));

  if (config.globalFfplaySettings.lowLatency.enabled && config.globalFfplaySettings.lowLatency.value) {
    args.push("-fflags", "nobuffer", "-flags", "low_delay", "-framedrop");
  }

  if (config.globalFfplaySettings.rtspTransportTcp.enabled && config.globalFfplaySettings.rtspTransportTcp.value) {
    args.push("-rtsp_transport", "tcp");
  }

  const streamUrl = String(config.stream?.url ?? "");
  const looksLikeHls = /\.m3u8($|\?)/i.test(streamUrl) || /format=m3u8/i.test(streamUrl);
  if (looksLikeHls) {
    const hls = config.globalFfplaySettings.hls;

    if (hls.liveStartIndex.enabled) {
      args.push("-live_start_index", String(hls.liveStartIndex.value));
    }

    if (hls.preferXStart.enabled) {
      args.push("-prefer_x_start", hls.preferXStart.value ? "1" : "0");
    }

    if (hls.httpPersistent.enabled) {
      args.push("-http_persistent", hls.httpPersistent.value ? "1" : "0");
    }

    if (hls.maxReload.enabled) {
      args.push("-max_reload", String(Math.max(0, Math.floor(hls.maxReload.value))));
    }

    if (hls.allowedExtensions.enabled && hls.allowedExtensions.value.trim()) {
      args.push("-allowed_extensions", hls.allowedExtensions.value.trim());
    }
  }

  if (config.globalFfplaySettings.syncMode.enabled) {
    args.push("-sync", config.globalFfplaySettings.syncMode.value);
  }

  if (config.globalFfplaySettings.loop.enabled && config.globalFfplaySettings.loop.value) {
    args.push("-stream_loop", "-1");
  }

  if (config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value) {
    args.push("-fs");
  }

  if (config.globalFfplaySettings.alwaysOnTop.enabled && config.globalFfplaySettings.alwaysOnTop.value) {
    args.push("-alwaysontop");
  }

  if (config.globalFfplaySettings.mute.enabled && config.globalFfplaySettings.mute.value) {
    args.push("-an");
  }

  if (config.clientSettings.showStats) {
    args.push("-stats");
  }

  if (config.clientSettings.fastDecode) {
    args.push("-fast");
  }

  if (config.clientSettings.genPts) {
    args.push("-genpts");
  }

  if (config.globalFfplaySettings.volume.enabled) {
    args.push("-volume", String(Math.max(0, Math.min(200, Math.round(config.globalFfplaySettings.volume.value ?? 100)))));
  }

  if (config.stream?.extraArgs) {
    args.push(...splitArgs(config.stream.extraArgs));
  }

  if (config.clientSettings.extraArgs) {
    args.push(...splitArgs(config.clientSettings.extraArgs));
  }

  args.push(config.stream?.url ?? "");

  return args;
}

function canRunMpvExecutable() {
  return Boolean(resolveMpvExecutablePath());
}

function probeMpvExecutable(command: string) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return false;
  }

  if ((normalized.includes("\\") || normalized.includes("/")) && !existsSync(normalized)) {
    return false;
  }

  try {
    const probe = Bun.spawnSync([normalized, "--version"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

function resolveMpvExecutablePath() {
  if (resolvedMpvExecutablePath && probeMpvExecutable(resolvedMpvExecutablePath)) {
    return resolvedMpvExecutablePath;
  }

  const findMpvInDirectory = (root: string, maxDepth = 4): string | null => {
    const seen = new Set<string>();

    const walk = (dir: string, depth: number): string | null => {
      if (depth > maxDepth || seen.has(dir) || !existsSync(dir)) {
        return null;
      }
      seen.add(dir);

      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return null;
      }

      for (const entry of entries) {
        const full = join(dir, entry);
        if (/^mpv(?:\.exe)?$/i.test(entry) && probeMpvExecutable(full)) {
          return full;
        }
      }

      for (const entry of entries) {
        const full = join(dir, entry);
        let isDirectory = false;
        try {
          isDirectory = statSync(full).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) {
          continue;
        }

        const found = walk(full, depth + 1);
        if (found) {
          return found;
        }
      }

      return null;
    };

    return walk(root, 0);
  };

  const candidates = [
    String(Bun.env.MPV_PATH || "").trim(),
    String(mpvPath || "").trim(),
    "mpv.exe",
    "mpv",
    "C:\\Program Files\\mpv\\mpv.exe",
    "C:\\Program Files (x86)\\mpv\\mpv.exe",
  ].filter((item) => item.length > 0);

  for (const candidate of candidates) {
    if (probeMpvExecutable(candidate)) {
      resolvedMpvExecutablePath = candidate;
      appendLog(`Resolved mpv executable: ${candidate}`);
      return candidate;
    }
  }

  const searchRoots = [
    String(Bun.env.LOCALAPPDATA || "").trim(),
    String(Bun.env.ProgramFiles || "").trim(),
    String((Bun.env as any)["ProgramFiles(x86)"] || "").trim(),
  ].filter((item) => item.length > 0);

  const wingetRoot = Bun.env.LOCALAPPDATA
    ? join(String(Bun.env.LOCALAPPDATA), "Microsoft", "WinGet", "Packages")
    : "";
  if (wingetRoot) {
    searchRoots.unshift(wingetRoot);
  }

  for (const root of searchRoots) {
    const found = findMpvInDirectory(root, root === wingetRoot ? 5 : 3);
    if (found) {
      resolvedMpvExecutablePath = found;
      appendLog(`Resolved mpv executable via filesystem scan: ${found}`);
      return found;
    }
  }

  try {
    const whereResult = Bun.spawnSync(["cmd", "/c", "where mpv.exe 2>nul"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (whereResult.exitCode === 0 && whereResult.stdout) {
      const lines = textDecoder
        .decode(whereResult.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        if (probeMpvExecutable(line)) {
          resolvedMpvExecutablePath = line;
          appendLog(`Resolved mpv executable via where: ${line}`);
          return line;
        }
      }
    }
  } catch {
  }

  resolvedMpvExecutablePath = null;
  return null;
}

function buildMpvArgs(config: RuntimeConfig) {
  const args: string[] = [
    "--force-window=yes",
    "--no-border",
    "--keep-open=no",
    "--input-default-bindings=no",
  ];

  if (config.globalFfplaySettings.fullScreen.enabled && config.globalFfplaySettings.fullScreen.value) {
    args.push("--fullscreen");
  }

  if (config.globalFfplaySettings.alwaysOnTop.enabled && config.globalFfplaySettings.alwaysOnTop.value) {
    args.push("--ontop");
  }

  if (config.globalFfplaySettings.mute.enabled && config.globalFfplaySettings.mute.value) {
    args.push("--mute=yes");
  }

  if (config.globalFfplaySettings.volume.enabled) {
    const volumePercent = Math.max(0, Math.min(200, Math.round(config.globalFfplaySettings.volume.value ?? 100)));
    args.push(`--volume=${volumePercent}`);
  }

  const windowX = Number.isFinite(config.clientSettings.windowX) ? Math.floor(config.clientSettings.windowX) : 0;
  const windowY = Number.isFinite(config.clientSettings.windowY) ? Math.floor(config.clientSettings.windowY) : 0;
  args.push(`--geometry=${Math.max(0, windowX)}:${Math.max(0, windowY)}`);

  if (config.clientSettings.fastDecode) {
    args.push("--vd-lavc-fast");
  }

  if (config.globalFfplaySettings.lowLatency.enabled && config.globalFfplaySettings.lowLatency.value) {
    args.push("--profile=low-latency");
  }

  if (config.stream?.extraArgs) {
    args.push(...splitArgs(config.stream.extraArgs));
  }

  if (config.clientSettings.extraArgs) {
    args.push(...splitArgs(config.clientSettings.extraArgs));
  }

  args.push(config.stream?.url ?? "");
  return args;
}

function spawnMpvNow(config: RuntimeConfig) {
  const executable = resolveMpvExecutablePath() || mpvPath;
  const nextPipePath = `\\\\.\\pipe\\stream-manager-mpv-${clientId}-${Date.now()}`;
  const args = buildMpvArgs(config);
  args.unshift(`--input-ipc-server=${nextPipePath}`);
  args.unshift("--screenshot-format=jpg", "--screenshot-jpeg-quality=72");
  currentCommandLine = buildCommandLine(executable, args);
  appendLog(`Starting mpv: ${executable} ${args.join(" ")}`);

  const processRef = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    onExit(_, exitCode, signalCode, error) {
      appendLog(`mpv exited (code=${exitCode}, signal=${signalCode}, error=${String(error || "none")})`);
    },
  });

  activeProcess = processRef;
  mpvIpcPipePath = nextPipePath;
  appliedLatencyOffsetMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  lastRestartAt = new Date().toISOString();

  pipeStreamToLogs(processRef.stdout, "mpv-stdout", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`mpv stdout pipe error: ${String(error)}`));
  pipeStreamToLogs(processRef.stderr, "mpv-stderr", appendLog, updateVideoTimestampFromFfplayLine)
    .catch((error) => appendLog(`mpv stderr pipe error: ${String(error)}`));

  processRef.exited.then(() => {
    if (activeProcess !== processRef) {
      return;
    }

    activeProcess = null;
    mpvIpcPipePath = null;
    appliedLatencyOffsetMs = 0;
    resetVideoTimestamp();
    if (desiredConfig?.stream && desiredConfig.clientSettings.playEnabled && !desiredConfig.serverPauseEnabled) {
      appendLog("mpv stopped unexpectedly; scheduling restart");
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (desiredConfig) {
          startPlayback(desiredConfig).catch((error) => appendLog(`Failed to restart playback: ${String(error)}`));
        }
      }, 1000);
    }
  });
}

async function startFfplay(config: RuntimeConfig) {
  if (config.serverPauseEnabled) {
    const reason = config.serverPauseMessage || "Video server paused";
    appendLog(`Server pause mode is enabled (${reason}), ffplay remains stopped`);
    killFfplay();
    return;
  }

  if (!config.clientSettings.playEnabled) {
    appendLog("Play is disabled by admin, ffplay remains stopped");
    killFfplay();
    return;
  }

  if (!config.stream) {
    appendLog("No stream assigned, ffplay remains stopped");
    killFfplay();
    return;
  }

  if (!(await Bun.file(ffplayPath).exists())) {
    appendLog(`ffplay executable was not found at ${ffplayPath}`);
    currentCommandLine = null;
    return;
  }

  killFfplay();
  resetVideoTimestamp();

  const requestedDelayMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  if (requestedDelayMs > 0) {
    appendLog(`Applying stream latency delay of ${requestedDelayMs}ms before ffplay start`);
    delayedStartUntilMs = Date.now() + requestedDelayMs;
    delayedStartTimer = setTimeout(() => {
      delayedStartTimer = null;
      delayedStartUntilMs = null;
      if (!desiredConfig?.stream) {
        return;
      }

      const expectedStreamId = String(config.stream?.id || "").trim();
      const currentStreamId = String(desiredConfig.stream?.id || "").trim();
      if (!expectedStreamId || expectedStreamId !== currentStreamId) {
        appendLog("Skipping delayed ffplay start because assigned stream changed");
        return;
      }

      if (!desiredConfig.clientSettings.playEnabled || desiredConfig.serverPauseEnabled) {
        appendLog("Skipping delayed ffplay start because playback is currently disabled");
        return;
      }

      spawnFfplayNow(desiredConfig);
    }, requestedDelayMs);
    return;
  }

  spawnFfplayNow(config);
}

async function startGstreamer(config: RuntimeConfig) {
  if (config.serverPauseEnabled) {
    const reason = config.serverPauseMessage || "Video server paused";
    appendLog(`Server pause mode is enabled (${reason}), gstreamer remains stopped`);
    killFfplay();
    return;
  }

  if (!config.clientSettings.playEnabled) {
    appendLog("Play is disabled by admin, gstreamer remains stopped");
    killFfplay();
    return;
  }

  if (!config.stream) {
    appendLog("No stream assigned, gstreamer remains stopped");
    killFfplay();
    return;
  }

  const hasPlayableGstreamer = canRunGstreamerExecutable(gstreamerPath) || canRunGstreamerExecutable(gstreamerLaunchPath);
  if (!hasPlayableGstreamer) {
    appendLog(`No runnable gstreamer executable found (tried ${gstreamerPath} and ${gstreamerLaunchPath}); falling back to ffplay`);
    await startFfplay({
      ...config,
      clientSettings: {
        ...config.clientSettings,
        playerBackend: "ffplay",
      },
    });
    return;
  }

  killFfplay();
  resetVideoTimestamp();

  const requestedDelayMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  if (requestedDelayMs > 0) {
    appendLog(`Applying stream latency delay of ${requestedDelayMs}ms before gstreamer start`);
    delayedStartUntilMs = Date.now() + requestedDelayMs;
    delayedStartTimer = setTimeout(() => {
      delayedStartTimer = null;
      delayedStartUntilMs = null;
      if (!desiredConfig?.stream) {
        return;
      }

      const expectedStreamId = String(config.stream?.id || "").trim();
      const currentStreamId = String(desiredConfig.stream?.id || "").trim();
      if (!expectedStreamId || expectedStreamId !== currentStreamId) {
        appendLog("Skipping delayed gstreamer start because assigned stream changed");
        return;
      }

      if (!desiredConfig.clientSettings.playEnabled || desiredConfig.serverPauseEnabled) {
        appendLog("Skipping delayed gstreamer start because playback is currently disabled");
        return;
      }

      try {
        spawnGstreamerNow(desiredConfig);
      } catch (error) {
        appendLog(`Failed to spawn gstreamer (${String(error)}); falling back to ffplay`);
        startFfplay({
          ...desiredConfig,
          clientSettings: {
            ...desiredConfig.clientSettings,
            playerBackend: "ffplay",
          },
        }).catch((innerError) => appendLog(`Fallback ffplay start failed: ${String(innerError)}`));
      }
    }, requestedDelayMs);
    return;
  }

  try {
    spawnGstreamerNow(config);
  } catch (error) {
    appendLog(`Failed to spawn gstreamer (${String(error)}); falling back to ffplay`);
    await startFfplay({
      ...config,
      clientSettings: {
        ...config.clientSettings,
        playerBackend: "ffplay",
      },
    });
  }
}

async function startMpv(config: RuntimeConfig) {
  if (config.serverPauseEnabled) {
    const reason = config.serverPauseMessage || "Video server paused";
    appendLog(`Server pause mode is enabled (${reason}), mpv remains stopped`);
    killFfplay();
    return;
  }

  if (!config.clientSettings.playEnabled) {
    appendLog("Play is disabled by admin, mpv remains stopped");
    killFfplay();
    return;
  }

  if (!config.stream) {
    appendLog("No stream assigned, mpv remains stopped");
    killFfplay();
    return;
  }

  if (!canRunMpvExecutable()) {
    appendLog(`Configured mpv executable was not found or not runnable at ${mpvPath}; falling back to ffplay`);
    await startFfplay({
      ...config,
      clientSettings: {
        ...config.clientSettings,
        playerBackend: "ffplay",
      },
    });
    return;
  }

  killFfplay();
  resetVideoTimestamp();

  const requestedDelayMs = Math.max(0, Math.round(config.streamLatencyOffsetMs || 0));
  if (requestedDelayMs > 0) {
    appendLog(`Applying stream latency delay of ${requestedDelayMs}ms before mpv start`);
    delayedStartUntilMs = Date.now() + requestedDelayMs;
    delayedStartTimer = setTimeout(() => {
      delayedStartTimer = null;
      delayedStartUntilMs = null;
      if (!desiredConfig?.stream) {
        return;
      }

      const expectedStreamId = String(config.stream?.id || "").trim();
      const currentStreamId = String(desiredConfig.stream?.id || "").trim();
      if (!expectedStreamId || expectedStreamId !== currentStreamId) {
        appendLog("Skipping delayed mpv start because assigned stream changed");
        return;
      }

      if (!desiredConfig.clientSettings.playEnabled || desiredConfig.serverPauseEnabled) {
        appendLog("Skipping delayed mpv start because playback is currently disabled");
        return;
      }

      try {
        spawnMpvNow(desiredConfig);
      } catch (error) {
        appendLog(`Failed to spawn mpv (${String(error)}); falling back to ffplay`);
        startFfplay({
          ...desiredConfig,
          clientSettings: {
            ...desiredConfig.clientSettings,
            playerBackend: "ffplay",
          },
        }).catch((innerError) => appendLog(`Fallback ffplay start failed: ${String(innerError)}`));
      }
    }, requestedDelayMs);
    return;
  }

  try {
    spawnMpvNow(config);
  } catch (error) {
    appendLog(`Failed to spawn mpv (${String(error)}); falling back to ffplay`);
    await startFfplay({
      ...config,
      clientSettings: {
        ...config.clientSettings,
        playerBackend: "ffplay",
      },
    });
  }
}

async function startPlayback(config: RuntimeConfig) {
  if (config.clientSettings.playerBackend === "mpv") {
    await startMpv(config);
    return;
  }

  if (config.clientSettings.playerBackend === "gstreamer") {
    await startGstreamer(config);
    return;
  }

  await startFfplay(config);
}

function applyConfig(config: RuntimeConfig) {
  const normalized = normalizeRuntimeConfig(config);
  if (!normalized) {
    appendLog("Ignoring invalid runtime config");
    return;
  }

  desiredConfig = normalized;
  saveLastConfig(normalized);
  startPlayback(normalized).catch((error) => appendLog(`Failed to start playback: ${String(error)}`));
  publishHealth();
}

async function connect() {
  const discovered = await discoverServerUrl();
  const targetServerUrl = configuredServerUrl || discovered || lastDiscoveredServerUrl;
  if (discovered) {
    lastDiscoveredServerUrl = discovered;
  }

  if (!targetServerUrl) {
    appendLog(`No server discovered via mDNS; retrying in ${reconnectDelayMs}ms`);
    setTimeout(() => {
      connect().catch((error) => appendLog(`Reconnect failed: ${String(error)}`));
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
    return;
  }

  appendLog(`Connecting to ${targetServerUrl}`);
  const overlayBase = buildOverlayServerBaseUrl(targetServerUrl);
  if (overlayBase) {
    startOverlayApp(overlayBase);
  } else {
    appendLog(`Could not derive overlay HTTP URL from ${targetServerUrl}`);
  }

  ws = new WebSocket(targetServerUrl);

  ws.addEventListener("open", () => {
    appendLog("WebSocket connected");
    reconnectDelayMs = 1000;
    send("hello", {
      role: "client",
      clientId,
      clientName,
    });
    publishHealth();
  });

  ws.addEventListener("message", (event) => {
    let msg: any;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      appendLog("Invalid JSON from server");
      return;
    }

    if (msg.type === "config_update" && msg.payload) {
      applyConfig(msg.payload as RuntimeConfig);
      return;
    }

    if (msg.type === "ping_request") {
      send("ping_response", {
        pingId: msg.payload?.pingId ?? null,
      });
      return;
    }

    if (msg.type === "request_logs") {
      send("client_logs", { logs, overlayLogs });
      return;
    }

    if (msg.type === "control_command") {
      const action = String(msg.payload?.action || "").trim();
      if (action === "force_update") {
        requestSupervisorAction("force_update");
        return;
      }

      if (action === "restart") {
        requestSupervisorAction("restart");
        return;
      }

      if (action === "sync_nudge") {
        applyLiveSyncNudge(msg.payload?.deltaMs)
          .then((handled) => {
            if (!handled) {
              appendLog("sync_nudge could not be applied live; using restart fallback");
              requestSupervisorAction("restart");
            }
          })
          .catch((error) => {
            appendLog(`sync_nudge failed: ${String(error)}; using restart fallback`);
            requestSupervisorAction("restart");
          });
        return;
      }

      appendLog(`Unknown control command action: ${action || "(empty)"}`);
      return;
    }
  });

  ws.addEventListener("close", () => {
    appendLog(`WebSocket disconnected; reconnecting in ${reconnectDelayMs}ms`);
    setTimeout(() => {
      connect().catch((error) => appendLog(`Reconnect failed: ${String(error)}`));
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  });

  ws.addEventListener("error", (event) => {
    appendLog(`WebSocket error: ${String(event)}`);
  });
}

setInterval(() => {
  publishHealth();
}, 5000);

if (!acquireSingleInstanceLock()) {
  process.exit(0);
}

registerShutdownHandlers();

const fallbackConfig = loadLastConfig();
if (fallbackConfig) {
  appendLog("Loaded last saved configuration for offline fallback");
  applyConfig(fallbackConfig);
}

connect().catch((error) => appendLog(`Initial connect failed: ${String(error)}`));
