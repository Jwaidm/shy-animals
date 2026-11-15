(function () {
  "use strict";

  // =========================================================
  // CONFIGURATION & STATE
  // =========================================================
  const STORAGE_KEY = "shy_forest_settings_v1";

  const settings = {
    sensitivity: 100, // 35% .. 220%
    quietSeconds: 8,  // 3s .. 30s
    demoMode: false
  };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) {
      if (typeof saved.sensitivity === "number") settings.sensitivity = saved.sensitivity;
      if (typeof saved.quietSeconds === "number") settings.quietSeconds = saved.quietSeconds;
    }
  } catch (_) {
    // Ignore storage restrictions in private browsing / file://
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sensitivity: settings.sensitivity,
          quietSeconds: settings.quietSeconds
        })
      );
    } catch (_) {}
  }

  // Staggered shyness: Hare hides first, then Deer, Badger, Hedgehog
  const animals = [
    {
      key: "hare",
      slotId: "slot-hare",
      coverId: "cover-hare",
      alertAt: 0.20,
      threshold: 0.28,
      recoveryFactor: 1.18,
      spot: { x: 585, y: 960 },
      state: "visible",
      loudHold: 0,
      calmProgress: 1
    },
    {
      key: "deer",
      slotId: "slot-deer",
      coverId: "cover-deer",
      alertAt: 0.32,
      threshold: 0.42,
      recoveryFactor: 1.04,
      spot: { x: 605, y: 760 },
      state: "visible",
      loudHold: 0,
      calmProgress: 1
    },
    {
      key: "badger",
      slotId: "slot-badger",
      coverId: "cover-badger",
      alertAt: 0.46,
      threshold: 0.56,
      recoveryFactor: 0.90,
      spot: { x: 965, y: 825 },
      state: "visible",
      loudHold: 0,
      calmProgress: 1
    },
    {
      key: "hedgehog",
      slotId: "slot-hedgehog",
      coverId: "cover-hedgehog",
      alertAt: 0.60,
      threshold: 0.72,
      recoveryFactor: 0.76,
      spot: { x: 938, y: 1020 },
      state: "visible",
      loudHold: 0,
      calmProgress: 1
    }
  ];

  // =========================================================
  // DOM ELEMENTS
  // =========================================================
  const svgEl = document.getElementById("forest-svg");
  const fxCanvas = document.getElementById("fx-canvas");
  const ctx = fxCanvas.getContext("2d");
  const puddleRipplesEl = document.getElementById("puddle-ripples");

  const startOverlay = document.getElementById("start-overlay");
  const securityNotice = document.getElementById("security-notice");
  const startMicBtn = document.getElementById("start-mic-btn");
  const startDemoBtn = document.getElementById("start-demo-btn");
  const resumePill = document.getElementById("resume-pill");

  const ambientIndicator = document.getElementById("ambient-indicator");
  const calmRing = document.getElementById("calm-ring");
  const reed1 = document.getElementById("reed-1");
  const reed2 = document.getElementById("reed-2");
  const reed3 = document.getElementById("reed-3");
  const reed4 = document.getElementById("reed-4");
  const reed5 = document.getElementById("reed-5");

  const demoBar = document.getElementById("demo-bar");
  const demoSlider = document.getElementById("demo-slider");

  const settingsBtn = document.getElementById("settings-btn");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const closeSettingsBtn = document.getElementById("close-settings-btn");
  const sensitivitySlider = document.getElementById("sensitivity-slider");
  const sensitivityVal = document.getElementById("sensitivity-val");
  const calibFill = document.getElementById("calib-fill");
  const quietTimeSlider = document.getElementById("quiet-time-slider");
  const quietTimeVal = document.getElementById("quiet-time-val");
  const demoToggle = document.getElementById("demo-toggle");

  animals.forEach((a) => {
    a.slotEl = document.getElementById(a.slotId);
    a.coverEl = document.getElementById(a.coverId);
    if (a.coverEl) {
      a.coverEl.addEventListener("animationend", (ev) => {
        if (ev.animationName === "bushRustle") {
          a.coverEl.classList.remove("is-rustling");
        }
      });
    }
  });

  // =========================================================
  // ADAPTIVE SVG CAMERA (Portrait iPhone <-> Wide Desktop)
  // =========================================================
  const camera = { vx: 0, vy: 0, vw: 1600, vh: 1200 };

  function updateCamera() {
    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    const aspect = w / h;

    // Guarantee central clearing (x: ~520..1080, y: ~480..1185) is framed up-close & cozy
    const minStageW = 540;
    const minStageH = 685;

    let vw = Math.max(minStageW, minStageH * aspect);
    let vh = vw / aspect;

    if (vw > 1520) {
      vw = 1520;
      vh = 1520 / aspect;
    }
    if (vh > 1140) {
      vh = 1140;
      vw = 1140 * aspect;
    }

    const vx = 800 - vw / 2;
    const vy = Math.max(0, Math.min(1200 - vh, 1188 - vh));

    camera.vx = vx;
    camera.vy = vy;
    camera.vw = vw;
    camera.vh = vh;

    svgEl.setAttribute("viewBox", `${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    fxCanvas.width = Math.round(w * dpr);
    fxCanvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function svgToScreen(sx, sy) {
    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    return {
      x: ((sx - camera.vx) / camera.vw) * w,
      y: ((sy - camera.vy) / camera.vh) * h
    };
  }

  window.addEventListener("resize", updateCamera);
  window.addEventListener("orientationchange", () => setTimeout(updateCamera, 120));
  updateCamera();

  // =========================================================
  // MICROPHONE & WEB AUDIO ENGINE
  // =========================================================
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let floatBuf = null;
  let byteBuf = null;

  let isStarted = false;
  let startGraceTimer = 0;
  let smoothLevel = 0;
  let wakeLockSentinel = null;

  function canUseMicrophone() {
    return Boolean(
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    );
  }

  // Show helpful German hint if opened via file:// or QuickLook without HTTPS
  if (!canUseMicrophone()) {
    securityNotice.hidden = false;
    securityNotice.innerHTML =
      "<strong>Hinweis zum Mikrofon:</strong> Browser auf dem iPhone erlauben den Mikrofonzugriff nur über eine sichere Verbindung (HTTPS / Home-Bildschirm-App), nicht direkt aus der Dateien-Vorschau. Du kannst hier sofort den <em>Demo-Modus</em> testen.";
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      if (wakeLockSentinel) return;
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
      });
    } catch (_) {
      // Non-fatal if battery saver or browser policy declines
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isStarted) {
      requestWakeLock();
      checkAudioState();
    }
  });

  function checkAudioState() {
    if (settings.demoMode || !isStarted) {
      resumePill.hidden = true;
      return;
    }
    const trackEnded =
      !micStream ||
      micStream.getAudioTracks().some((t) => t.readyState === "ended");
    const ctxSuspended =
      audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted");

    resumePill.hidden = !(trackEnded || ctxSuspended);
  }

  async function startMicrophone() {
    if (!canUseMicrophone()) {
      enableDemoMode();
      return;
    }

    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) {
        audioCtx = new AudioContextCtor();
        audioCtx.addEventListener("statechange", checkAudioState);
      }
      if (audioCtx.state !== "running") {
        await audioCtx.resume();
      }

      // Disable AGC & noiseSuppression where supported for honest room volume
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false }
          },
          video: false
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
      }
      micStream = stream;
      micStream.getAudioTracks().forEach((t) => {
        t.addEventListener("ended", checkAudioState);
      });

      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);

      if (typeof analyser.getFloatTimeDomainData === "function") {
        floatBuf = new Float32Array(analyser.fftSize);
      } else {
        byteBuf = new Uint8Array(analyser.fftSize);
      }

      settings.demoMode = false;
      demoToggle.checked = false;
      demoBar.hidden = true;
      resumePill.hidden = true;

      beginSession();
    } catch (err) {
      securityNotice.hidden = false;
      securityNotice.innerHTML =
        "<strong>Mikrofon nicht freigegeben:</strong> Bitte erlaube den Mikrofonzugriff in Safari oder nutze unten <em>Ohne Mikrofon testen</em>.";
    }
  }

  function enableDemoMode() {
    settings.demoMode = true;
    demoToggle.checked = true;
    demoBar.hidden = false;
    resumePill.hidden = true;
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    beginSession();
  }

  function beginSession() {
    isStarted = true;
    startGraceTimer = 1.1; // Ignore initial screen-tap sound
    startOverlay.classList.add("is-hidden");
    ambientIndicator.classList.add("is-visible");
    requestWakeLock();
  }

  function readRawAudioLevel() {
    if (!isStarted) return 0;

    if (settings.demoMode) {
      return Number(demoSlider.value) / 100;
    }

    if (!analyser || !audioCtx || audioCtx.state !== "running") {
      return 0;
    }

    let sumSq = 0;
    if (floatBuf) {
      analyser.getFloatTimeDomainData(floatBuf);
      for (let i = 0; i < floatBuf.length; i++) {
        const s = floatBuf[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / floatBuf.length);
      return rmsToNormalized(rms);
    } else if (byteBuf) {
      analyser.getByteTimeDomainData(byteBuf);
      for (let i = 0; i < byteBuf.length; i++) {
        const s = (byteBuf[i] - 128) / 128;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / byteBuf.length);
      return rmsToNormalized(rms);
    }
    return 0;
  }

  function rmsToNormalized(rms) {
    // Convert RMS to perceptual dBFS scale: [-54 dB .. -12 dB] -> [0 .. 1]
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    const norm = (db - -54) / (-12 - -54);
    const scaled = Math.max(0, norm) * (settings.sensitivity / 100);
    return Math.min(1, Math.max(0, scaled));
  }

  // =========================================================
  // ANIMAL SHYNESS & RECOVERY LOGIC
  // =========================================================
  function triggerRustle(coverEl) {
    if (!coverEl) return;
    coverEl.classList.remove("is-rustling");
    // Force layout recalculation on SVG element to restart animation cleanly
    void coverEl.getBoundingClientRect();
    coverEl.classList.add("is-rustling");
  }

  function setAnimalState(animal, nextState) {
    if (animal.state === nextState) return;
    const prev = animal.state;
    animal.state = nextState;
    animal.slotEl.setAttribute("data-state", nextState);

    if (
      nextState === "hidden" ||
      (prev === "hidden" && nextState === "peeking") ||
      (prev !== "visible" && nextState === "visible")
    ) {
      triggerRustle(animal.coverEl);
    }
  }

  function updateAnimals(dt, level) {
    const effectiveLevel = startGraceTimer > 0 ? Math.min(level, 0.12) : level;

    for (let i = 0; i < animals.length; i++) {
      const a = animals[i];

      if (a.state === "visible" || a.state === "alert") {
        if (effectiveLevel >= a.threshold) {
          a.loudHold += dt;
          if (a.loudHold >= 0.14) {
            a.loudHold = 0;
            a.calmProgress = 0;
            setAnimalState(a, "hidden");
          }
        } else {
          a.loudHold = Math.max(0, a.loudHold - dt * 2.5);
          setAnimalState(a, effectiveLevel >= a.alertAt ? "alert" : "visible");
        }
      } else {
        // Currently hidden or peeking
        const quietCeiling = a.threshold * 0.80;
        const scareAgain = a.threshold * 0.92;
        const neededSeconds = Math.max(2, settings.quietSeconds * a.recoveryFactor);

        if (effectiveLevel >= scareAgain) {
          a.calmProgress = effectiveLevel >= a.threshold
            ? 0
            : Math.max(0, a.calmProgress - dt * 1.6);
          if (a.state === "peeking") {
            setAnimalState(a, "hidden");
          }
        } else if (effectiveLevel < quietCeiling) {
          a.calmProgress = Math.min(1, a.calmProgress + dt / neededSeconds);
          if (a.calmProgress >= 1) {
            setAnimalState(a, "visible");
          } else if (a.calmProgress >= 0.56) {
            setAnimalState(a, "peeking");
          }
        } else {
          // Mild noise in hysteresis zone: gently pause/slip slightly
          a.calmProgress = Math.max(0, a.calmProgress - dt * 0.18);
        }
      }
    }
  }

  // =========================================================
  // ATMOSPHERIC VISUALS: PUDDLE RIPPLES, FIREFLIES & WIND LEAVES
  // =========================================================
  const ripples = [];
  let rippleCooldown = 0;

  function updatePuddleRipples(dt, level) {
    rippleCooldown -= dt;
    if (isStarted && level > 0.07 && rippleCooldown <= 0 && ripples.length < 7) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      const jitterX = (Math.random() - 0.5) * 36;
      const jitterY = (Math.random() - 0.5) * 6;
      el.setAttribute("cx", (775 + jitterX).toFixed(1));
      el.setAttribute("cy", (1096 + jitterY).toFixed(1));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#dff5ea");
      el.setAttribute("stroke-width", (1.1 + level * 1.4).toFixed(2));
      puddleRipplesEl.appendChild(el);

      ripples.push({
        el,
        age: 0,
        life: 1.5 + (1 - level) * 0.7,
        maxRx: 22 + level * 52,
        strength: Math.min(0.75, 0.22 + level * 0.65)
      });

      rippleCooldown = Math.max(0.16, 0.72 - level * 0.56);
    }

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.el.remove();
        ripples.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - t, 2);
      const rx = 4 + r.maxRx * ease;
      const ry = rx * 0.25;
      const alpha = r.strength * (1 - t);
      r.el.setAttribute("rx", rx.toFixed(1));
      r.el.setAttribute("ry", ry.toFixed(1));
      r.el.setAttribute("opacity", alpha.toFixed(2));
    }
  }

  // Fireflies (peaceful sun-motes), Cute Butterflies & Wind-blown Leaves
  const fireflies = [];
  const butterflies = [];
  const leaves = [];
  const gusts = [];

  for (let i = 0; i < 30; i++) {
    fireflies.push({
      sx: 500 + Math.random() * 600,
      sy: 340 + Math.random() * 720,
      vx: (Math.random() - 0.5) * 14,
      vy: -6 - Math.random() * 10,
      phase: Math.random() * Math.PI * 2,
      size: 2.0 + Math.random() * 2.5
    });
  }

  const butterflyPalette = [
    { upper: "#ffe066", lower: "#ffd43b" },
    { upper: "#ffb3c6", lower: "#ff8fab" },
    { upper: "#a8dadc", lower: "#89c2d9" }
  ];

  for (let i = 0; i < 3; i++) {
    butterflies.push({
      homeX: 675 + i * 115,
      homeY: 745 + (i % 2) * 115,
      sx: 675 + i * 115,
      sy: 745 + (i % 2) * 115,
      phase: i * 2.1,
      colors: butterflyPalette[i % butterflyPalette.length]
    });
  }

  const leafColors = ["#5d9451", "#7ab05c", "#b87b38", "#447849", "#c99642"];

  function renderParticles(dt, timeSec, level) {
    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    ctx.clearRect(0, 0, w, h);

    // 1. Calm Fireflies / Sun Motes (bright when quiet, scatter when loud)
    const calmFactor = Math.max(0, 1 - level * 2.1);
    if (calmFactor > 0.02) {
      for (let i = 0; i < fireflies.length; i++) {
        const f = fireflies[i];
        f.sx += (f.vx + Math.sin(timeSec * 0.9 + f.phase) * 8) * dt;
        f.sy += f.vy * dt;

        if (f.sy < 260) {
          f.sy = 1080;
          f.sx = 500 + Math.random() * 600;
        }
        if (f.sx < 460) f.sx = 1140;
        if (f.sx > 1140) f.sx = 460;

        const pos = svgToScreen(f.sx, f.sy);
        const pulse = 0.45 + 0.55 * Math.sin(timeSec * 2.2 + f.phase);
        const alpha = calmFactor * pulse * 0.78;

        const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, f.size * 4.2);
        grad.addColorStop(0, `rgba(255, 250, 185, ${alpha.toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(225, 245, 150, ${(alpha * 0.45).toFixed(3)})`);
        grad.addColorStop(1, "rgba(225, 245, 150, 0)");

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, f.size * 4.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 1b. Cute Fluttering Meadow Butterflies (glide gently when calm, hide upward when loud)
      for (let i = 0; i < butterflies.length; i++) {
        const b = butterflies[i];
        const t = timeSec * 0.65 + b.phase;
        const scareLift = Math.max(0, (1 - calmFactor) * 180);
        const targetX = b.homeX + Math.sin(t) * 65 + Math.cos(t * 1.7) * 28;
        const targetY = b.homeY + Math.cos(t * 1.3) * 38 + Math.sin(t * 2.1) * 16 - scareLift;

        b.sx += (targetX - b.sx) * Math.min(1, dt * 3.5);
        b.sy += (targetY - b.sy) * Math.min(1, dt * 3.5);

        const bp = svgToScreen(b.sx, b.sy);
        const flap = 0.25 + 0.75 * Math.abs(Math.sin(timeSec * 8.5 + b.phase));
        const bAlpha = Math.min(0.92, calmFactor * 1.05);
        const tilt = Math.cos(t) * 0.28;

        ctx.save();
        ctx.translate(bp.x, bp.y);
        ctx.rotate(tilt);
        ctx.globalAlpha = bAlpha;

        // Left & right upper wings
        ctx.fillStyle = b.colors.upper;
        ctx.beginPath();
        ctx.ellipse(-4.5 * flap, -2.5, 5.8 * flap, 4.2, -0.35, 0, Math.PI * 2);
        ctx.ellipse(4.5 * flap, -2.5, 5.8 * flap, 4.2, 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Left & right lower wings
        ctx.fillStyle = b.colors.lower;
        ctx.beginPath();
        ctx.ellipse(-3.4 * flap, 2.5, 4.2 * flap, 3.2, 0.3, 0, Math.PI * 2);
        ctx.ellipse(3.4 * flap, 2.5, 4.2 * flap, 3.2, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // Tiny body
        ctx.fillStyle = "#3d2c22";
        ctx.beginPath();
        ctx.ellipse(0, 0, 1.1, 4.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }
    }

    // 2. Calm Recovery Fireflies gathering around hiding spots
    for (let i = 0; i < animals.length; i++) {
      const a = animals[i];
      if ((a.state === "hidden" || a.state === "peeking") && a.calmProgress > 0.08) {
        const count = Math.ceil(a.calmProgress * 4);
        for (let k = 0; k < count; k++) {
          const angle = timeSec * 1.4 + k * ((Math.PI * 2) / 4) + i;
          const ox = a.spot.x + Math.cos(angle) * 28;
          const oy = a.spot.y + Math.sin(angle * 1.3) * 18 - a.calmProgress * 14;
          const p = svgToScreen(ox, oy);
          const glowAlpha = Math.min(0.85, a.calmProgress * 0.85);

          ctx.fillStyle = `rgba(246, 250, 172, ${glowAlpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 3. Wind-blown Leaves & Gust Lines when noise rises
    if (level > 0.22 && leaves.length < 28 && Math.random() < level * 0.55) {
      leaves.push({
        x: -20,
        y: Math.random() * h * 0.88,
        vx: (160 + Math.random() * 220) * (0.55 + level),
        vy: 25 + Math.random() * 55,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 8,
        w: 6 + Math.random() * 5,
        color: leafColors[(Math.random() * leafColors.length) | 0]
      });
    }

    if (level > 0.30 && gusts.length < 10 && Math.random() < level * 0.35) {
      gusts.push({
        x: -120,
        y: h * (0.18 + Math.random() * 0.68),
        len: 75 + Math.random() * 110,
        speed: 480 + level * 460,
        alpha: Math.min(0.24, (level - 0.25) * 0.35)
      });
    }

    for (let i = gusts.length - 1; i >= 0; i--) {
      const g = gusts[i];
      g.x += g.speed * dt;
      if (g.x - g.len > w + 40) {
        gusts.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `rgba(225, 242, 232, ${g.alpha.toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.quadraticCurveTo(g.x - g.len * 0.5, g.y - 6, g.x - g.len, g.y + 3);
      ctx.stroke();
    }

    for (let i = leaves.length - 1; i >= 0; i--) {
      const lf = leaves[i];
      lf.x += lf.vx * dt;
      lf.y += (lf.vy + Math.sin(timeSec * 5 + i) * 28) * dt;
      lf.rot += lf.vRot * dt;

      if (lf.x > w + 30 || lf.y > h + 30) {
        leaves.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.translate(lf.x, lf.y);
      ctx.rotate(lf.rot);
      ctx.fillStyle = lf.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, lf.w, lf.w * 0.48, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // =========================================================
  // MINIMAL HUD & ATMOSPHERE VARIABLES UPDATE
  // =========================================================
  const RING_CIRCUMFERENCE = 2 * Math.PI * 30; // r=30 -> 188.5

  function updateHudAndMood(level, timeSec) {
    const rootStyle = document.documentElement.style;
    const wind = Math.min(1, level * 1.15);
    const sunOpacity = Math.max(0.18, 0.94 - level * 0.78);
    const stormTint = Math.max(0, Math.min(0.65, (level - 0.24) * 0.85));

    rootStyle.setProperty("--wind", wind.toFixed(3));
    rootStyle.setProperty("--sun-opacity", sunOpacity.toFixed(3));
    rootStyle.setProperty("--storm-tint", stormTint.toFixed(3));

    // Acoustic reeds in top-left indicator (5 responsive bars)
    const w1 = isStarted ? 0.5 + 0.5 * Math.sin(timeSec * 3.1) : 0;
    const w2 = isStarted ? 0.5 + 0.5 * Math.sin(timeSec * 3.8 + 1.1) : 0;
    const w3 = isStarted ? 0.5 + 0.5 * Math.sin(timeSec * 3.4 + 2.2) : 0;

    const h1 = 6 + Math.min(19, level * 23 + w1 * 2.0);
    const h2 = 8 + Math.min(24, level * 30 + w2 * 2.6);
    const h3 = 10 + Math.min(27, level * 36 + w3 * 3.0);
    const h4 = 8 + Math.min(24, level * 29 + (1 - w1) * 2.6);
    const h5 = 6 + Math.min(19, level * 22 + (1 - w2) * 2.0);

    reed1.style.height = `${h1.toFixed(1)}px`;
    reed2.style.height = `${h2.toFixed(1)}px`;
    reed3.style.height = `${h3.toFixed(1)}px`;
    reed4.style.height = `${h4.toFixed(1)}px`;
    reed5.style.height = `${h5.toFixed(1)}px`;

    const isLoud = level >= animals[0].threshold;
    const isAlert = !isLoud && level >= animals[0].alertAt;
    ambientIndicator.classList.toggle("is-loud", isLoud);
    ambientIndicator.classList.toggle("is-alert", isAlert);

    // Calm recovery halo: shown when any animal is hiding/peeking
    let hiddenCount = 0;
    let progressSum = 0;
    for (let i = 0; i < animals.length; i++) {
      if (animals[i].state === "hidden" || animals[i].state === "peeking") {
        hiddenCount++;
        progressSum += animals[i].calmProgress;
      }
    }

    ambientIndicator.classList.toggle("has-hidden", hiddenCount > 0);

    if (hiddenCount > 0) {
      const avgProgress = progressSum / hiddenCount;
      const offset = RING_CIRCUMFERENCE * (1 - avgProgress);
      calmRing.style.opacity = "0.95";
      calmRing.style.strokeDashoffset = offset.toFixed(2);
    } else {
      calmRing.style.opacity = "0";
      calmRing.style.strokeDashoffset = RING_CIRCUMFERENCE.toFixed(2);
    }

    // Update calibration bar only when settings sheet is open
    if (!settingsBackdrop.hidden) {
      calibFill.style.width = `${Math.min(100, level * 100).toFixed(1)}%`;
    }
  }

  // =========================================================
  // MAIN ANIMATION LOOP
  // =========================================================
  let lastTime = performance.now();

  function tick(now) {
    const dt = Math.min(0.08, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;
    const timeSec = now / 1000;

    if (startGraceTimer > 0) {
      startGraceTimer = Math.max(0, startGraceTimer - dt);
    }

    const raw = readRawAudioLevel();
    // Fast attack for sudden claps, organic gentle release like forest wind
    const alpha = raw > smoothLevel ? 0.36 : 0.055;
    smoothLevel += (raw - smoothLevel) * alpha;
    if (smoothLevel < 0.002) smoothLevel = 0;

    if (isStarted) {
      updateAnimals(dt, smoothLevel);
    }
    updatePuddleRipples(dt, smoothLevel);
    renderParticles(dt, timeSec, smoothLevel);
    updateHudAndMood(smoothLevel, timeSec);

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  // =========================================================
  // UI CONTROLS & SETTINGS BINDINGS
  // =========================================================
  startMicBtn.addEventListener("click", () => {
    startMicrophone();
  });

  startDemoBtn.addEventListener("click", () => {
    enableDemoMode();
  });

  resumePill.addEventListener("click", () => {
    startMicrophone();
  });

  function openSettings() {
    settingsBackdrop.hidden = false;
  }

  function closeSettings() {
    settingsBackdrop.hidden = true;
  }

  settingsBtn.addEventListener("click", openSettings);
  ambientIndicator.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);

  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) {
      closeSettings();
    }
  });

  // Initialize slider UI from saved settings
  sensitivitySlider.value = String(settings.sensitivity);
  sensitivityVal.textContent = `${settings.sensitivity}%`;

  quietTimeSlider.value = String(settings.quietSeconds);
  quietTimeVal.textContent = `${settings.quietSeconds} s`;

  sensitivitySlider.addEventListener("input", () => {
    settings.sensitivity = Number(sensitivitySlider.value);
    sensitivityVal.textContent = `${settings.sensitivity}%`;
    saveSettings();
  });

  quietTimeSlider.addEventListener("input", () => {
    settings.quietSeconds = Number(quietTimeSlider.value);
    quietTimeVal.textContent = `${settings.quietSeconds} s`;
    saveSettings();
  });

  demoToggle.addEventListener("change", () => {
    if (demoToggle.checked) {
      enableDemoMode();
    } else {
      startMicrophone();
    }
  });

  // =========================================================
  // iOS HOME SCREEN ICON & OFFLINE SERVICE WORKER
  // =========================================================
  function generateAppleTouchIcon() {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 180;
        c.height = 180;
        const ic = c.getContext("2d");
        ic.drawImage(img, 0, 0, 180, 180);
        const link = document.getElementById("apple-touch-icon");
        if (link) link.href = c.toDataURL("image/png");
      } catch (_) {}
    };
    img.src = "./icon.svg";
  }
  generateAppleTouchIcon();

  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1")
  ) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
