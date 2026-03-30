// --- Render window: pure view (SVG rendering + eye tracking) ---
// All input (pointer/drag/click) is handled by the hit window (hit-renderer.js).
// Reactions are triggered via IPC from main (relayed from hit window).

const container = document.getElementById("pet-container");
const visualLayer = document.getElementById("pet-visual-layer");

// --- Reaction state (visual side) ---
const REACT_DRAG_SVG = "clawd-react-drag.svg";
let isReacting = false;
let isDragReacting = false;
let reactTimer = null;
let currentIdleSvg = null; // tracks which SVG is currently showing
let dndEnabled = false;

window.electronAPI.onDndChange((enabled) => {
  dndEnabled = enabled;
});

function getObjectSvgName(objectEl) {
  if (!objectEl) return null;
  const data = objectEl.getAttribute("data") || objectEl.data || "";
  if (!data) return null;
  const clean = data.split(/[?#]/)[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || null;
}

function getElementVisualName(el) {
  if (!el) return null;
  return getObjectSvgName(el);
}

const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";

function shouldTrackEyes(state, svg) {
  return (state === "idle" && svg === SVG_IDLE_FOLLOW) || state === "mini-idle";
}

// --- IPC-triggered reactions (from hit window via main relay) ---
window.electronAPI.onStartDragReaction(() => startDragReaction());
window.electronAPI.onEndDragReaction(() => endDragReaction());
window.electronAPI.onPlayClickReaction((svg, duration) => playReaction(svg, duration));

function playReaction(svgFile, durationMs) {
  isReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();

  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }

  const next = createVisualElement(svgFile);
  next.style.opacity = "0";

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...visualLayer.children]) {
      if (child !== next) removeVisualElement(child);
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svgFile;
  };

  attachVisualReadyHandler(next, swap);
  visualLayer.appendChild(next);
  pendingNext = next;
  installSwapFallback(next, swap);

  reactTimer = setTimeout(() => endReaction(), durationMs);
}

function endReaction() {
  if (!isReacting) return;
  isReacting = false;
  reactTimer = null;
  window.electronAPI.resumeFromReaction();
}

function cancelReaction() {
  if (isReacting) {
    if (reactTimer) {
      clearTimeout(reactTimer);
      reactTimer = null;
    }
    isReacting = false;
  }
  if (isDragReacting) {
    isDragReacting = false;
  }
}

// --- Drag reaction (loops while dragging, idle-follow only) ---
function swapToSvg(svgFile) {
  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }
  const next = createVisualElement(svgFile);
  next.style.opacity = "0";
  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...visualLayer.children]) {
      if (child !== next) removeVisualElement(child);
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svgFile;
  };
  attachVisualReadyHandler(next, swap);
  visualLayer.appendChild(next);
  pendingNext = next;
  installSwapFallback(next, swap);
}

function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return; // DND: just move the window, no reaction animation

  if (isReacting) {
    if (reactTimer) {
      clearTimeout(reactTimer);
      reactTimer = null;
    }
    isReacting = false;
  }

  isDragReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();
  swapToSvg(REACT_DRAG_SVG);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.electronAPI.resumeFromReaction();
}

// --- State change → switch SVG animation (preload + instant swap) ---
let clawdEl = document.getElementById("clawd");
let pendingNext = null;
let currentDisplayedSvg = getElementVisualName(clawdEl);
currentIdleSvg = currentDisplayedSvg;

window.electronAPI.onStateChange((state, svg) => {
  cancelReaction();

  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }
  if (clawdEl && clawdEl.isConnected && currentDisplayedSvg === svg) {
    if (shouldTrackEyes(state, svg) && !eyeTarget) {
      attachEyeTracking(clawdEl);
    } else if (!shouldTrackEyes(state, svg)) {
      detachEyeTracking();
    }
    currentIdleSvg = svg;
    return;
  }
  detachEyeTracking();

  const next = createVisualElement(svg);
  next.style.opacity = "0";

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...visualLayer.children]) {
      if (child !== next) removeVisualElement(child);
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svg;

    if (shouldTrackEyes(state, svg)) {
      attachEyeTracking(next);
    }

    currentIdleSvg = svg;
  };

  attachVisualReadyHandler(next, swap);
  visualLayer.appendChild(next);
  pendingNext = next;
  installSwapFallback(next, swap);
});

function createVisualElement(svgName) {
  const obj = document.createElement("object");
  obj.type = "image/svg+xml";
  obj.id = "clawd";
  obj.data = `../assets/svg/${svgName}`;
  return obj;
}

function attachVisualReadyHandler(el, onReady) {
  el.addEventListener("load", onReady, { once: true });
}

function installSwapFallback(el, onReady) {
  setTimeout(() => {
    if (pendingNext !== el) return;
    try {
      if (!el.contentDocument) {
        el.remove();
        pendingNext = null;
        return;
      }
    } catch {
      el.remove();
      pendingNext = null;
      return;
    }
    onReady();
  }, 3000);
}

function removeVisualElement(el) {
  if (!el) return;
  el.remove();
}

// --- Eye tracking (idle state only) ---
let eyeTarget = null;
let bodyTarget = null;
let shadowTarget = null;
let lastEyeDx = 0;
let lastEyeDy = 0;
let eyeAttachToken = 0;

function applyEyeMove(dx, dy) {
  if (eyeTarget) {
    eyeTarget.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  if (bodyTarget || shadowTarget) {
    const bdx = Math.round(dx * 0.33 * 2) / 2;
    const bdy = Math.round(dy * 0.33 * 2) / 2;
    if (bodyTarget) bodyTarget.style.transform = `translate(${bdx}px, ${bdy}px)`;
    if (shadowTarget) {
      const absDx = Math.abs(bdx);
      const scaleX = 1 + absDx * 0.15;
      const shiftX = Math.round(bdx * 0.3 * 2) / 2;
      shadowTarget.style.transform = `translate(${shiftX}px, 0) scaleX(${scaleX})`;
    }
  }
}

function attachEyeTracking(objectEl) {
  const token = ++eyeAttachToken;
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;

  const tryAttach = (attempt) => {
    if (token !== eyeAttachToken) return;
    if (!objectEl || !objectEl.isConnected) return;

    try {
      const svgDoc = objectEl.contentDocument;
      const eyes = svgDoc && svgDoc.getElementById("eyes-js");
      if (eyes) {
        eyeTarget = eyes;
        bodyTarget = svgDoc.getElementById("body-js");
        shadowTarget = svgDoc.getElementById("shadow-js");
        applyEyeMove(lastEyeDx, lastEyeDy);
        return;
      }
    } catch (e) {
      console.warn("Cannot access SVG contentDocument for eye tracking:", e.message);
      return;
    }

    if (attempt >= 60) {
      console.warn("Timed out waiting for SVG eye targets");
      return;
    }
    setTimeout(() => tryAttach(attempt + 1), 16);
  };

  tryAttach(0);
}

function detachEyeTracking() {
  eyeAttachToken++;
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
}

window.electronAPI.onEyeMove((dx, dy) => {
  lastEyeDx = dx;
  lastEyeDy = dy;
  if (eyeTarget && !eyeTarget.ownerDocument?.defaultView) {
    eyeTarget = null;
    bodyTarget = null;
    shadowTarget = null;
    if (clawdEl && clawdEl.isConnected) attachEyeTracking(clawdEl);
    return;
  }
  applyEyeMove(dx, dy);
});

window.electronAPI.onWakeFromDoze(() => {
  if (clawdEl && clawdEl.contentDocument) {
    try {
      const eyes = clawdEl.contentDocument.getElementById("eyes-doze");
      if (eyes) eyes.style.transform = "scaleY(1)";
    } catch (e) {}
  }
});

// --- Pomodoro floating widget ---
const pomodoroWidget = document.getElementById("pomodoro-widget");
const pomodoroIcon = document.getElementById("pomodoro-icon");
const pomodoroCountdown = document.getElementById("pomodoro-countdown");
let pomodoroFrameTimer = null;
let pomodoroFrameIndex = 0;

function startPomodoroIconAnimation() {
  if (!pomodoroIcon || pomodoroFrameTimer) return;
  pomodoroFrameTimer = setInterval(() => {
    pomodoroFrameIndex = (pomodoroFrameIndex + 1) % 4;
    pomodoroIcon.src = `../assets/png/clawd-tomato/tomato_${pomodoroFrameIndex}.png`;
  }, 160);
}

function stopPomodoroIconAnimation() {
  if (!pomodoroFrameTimer) return;
  clearInterval(pomodoroFrameTimer);
  pomodoroFrameTimer = null;
}

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil((remainingMs || 0) / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

window.electronAPI.onPomodoroState((data) => {
  if (!pomodoroWidget || !pomodoroCountdown || !pomodoroIcon || !data) return;

  if (!data.visible) {
    pomodoroWidget.style.display = "none";
    stopPomodoroIconAnimation();
    pomodoroFrameIndex = 0;
    pomodoroIcon.src = "../assets/png/clawd-tomato/tomato_0.png";
    return;
  }

  pomodoroWidget.style.display = "flex";
  pomodoroCountdown.textContent = formatCountdown(data.remainingMs);

  if (data.paused) {
    stopPomodoroIconAnimation();
    return;
  }
  startPomodoroIconAnimation();
});
