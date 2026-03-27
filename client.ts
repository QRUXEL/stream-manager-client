import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
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
};

type RuntimeConfig = {
  stream: StreamConfig | null;
  globalFfplaySettings: GlobalFfplaySettings;
  clientSettings: ClientSettings;
};

const configuredServerUrl = Bun.env.SERVER_URL;
const clientId = Bun.env.CLIENT_ID || Bun.env.COMPUTERNAME || `client-${crypto.randomUUID().slice(0, 8)}`;
const clientName = Bun.env.CLIENT_NAME || clientId;
const clientDir = import.meta.dir;
const ffplayPath = join(clientDir, "ffplay.exe");
const persistedConfigPath = "./last-config.json";
const lockFilePath = "./client.lock";
const overlayAppDir = join(clientDir, "electron-overlay");
const overlayRestartDelayMs = 2000;
const overlayMinHealthyRunMs = 5000;
const overlayMaxConsecutiveCrashes = 5;
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
let overlayRestartTimer: ReturnType<typeof setTimeout> | null = null;
let lastRestartAt: string | null = null;
let currentCommandLine: string | null = null;
let lastDiscoveredServerUrl: string | null = null;
let overlayServerBaseUrl: string | null = null;
const logs: string[] = [];
const overlayLogs: string[] = [];
const textDecoder = new TextDecoder();
let lockFd: number | null = null;
let overlayProcess: ReturnType<typeof Bun.spawn> | null = null;
let overlayExpectedExit = false;
let overlayStartAtMs = 0;
let overlayConsecutiveCrashCount = 0;
let overlayLastRestartAt: string | null = null;
let overlayCommandLine: string | null = null;
let overlayLastCommandLine: string | null = null;
let shuttingDown = false;

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
    "--client-id",
    clientId,
  ];

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
    },
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
  });
}

async function pipeStreamToLogs(
  stream: ReadableStream<Uint8Array> | null,
  label: string,
  logger: (line: string) => void = appendLog,
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
      logger(`${label}: ${line}`);
    }
  }
}

function killFfplay() {
  if (!activeProcess) {
    currentCommandLine = null;
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

async function startFfplay(config: RuntimeConfig) {
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
  lastRestartAt = new Date().toISOString();

  pipeStreamToLogs(processRef.stdout, "stdout").catch((error) => appendLog(`stdout pipe error: ${String(error)}`));
  pipeStreamToLogs(processRef.stderr, "stderr").catch((error) => appendLog(`stderr pipe error: ${String(error)}`));

  processRef.exited.then(() => {
    if (activeProcess !== processRef) {
      return;
    }

    activeProcess = null;
    if (desiredConfig?.stream && desiredConfig.clientSettings.playEnabled) {
      appendLog("ffplay stopped unexpectedly; scheduling restart");
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (desiredConfig) {
          startFfplay(desiredConfig);
        }
      }, 1000);
    }
  });
}

function applyConfig(config: RuntimeConfig) {
  const normalized = normalizeRuntimeConfig(config);
  if (!normalized) {
    appendLog("Ignoring invalid runtime config");
    return;
  }

  desiredConfig = normalized;
  saveLastConfig(normalized);
  startFfplay(normalized).catch((error) => appendLog(`Failed to start ffplay: ${String(error)}`));
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
