// Nemesis reactor — three.js core that reads live persona CSS variables.
// Exposes window.NemesisReactor = { setState, setEnergy, setVoiceLevel, dispose }
import * as THREE from 'three';

const canvas = document.getElementById('reactor-canvas');
let renderer, scene, camera, knot, halo, group;
let energy = 0.2;         // core agitation (0..1)
let voice = 0;            // live mic level (0..1)
let state = 'idle';       // idle | active | speaking | surge
let cssColor = new THREE.Color(0x7fd4ff);
let haloColor = new THREE.Color(0x7fd4ff);
let raf = 0, t = 0;
let running = false;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function readPersonaPalette() {
  cssColor.set(cssVar('--accent', '#7fd4ff'));
  haloColor.set(cssVar('--halo', '#3ea8ff'));
}

function init() {
  if (!canvas || !window.WebGLRenderingContext) return false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (e) {
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.z = 7.2;

  group = new THREE.Group();
  scene.add(group);

  knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.55, 0.34, 160, 24, 2, 3),
    new THREE.MeshStandardMaterial({
      color: cssColor, metalness: 0.85, roughness: 0.25,
      emissive: cssColor, emissiveIntensity: 0.35,
    })
  );
  group.add(knot);

  halo = new THREE.Mesh(
    new THREE.TorusGeometry(2.9, 0.045, 12, 96),
    new THREE.MeshBasicMaterial({ color: haloColor, transparent: true, opacity: 0.8 })
  );
  halo.rotation.x = Math.PI / 2.4;
  group.add(halo);

  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(3.4, 0.02, 8, 96),
    new THREE.MeshBasicMaterial({ color: haloColor, transparent: true, opacity: 0.35 })
  );
  ring2.rotation.x = Math.PI / 1.8;
  ring2.rotation.y = Math.PI / 5;
  group.add(ring2);

  group.add(new THREE.PointLight(cssColor, 14, 30));
  scene.add(new THREE.AmbientLight(0x334455, 1.2));

  resize();
  window.addEventListener('resize', resize);
  return true;
}

function resize() {
  if (!renderer) return;
  const stage = canvas.parentElement;
  const size = Math.min(stage.clientWidth, stage.clientHeight) || 320;
  renderer.setSize(size, size, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
}

function tick() {
  if (!running) return;
  raf = requestAnimationFrame(tick);
  t += 0.016;

  // Smoothly approach the live palette (persona switches blend)
  const target = new THREE.Color(cssVar('--accent', '#7fd4ff'));
  const targetHalo = new THREE.Color(cssVar('--halo', '#3ea8ff'));
  knot.material.color.lerp(target, 0.06);
  knot.material.emissive.lerp(target, 0.06);
  halo.material.color.lerp(targetHalo, 0.06);

  const agitation = state === 'surge' ? 0.9 : state === 'active' ? 0.55 : 0.2;
  energy += (agitation - energy) * 0.05;
  const pulse = 1 + 0.03 * Math.sin(t * (2 + energy * 6)) + energy * 0.05 * Math.sin(t * 11);
  const vBoost = 1 + voice * 0.35;

  group.scale.setScalar(pulse * vBoost);
  knot.rotation.x += 0.004 + energy * 0.012;
  knot.rotation.y += 0.006 + energy * 0.018;
  knot.rotation.z += 0.002 + energy * 0.006;
  halo.rotation.z += 0.002 + energy * 0.006;
  knot.material.emissiveIntensity = 0.3 + energy * 0.8 + voice * 0.6;

  renderer.render(scene, camera);
}

function start() {
  if (running || !renderer) return;
  running = true;
  tick();
}

window.NemesisReactor = {
  ready() { return !!renderer; },
  init() { return init(); },
  setState(s) { state = s; start(); },
  setEnergy(v) { energy = Math.max(energy, Math.min(1, v)); start(); },
  setVoiceLevel(v) { voice = Math.min(1, Math.max(0, v)); },
  dispose() {
    running = false;
    cancelAnimationFrame(raf);
    if (renderer) renderer.dispose();
  },
};

// Boot after DOM is ready; gracefully no-op if WebGL is unavailable.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.NemesisReactor.init());
} else {
  window.NemesisReactor.init();
}