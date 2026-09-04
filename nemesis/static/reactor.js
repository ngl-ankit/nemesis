/* ============================================================================
   NEMESIS — Reactor core (Three.js)
   A faceted hexagonal core (Ultron's eye) inside layered, counter-rotating
   holographic dial rings with tick marks, arc segments and orbiting nodes.
   Exposes window.Reactor = { setState, pulse, wake, setTheme, ready }.
   Falls back to CSS 3D rings when WebGL is unavailable or reduced motion.
   ========================================================================== */
import * as THREE from "three";

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const THEMES = {
  ultron: { a1: 0xff3b1f, a2: 0xff8a3c, a3: 0xffe9d6, c1: 0x00d2ff },
  jarvis: { a1: 0x00a8ff, a2: 0x4fe3ff, a3: 0xe6fbff, c1: 0xffb347 },
  vision: { a1: 0xffb400, a2: 0xffd45c, a3: 0xfff6dc, c1: 0xc94cff },
};

const STATES = {
  // energy 0..1 drives brightness + speed; wobble for idle tilt
  idle:      { energy: 0.32, speed: 0.55 },
  listening: { energy: 0.62, speed: 1.0 },
  thinking:  { energy: 0.85, speed: 1.9 },
  speaking:  { energy: 0.95, speed: 1.4 },
  waking:    { energy: 1.0,  speed: 3.0 },
  offline:   { energy: 0.12, speed: 0.2 },
};

const api = {
  ready: false,
  state: "idle",
  setState() {},
  pulse() {},
  wake() { return Promise.resolve(); },
  setTheme() {},
};
window.Reactor = api;

function fallback() {
  document.body.classList.add("no-webgl");
  const canvas = document.getElementById("reactor-canvas");
  if (canvas) canvas.hidden = true;
  api.wake = () => new Promise((r) => setTimeout(r, 1200));
  api.ready = true;
  document.dispatchEvent(new CustomEvent("reactor:ready"));
}

function build() {
  const canvas = document.getElementById("reactor-canvas");
  if (!canvas) return fallback();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) {
    return fallback();
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 1.6, 7.4);
  camera.lookAt(0, 0, 0);

  const root = new THREE.Group();
  scene.add(root);

  // ---- Materials (shared so theme swaps are cheap) ---------------------------
  const theme = { ...THEMES.ultron };
  const matCoreFace = new THREE.MeshStandardMaterial({
    color: 0x120806, emissive: new THREE.Color(theme.a1), emissiveIntensity: 0.9,
    metalness: 0.85, roughness: 0.25, flatShading: true,
  });
  const matCoreEdge = new THREE.LineBasicMaterial({ color: theme.a3, transparent: true, opacity: 0.85 });
  const matHot = new THREE.MeshBasicMaterial({ color: theme.a3, transparent: true, opacity: 0.95 });
  const matGlow = new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: theme.a2, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const matRingA = new THREE.LineBasicMaterial({ color: theme.a2, transparent: true, opacity: 0.75 });
  const matRingB = new THREE.LineBasicMaterial({ color: theme.c1, transparent: true, opacity: 0.55 });
  const matRingDim = new THREE.LineBasicMaterial({ color: theme.a1, transparent: true, opacity: 0.35 });
  const matNodeA = new THREE.MeshBasicMaterial({ color: theme.a3 });
  const matNodeB = new THREE.MeshBasicMaterial({ color: theme.c1 });

  // ---- Core: faceted hexagonal prism + inner icosahedron ---------------------
  const core = new THREE.Group();
  root.add(core);
  const hexGeo = new THREE.CylinderGeometry(0.78, 0.78, 0.46, 6, 1, false);
  const hex = new THREE.Mesh(hexGeo, matCoreFace);
  hex.rotation.x = Math.PI / 2;
  core.add(hex);
  core.add(new THREE.LineSegments(new THREE.EdgesGeometry(hexGeo), matCoreEdge).rotateX(Math.PI / 2));

  const innerGeo = new THREE.IcosahedronGeometry(0.42, 0);
  const inner = new THREE.Mesh(innerGeo, matHot);
  core.add(inner);
  core.add(new THREE.LineSegments(new THREE.EdgesGeometry(innerGeo), new THREE.LineBasicMaterial({ color: theme.a1, transparent: true, opacity: 0.6 })));

  const glow = new THREE.Sprite(matGlow);
  glow.scale.set(4.2, 4.2, 1);
  core.add(glow);
  const glowHot = new THREE.Sprite(new THREE.SpriteMaterial({ map: matGlow.map, color: theme.a3, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
  glowHot.scale.set(1.6, 1.6, 1);
  core.add(glowHot);

  // ---- Rings ---------------------------------------------------------------
  const rings = [];
  function ring(radius, { segments = 0, gap = 0.35, ticks = 0, tickLen = 0.08, arcs = [], material = matRingA, tiltX = 0, tiltY = 0, speed = 0.2, nodes = 0, nodeMat = matNodeA }) {
    const g = new THREE.Group();
    // base dashed circle
    const pts = [];
    const N = 180;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, 0));
    }
    if (segments) {
      // broken ring: `segments` visible arcs separated by gaps
      for (let s = 0; s < segments; s++) {
        const a0 = (s / segments) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2 / segments) * (1 - gap);
        g.add(arcLine(radius, a0, a1, material));
      }
    } else {
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
    }
    // tick marks
    if (ticks) {
      const tp = [];
      for (let i = 0; i < ticks; i++) {
        const t = (i / ticks) * Math.PI * 2;
        const len = i % 5 === 0 ? tickLen * 1.9 : tickLen;
        tp.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, 0));
        tp.push(new THREE.Vector3(Math.cos(t) * (radius + len), Math.sin(t) * (radius + len), 0));
      }
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tp), material));
    }
    // thick partial arcs (progress-like)
    arcs.forEach(([a0, a1, w]) => {
      const geo = new THREE.RingGeometry(radius - w / 2, radius + w / 2, 48, 1, a0, a1 - a0);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: material.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      g.add(m);
    });
    // orbiting nodes
    const nodeMeshes = [];
    for (let i = 0; i < nodes; i++) {
      const n = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), nodeMat);
      const t = (i / nodes) * Math.PI * 2;
      n.position.set(Math.cos(t) * radius, Math.sin(t) * radius, 0);
      g.add(n);
      nodeMeshes.push(n);
    }
    g.rotation.x = tiltX;
    g.rotation.y = tiltY;
    root.add(g);
    rings.push({ g, speed, nodes: nodeMeshes, radius, baseX: tiltX, baseY: tiltY });
    return g;
  }
  function arcLine(r, a0, a1, mat) {
    const pts = [];
    const n = Math.max(6, Math.floor((a1 - a0) * 30));
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      pts.push(new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, 0));
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  }

  // Layered rings, alternating direction/speed/tilt for depth
  ring(1.25, { ticks: 60, tickLen: 0.06, material: matRingA, speed: 0.35, arcs: [[0.2, 1.4, 0.05], [3.4, 4.1, 0.05]], nodes: 3 });
  ring(1.62, { segments: 6, gap: 0.3, material: matRingDim, speed: -0.22, tiltX: 0.18 });
  ring(1.95, { ticks: 120, tickLen: 0.045, material: matRingB, speed: 0.14, tiltX: -0.28, nodes: 2, nodeMat: matNodeB });
  ring(2.35, { segments: 3, gap: 0.55, material: matRingA, speed: -0.09, tiltX: 0.42, tiltY: 0.12, arcs: [[4.6, 5.6, 0.035]] });
  ring(2.75, { ticks: 36, tickLen: 0.1, material: matRingDim, speed: 0.06, tiltX: 0.62, nodes: 1 });
  ring(3.1, { segments: 12, gap: 0.6, material: matRingB, speed: -0.045, tiltX: -0.5, tiltY: -0.2 });

  // Hex lattice halo behind the core (thin, low opacity)
  const halo = new THREE.Group();
  const hexOutline = new THREE.EdgesGeometry(new THREE.CircleGeometry(0.34, 6));
  const haloMat = new THREE.LineBasicMaterial({ color: theme.a1, transparent: true, opacity: 0.16 });
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) {
    if (Math.abs(q + r) > 2) continue;
    const m = new THREE.LineSegments(hexOutline, haloMat);
    m.position.set((q + r / 2) * 0.62, r * 0.54, -0.9);
    halo.add(m);
  }
  root.add(halo);

  // Lights
  scene.add(new THREE.AmbientLight(0x221108, 0.8));
  const key = new THREE.PointLight(theme.a2, 2.2, 12);
  key.position.set(2, 2.5, 3);
  scene.add(key);
  const rim = new THREE.PointLight(theme.c1, 0.9, 12);
  rim.position.set(-3, -1.5, 2.5);
  scene.add(rim);

  // ---- Sizing ----------------------------------------------------------------
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas.parentElement);

  // ---- Animation state ---------------------------------------------------------
  let target = { ...STATES.idle };
  let cur = { energy: 0.0, speed: 0.4 };
  let pulseAmt = 0;           // word-boundary pulse (decays)
  let wakeT = -1;             // wake sequence progress 0..1, -1 = off
  let wakeResolve = null;
  const clock = new THREE.Clock();
  let visible = true;
  document.addEventListener("visibilitychange", () => { visible = document.visibilityState === "visible"; });

  function applyTheme(name) {
    const t = THEMES[name] || THEMES.ultron;
    Object.assign(theme, t);
    matCoreFace.emissive.set(t.a1);
    matCoreEdge.color.set(t.a3);
    matHot.color.set(t.a3);
    matGlow.color.set(t.a2);
    glowHot.material.color.set(t.a3);
    matRingA.color.set(t.a2);
    matRingB.color.set(t.c1);
    matRingDim.color.set(t.a1);
    matNodeA.color.set(t.a3);
    matNodeB.color.set(t.c1);
    haloMat.color.set(t.a1);
    key.color.set(t.a2);
    rim.color.set(t.c1);
    root.traverse((o) => {
      if (o.isMesh && o.geometry.type === "RingGeometry") o.material.color.set(o.parent === rings[2].g || o.parent === rings[5].g ? t.c1 : t.a2);
    });
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // ease toward target
    const k = 1 - Math.pow(0.001, dt); // ~fast exponential ease
    cur.energy += (target.energy - cur.energy) * k * 0.9;
    cur.speed += (target.speed - cur.speed) * k * 0.9;
    pulseAmt *= Math.pow(0.02, dt); // decay quickly

    let energy = cur.energy + pulseAmt * 0.6;
    let speed = cur.speed + pulseAmt * 1.5;

    // wake sequence: rings snap into alignment, core flares
    if (wakeT >= 0) {
      wakeT = Math.min(1, wakeT + dt / 1.3);
      const e = wakeT < 0.7 ? wakeT / 0.7 : 1 - (wakeT - 0.7) / 0.3 * 0.25;
      energy = Math.max(energy, e * 1.25);
      speed = 3.5 * (1 - wakeT) + 1;
      rings.forEach((r, i) => {
        // spin fast then converge toward base tilt
        const snap = 1 - Math.pow(1 - wakeT, 3);
        r.g.rotation.x = r.baseX + (1 - snap) * Math.sin(time * 9 + i) * 1.2;
        r.g.rotation.y = r.baseY + (1 - snap) * Math.cos(time * 7 + i) * 1.2;
      });
      if (wakeT >= 1) {
        wakeT = -1;
        if (wakeResolve) { wakeResolve(); wakeResolve = null; }
      }
    } else if (!REDUCED) {
      // idle parallax tilt
      root.rotation.x = Math.sin(time * 0.35) * 0.08;
      root.rotation.y = Math.cos(time * 0.27) * 0.12;
      rings.forEach((r, i) => {
        r.g.rotation.z += r.speed * speed * dt;
        r.g.rotation.x = r.baseX + Math.sin(time * 0.4 + i) * 0.04;
      });
    }

    // core
    if (!REDUCED || wakeT >= 0) {
      core.rotation.z += 0.25 * speed * dt;
      core.rotation.y = Math.sin(time * 0.6) * 0.35;
      inner.rotation.x += 0.9 * speed * dt;
      inner.rotation.y -= 0.6 * speed * dt;
    }
    const breathe = 1 + Math.sin(time * 2.2) * 0.03 * (REDUCED ? 0 : 1);
    const s = (0.92 + energy * 0.25 + pulseAmt * 0.18) * breathe;
    core.scale.setScalar(s);
    matCoreFace.emissiveIntensity = 0.35 + energy * 1.7;
    matHot.opacity = 0.45 + energy * 0.55;
    matGlow.opacity = 0.18 + energy * 0.5;
    glow.scale.setScalar(3.4 + energy * 1.8 + pulseAmt * 1.2);
    glowHot.material.opacity = 0.1 + energy * 0.45 + pulseAmt * 0.4;
    key.intensity = 1.0 + energy * 2.4;
    matRingA.opacity = 0.4 + energy * 0.45;
    matRingB.opacity = 0.3 + energy * 0.35;
    matRingDim.opacity = 0.2 + energy * 0.25;

    renderer.render(scene, camera);
  }
  frame();

  // ---- Public API --------------------------------------------------------------
  api.setState = (name) => {
    api.state = name;
    target = STATES[name] || STATES.idle;
    document.body.dataset.state = name;
  };
  api.pulse = (strength = 1) => { pulseAmt = Math.min(1.4, pulseAmt + 0.55 * strength); };
  api.wake = () => new Promise((resolve) => {
    wakeT = 0;
    wakeResolve = resolve;
    chime();
    api.setState("waking");
  });
  api.setTheme = applyTheme;
  api.ready = true;
  document.dispatchEvent(new CustomEvent("reactor:ready"));
}

// Radial glow sprite texture
function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(0.6, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

// Synthesized low boot chime (WebAudio; silent if blocked)
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = window.__nemesisAudio || (window.__nemesisAudio = new AC());
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.35, t0 + 0.08);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    master.connect(ctx.destination);
    [[55, "sine", 0], [110, "triangle", 0.05], [164.8, "sine", 0.3], [220, "sine", 0.55]].forEach(([f, type, delay]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f * 0.8, t0 + delay);
      o.frequency.exponentialRampToValueAtTime(f, t0 + delay + 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + delay);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + delay + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.9);
      o.connect(g).connect(master);
      o.start(t0 + delay);
      o.stop(t0 + delay + 1.0);
    });
    // noise sweep for "servo" texture
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(400, t0);
    bp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.4);
    const ng = ctx.createGain();
    ng.gain.value = 0.08;
    src.connect(bp).connect(ng).connect(master);
    src.start(t0);
  } catch (e) { /* audio blocked — visual-only wake */ }
}
window.__nemesisChime = chime;

// WebGL availability check then build
(function init() {
  try {
    const test = document.createElement("canvas");
    const gl = test.getContext("webgl2") || test.getContext("webgl");
    if (!gl) return fallback();
  } catch (e) { return fallback(); }
  try { build(); } catch (e) { console.warn("Reactor fallback:", e); fallback(); }
})();
