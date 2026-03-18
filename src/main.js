const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const data = { x, y, size: currentSize };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

// ── SVG filename constants (used across main + renderer via IPC) ──
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";

// ── State → SVG mapping ──
const STATE_SVGS = {
  idle: [SVG_IDLE_FOLLOW],
  yawning: ["clawd-idle-yawn.svg"],
  dozing: ["clawd-idle-doze.svg"],
  collapsing: ["clawd-idle-collapse.svg"],
  thinking: ["clawd-working-thinking.svg"],
  working: ["clawd-working-typing.svg"],
  juggling: ["clawd-working-juggling.svg"],
  sweeping: ["clawd-working-sweeping.svg"],
  error: ["clawd-error.svg"],
  attention: ["clawd-happy.svg"],
  notification: ["clawd-notification.svg"],
  carrying: ["clawd-working-carrying.svg"],
  sleeping: ["clawd-sleeping.svg"],
};

const MIN_DISPLAY_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 2000,
  notification: 4000,
  carrying: 3000,
  working: 1000,
  thinking: 1000,
};

// Oneshot states that auto-return to idle (subset of MIN_DISPLAY_MS)
const AUTO_RETURN_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 300000,  // 5min safety; PostCompact ends sweeping normally
  notification: 4000,  // matches SVG animation loop (4s)
  carrying: 3000,
};

const MOUSE_IDLE_TIMEOUT = 20000;   // 20s → idle-look
const MOUSE_SLEEP_TIMEOUT = 60000;  // 60s → yawning → dozing
const DEEP_SLEEP_TIMEOUT = 600000;  // 10min → collapsing → sleeping
const YAWN_DURATION = 3800;
const COLLAPSE_DURATION = 800;
const IDLE_LOOK_DURATION = 10000;  // idle-look CSS loop is 10s
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping"]);

// ── Session tracking ──
const sessions = new Map(); // session_id → { state, updatedAt }
const SESSION_STALE_MS = 300000; // 5 min cleanup
const STATE_PRIORITY = {
  error: 8, notification: 7, sweeping: 6, attention: 5,
  carrying: 4, juggling: 4, working: 3, thinking: 2, idle: 1, sleeping: 0,
};

let win;
let tray = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ── State machine ──
let currentState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let cursorPollTimer = null;
let lastEyeDx = 0, lastEyeDy = 0;
let forceEyeResend = false;


// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions

// ── Wake poll (during dozing) ──
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

let pendingState = null; // tracks what state is waiting in pendingTimer

function setState(newState, svgOverride) {
  if (doNotDisturb) return;

  // Oneshot events from hooks should always wake from sleep —
  // any hook event means Claude Code is active, Clawd shouldn't stay asleep.

  // Don't re-enter sleep sequence when already in it
  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

  // Don't displace a pending higher-priority state with a lower-priority one
  if (pendingTimer) {
    if (pendingState && (STATE_PRIORITY[newState] || 0) < (STATE_PRIORITY[pendingState] || 0)) {
      return;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingState = null;
  }

  const sameState = newState === currentState;
  const sameSvg = !svgOverride || svgOverride === currentSvg;
  if (sameState && sameSvg) {
    return;
  }

  const minTime = MIN_DISPLAY_MS[currentState] || 0;
  const elapsed = Date.now() - stateChangedAt;
  const remaining = minTime - elapsed;

  if (remaining > 0) {
    // Cancel current state's auto-return to prevent timer race
    if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
    pendingState = newState;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      pendingState = null;
      applyState(newState, svgOverride);
    }, remaining);
  } else {
    applyState(newState, svgOverride);
  }
}

function applyState(state, svgOverride) {
  currentState = state;
  stateChangedAt = Date.now();

  const svgs = STATE_SVGS[state] || STATE_SVGS.idle;
  const svg = svgOverride || svgs[Math.floor(Math.random() * svgs.length)];
  currentSvg = svg;

  sendToRenderer("state-change", state, svg);

  // Eye tracking: only poll during idle
  if (state === "idle") {
    startCursorPolling();
  } else {
    stopCursorPolling();
    sendToRenderer("eye-move", 0, 0);
  }

  // Wake poll: dozing and sleeping (not DND sleeping)
  if ((state === "dozing" || state === "sleeping") && !doNotDisturb) {
    setTimeout(() => {
      if (currentState === state) startWakePoll();
    }, 500);
  } else {
    stopWakePoll();
  }

  // Sleep/doze sequence: yawning → dozing, collapsing → sleeping
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (state === "yawning") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState("dozing");
    }, YAWN_DURATION);
  } else if (state === "collapsing") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState("sleeping");
    }, COLLAPSE_DURATION);
  } else if (AUTO_RETURN_MS[state]) {
    // Oneshot states → auto-return (re-resolve from sessions instead of hardcoded idle)
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }, AUTO_RETURN_MS[state]);
  }
}

// ── Eye tracking (cursor polling + mouse idle detection) ──
function startCursorPolling() {
  if (cursorPollTimer) return;
  isMouseIdle = false;
  hasTriggeredYawn = false;
  lastCursorX = null;
  lastCursorY = null;
  mouseStillSince = Date.now();

  cursorPollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();

    // Detect mouse movement
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    if (moved) {
      mouseStillSince = Date.now();
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
      if (isMouseIdle) {
        // Wake from idle-look → back to idle-follow with eye tracking
        isMouseIdle = false;
        sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
      }
    }

    const elapsed = Date.now() - mouseStillSince;

    // 60s no mouse movement → yawning → dozing
    if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
      hasTriggeredYawn = true;
      if (!isMouseIdle) sendToRenderer("eye-move", 0, 0);
      yawnDelayTimer = setTimeout(() => {
        yawnDelayTimer = null;
        if (currentState === "idle") setState("yawning");
      }, isMouseIdle ? 50 : 250);
      return;
    }

    // 20s no mouse movement → idle-look (play once, then return)
    if (!isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
      isMouseIdle = true;
      idleLookPlayed = true;
      sendToRenderer("eye-move", 0, 0);
      // Delay swap to let eyes ease back to center
      setTimeout(() => {
        if (isMouseIdle && currentState === "idle") {
          sendToRenderer("state-change", "idle", SVG_IDLE_LOOK);
        }
      }, 250);
      // Auto-return to idle-follow after one 10s cycle
      idleLookReturnTimer = setTimeout(() => {
        idleLookReturnTimer = null;
        if (isMouseIdle && currentState === "idle") {
          isMouseIdle = false;
          sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
          // Force eye position re-send after SVG has loaded
          setTimeout(() => { forceEyeResend = true; }, 200);
        }
      }, 250 + IDLE_LOOK_DURATION);
      return;
    }

    // Only send eye position when showing idle-follow
    if (isMouseIdle || (!moved && !forceEyeResend)) return;
    const skipDedup = forceEyeResend;
    forceEyeResend = false;

    const bounds = win.getBounds();

    // Eye center in screen coords, compensating for CSS oversizing/offset
    const objW = bounds.width * 1.9;
    const objH = bounds.height * 1.3;
    const objX = bounds.x + bounds.width * (-0.45);
    const objY = bounds.y + bounds.height * (-0.25);
    const eyeScreenX = objX + objW * (22 / 45);
    const eyeScreenY = objY + objH * (34 / 45);

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = 3;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    // Quantize to 0.5px grid for pixel-art feel
    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    // Clamp vertical tighter — eyes shouldn't go too far up/down
    eyeDy = Math.max(-1.5, Math.min(1.5, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      sendToRenderer("eye-move", eyeDx, eyeDy);
    }
  }, 67); // ~15fps
}

function stopCursorPolling() {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }
  if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
  if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
  lastEyeDx = 0;
  lastEyeDy = 0;
  isMouseIdle = false;
  hasTriggeredYawn = false;
  idleLookPlayed = false;
}

// ── Wake poll (detect mouse movement during dozing → wake up) ──
function startWakePoll() {
  if (wakePollTimer) return;
  const cursor = screen.getCursorScreenPoint();
  lastWakeCursorX = cursor.x;
  lastWakeCursorY = cursor.y;

  wakePollTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    const moved = cursor.x !== lastWakeCursorX || cursor.y !== lastWakeCursorY;

    if (moved) {
      stopWakePoll();
      wakeFromDoze();
      return;
    }

    // 10min total mouse idle → deep sleep (only from dozing, not sleeping)
    if (currentState === "dozing" && Date.now() - mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
      stopWakePoll();
      applyState("collapsing");
    }
  }, 200); // 5 checks/sec, lightweight
}

function stopWakePoll() {
  if (wakePollTimer) { clearInterval(wakePollTimer); wakePollTimer = null; }
}

function wakeFromDoze() {
  if (currentState === "sleeping") {
    // Direct wake from sleep (collapsed pose → idle, no smooth transition yet)
    applyState("idle");
    return;
  }
  sendToRenderer("wake-from-doze");
  // After eye-opening transition, switch to idle
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle");
    }
  }, 350);
}

// ── Session management ──
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

function updateSession(sessionId, state, event) {
  if (event === "SessionEnd") {
    sessions.delete(sessionId);
  } else if (state === "attention" || SLEEP_SEQUENCE.has(state)) {
    // Stop/sleep: response complete → session goes idle
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
  } else if (ONESHOT_STATES.has(state)) {
    // Other oneshots (error/sweeping/notification/carrying):
    // preserve session's previous state so auto-return resolves correctly
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
    }
  } else {
    // Preserve juggling: subagent's own tool use (PreToolUse/PostToolUse)
    // shouldn't override juggling — only SubagentStop should end it.
    const existing = sessions.get(sessionId);
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now() });
    }
  }
  cleanStaleSessions();

  // All sessions ended → sleep immediately
  if (sessions.size === 0 && event === "SessionEnd") {
    setState("sleeping");
    return;
  }

  // Oneshot: show animation directly, auto-return will re-resolve from session map
  if (ONESHOT_STATES.has(state)) {
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
}

let staleCleanupTimer = null;

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_STALE_MS) { sessions.delete(id); changed = true; }
  }
  // If stale sessions were cleaned, re-resolve display state
  if (changed && sessions.size === 0) {
    setState("yawning");
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
}

function startStaleCleanup() {
  if (staleCleanupTimer) return;
  staleCleanupTimer = setInterval(cleanStaleSessions, 60000); // every 60s
}

function stopStaleCleanup() {
  if (staleCleanupTimer) { clearInterval(staleCleanupTimer); staleCleanupTimer = null; }
}

function resolveDisplayState() {
  if (sessions.size === 0) return "idle";
  let best = "sleeping";
  for (const [, s] of sessions) {
    if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) best = s.state;
  }
  return best;
}

function getActiveWorkingCount() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "working" || s.state === "thinking" || s.state === "juggling") n++;
  }
  return n;
}

function getWorkingSvg() {
  const n = getActiveWorkingCount();
  if (n >= 3) return "clawd-working-building.svg";
  if (n >= 2) return "clawd-working-juggling.svg";
  return "clawd-working-typing.svg";
}

function getSvgOverride(state) {
  if (state === "working") return getWorkingSvg();
  if (state === "juggling") return getJugglingSvg();
  return null;
}

function getJugglingSvg() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  doNotDisturb = true;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopCursorPolling();
  stopWakePoll();
  applyState("sleeping");
  buildContextMenu();
  buildTrayMenu();
}

function disableDoNotDisturb() {
  doNotDisturb = false;
  // Resolve from active sessions instead of blindly forcing idle
  const resolved = resolveDisplayState();
  applyState(resolved, getSvgOverride(resolved));
  buildContextMenu();
  buildTrayMenu();
}

// ── HTTP server ──
let httpServer = null;

function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let destroyed = false;
      req.on("data", (chunk) => {
        bodySize += chunk.length;
        if (bodySize > 1024) { destroyed = true; req.destroy(); return; }
        body += chunk;
      });
      req.on("end", () => {
        if (destroyed) return;
        try {
          const data = JSON.parse(body);
          const { state, svg, session_id, event } = data;
          if (STATE_SVGS[state]) {
            const sid = session_id || "default";
            updateSession(sid, state, event);
            res.writeHead(200);
            res.end("ok");
          } else {
            res.writeHead(400);
            res.end("unknown state");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(23333, "127.0.0.1", () => {
    console.log("Clawd state server listening on 127.0.0.1:23333");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn("Port 23333 is in use — running in idle-only mode (no state sync)");
    } else {
      console.error("HTTP server error:", err.message);
    }
  });
}

// ── System tray ──
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip("Clawd Desktop Pet");
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: doNotDisturb ? "唤醒 Clawd" : "休眠（免打扰）",
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ── Window creation ──
function createWindow() {
  const prefs = loadPrefs();
  if (prefs && SIZES[prefs.size]) currentSize = prefs.size;
  const size = SIZES[currentSize];

  // Restore saved position, or default to bottom-right of primary display
  let startX, startY;
  if (prefs) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const { workArea } = screen.getPrimaryDisplay();
    startX = workArea.x + workArea.width - size.width - 20;
    startY = workArea.y + workArea.height - size.height - 20;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.setFocusable(false);
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();

  buildContextMenu();
  createTray();

  ipcMain.on("show-context-menu", () => {
    contextMenu.popup({ window: win });
  });

  ipcMain.on("move-window-by", (event, dx, dy) => {
    const { x, y } = win.getBounds();
    const size = SIZES[currentSize];
    const clamped = clampToScreen(x + dx, y + dy, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
  });

  ipcMain.on("pause-cursor-polling", () => stopCursorPolling());
  ipcMain.on("resume-from-reaction", () => {
    // Re-send current state to renderer without resetting stateChangedAt or timers.
    // Using applyState() here would reset MIN_DISPLAY_MS timing and interfere
    // with pending state transitions (e.g. a deferred error could be disrupted).
    sendToRenderer("state-change", currentState, currentSvg);
    if (currentState === "idle") startCursorPolling();
  });

  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // (prevents race where IPC arrives before renderer listeners exist)
  win.webContents.on("did-finish-load", () => {
    applyState("idle");
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    win.webContents.reload();
  });

  // ── Periodic alwaysOnTop refresh (Windows DWM can drop z-order) ──
  setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.setAlwaysOnTop(true);
    }
  }, 30000); // every 30s

  // ── Display change: re-clamp window to prevent off-screen ──
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    if (clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width, height });
    }
  });
  screen.on("display-removed", () => {
    if (!win || win.isDestroyed()) return;
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    win.setBounds({ ...clamped, width, height });
  });
}

function clampToScreen(x, y, w, h) {
  const displays = screen.getAllDisplays();
  const cx = x + w / 2;
  const cy = y + h / 2;
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; nearest = wa; }
  }
  return {
    x: Math.max(nearest.x, Math.min(x, nearest.x + nearest.width - w)),
    y: Math.max(nearest.y, Math.min(y, nearest.y + nearest.height - h)),
  };
}

function buildContextMenu() {
  contextMenu = Menu.buildFromTemplate([
    {
      label: "大小",
      submenu: [
        { label: "小 (S)", type: "radio", checked: currentSize === "S", click: () => resizeWindow("S") },
        { label: "中 (M)", type: "radio", checked: currentSize === "M", click: () => resizeWindow("M") },
        { label: "大 (L)", type: "radio", checked: currentSize === "L", click: () => resizeWindow("L") },
      ],
    },
    { type: "separator" },
    {
      label: doNotDisturb ? "唤醒 Clawd" : "休眠（免打扰）",
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

function resizeWindow(sizeKey) {
  currentSize = sizeKey;
  const size = SIZES[sizeKey];
  const { x, y } = win.getBounds();
  win.setBounds({ x, y, width: size.width, height: size.height });
  buildContextMenu();
  savePrefs();
}

// ── Single instance lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) win.showInactive();
  });

  app.whenReady().then(createWindow);

  app.on("before-quit", () => {
    savePrefs();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (cursorPollTimer) clearInterval(cursorPollTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
    stopStaleCleanup();
    if (httpServer) httpServer.close();
  });

  app.on("window-all-closed", () => app.quit());
}
