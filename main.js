/* ============================================================================
   NEON STRIKE — main.js
   Original tactical arena FPS built with Three.js.
   Single-file game engine, organized into clearly commented sections:

     1. WebGL / bootstrap checks
     2. Global state & settings
     3. Audio engine (synthesized sound effects, Web Audio API)
     4. Scene / renderer / lighting / fog
     5. Map construction (procedural geometry + collision boxes)
     6. Weapon definitions
     7. Effects pooling (tracers, muzzle flashes, impact sparks, shells)
     8. Player controller (movement, collision, shooting, reload, recoil)
     9. Bot AI (patrol / detect / chase / attack / die / respawn)
    10. HUD + menu wiring
    11. Main game loop
   ============================================================================ */

(() => {
  "use strict";

  /* ==========================================================================
     1. WEBGL / BOOTSTRAP CHECK
     ========================================================================== */
  function hasWebGL() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext &&
        (c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { return false; }
  }
  if (!hasWebGL()) {
    document.getElementById("webgl-error").classList.remove("hidden");
    document.getElementById("main-menu").classList.add("hidden");
    return;
  }

  // The engine (Three.js) loads from a CDN <script> tag in index.html. If that request
  // is blocked (ad-blocker, offline, CDN hiccup) or hasn't finished yet, THREE will be
  // undefined and every line below would throw — silently killing the whole script
  // before any menu button ever gets wired up. Fail loudly and visibly instead.
  if (typeof THREE === "undefined") {
    const err = document.getElementById("webgl-error");
    err.querySelector("h1").textContent = "ENGINE FAILED TO LOAD";
    err.querySelector("p").textContent =
      "NEON STRIKE couldn't load its 3D engine (Three.js) from the CDN.";
    const dim = err.querySelector(".dim");
    if (dim) dim.textContent = "Check your internet connection, disable any ad-blocker/script-blocker for this page, then reload.";
    err.classList.remove("hidden");
    document.getElementById("main-menu").classList.add("hidden");
    return;
  }

  // Safety net: if anything below throws during setup (or later, inside the render
  // loop), surface it on screen instead of leaving a dead page with unresponsive
  // buttons and no explanation.
  window.addEventListener("error", (e) => {
    console.error("NEON STRIKE runtime error:", e.error || e.message);
    const err = document.getElementById("webgl-error");
    if (!err.classList.contains("hidden")) return; // already showing a fault screen
    err.querySelector("h1").textContent = "SYSTEM FAULT";
    err.querySelector("p").textContent = "NEON STRIKE hit an unexpected error and had to stop.";
    const dim = err.querySelector(".dim");
    if (dim) dim.textContent = String((e.error && e.error.message) || e.message || "Unknown error") + " — try reloading the page.";
    err.classList.remove("hidden");
  });

  try {

  /* ==========================================================================
     2. GLOBAL STATE & SETTINGS
     ========================================================================== */
  const isMobile = ("ontouchstart" in window) || navigator.maxTouchPoints > 0 ||
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) document.body.classList.add("touch-device");

  // True only while the player is in the "customize mobile HUD" drag-to-reposition
  // screen. Declared up here (not inside the mobile-controls block below) so
  // startGame()/the pause "Resume" handler can force it off as a safety net —
  // that way a stuck edit mode can never permanently disable look/fire/etc.
  let editMode = false;
  function forceExitHudEditMode() {
    editMode = false;
    document.body.classList.remove("hud-edit-mode");
    const toolbar = document.getElementById("hud-edit-toolbar");
    if (toolbar) toolbar.classList.add("hidden");
  }

  const Settings = {
    sensitivity: 8,    // 1-20
    volume: 0.6,       // 0-1
    graphics: "medium", // low|medium|high
    crosshairColor: "#00f0ff",
    skinColor: "#00f0ff",
  };

  // Customizable key bindings — every gameplay key check below reads from this
  // object (via e.code strings) rather than hardcoding a key, so rebinding one
  // action from Settings takes effect everywhere immediately, including for
  // the mobile touch buttons that drive the same logical inputs.
  const DEFAULT_BINDINGS = {
    forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD",
    jump: "Space", crouch: "ControlLeft", sprint: "ShiftLeft",
    reload: "KeyR", leanLeft: "KeyQ", leanRight: "KeyE",
    weapon1: "Digit1", weapon2: "Digit2", weapon3: "Digit3", weapon4: "Digit4", weapon5: "Digit5", weapon6: "Digit6",
    pause: "Escape", overdrive: "KeyF",
  };
  const BINDING_LABELS = {
    forward: "Move Forward", back: "Move Back", left: "Move Left", right: "Move Right",
    jump: "Jump / Climb", crouch: "Crouch", sprint: "Sprint",
    reload: "Reload", leanLeft: "Lean Left", leanRight: "Lean Right",
    weapon1: "Weapon Slot 1", weapon2: "Weapon Slot 2", weapon3: "Weapon Slot 3", weapon4: "Weapon Slot 4", weapon5: "Weapon Slot 5", weapon6: "Weapon Slot 6",
    pause: "Pause", overdrive: "Overdrive",
  };
  const KEY_DISPLAY = {
    Space: "SPACE", ControlLeft: "CTRL", ShiftLeft: "SHIFT", Escape: "ESC",
    Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6",
  };
  function keyDisplayName(code) {
    if (!code) return "—";
    if (KEY_DISPLAY[code]) return KEY_DISPLAY[code];
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
  }
  let Bindings = { ...DEFAULT_BINDINGS };
  (function loadSavedBindings() {
    try {
      const saved = JSON.parse(localStorage.getItem("neonstrike_bindings") || "null");
      if (saved) Bindings = { ...DEFAULT_BINDINGS, ...saved };
    } catch (e) { /* ignore corrupt/unavailable storage */ }
  })();
  function saveBindings() {
    try { localStorage.setItem("neonstrike_bindings", JSON.stringify(Bindings)); } catch (e) { /* ignore */ }
  }

  const Game = {
    running: false,
    paused: false,
    mode: "ffa",        // ffa | tdm | practice
    map: "gridlock",    // gridlock | foundry
    difficulty: "normal", // easy | normal | hard
    loadout: "rifle",   // rifle | smg | sniper — player's starting weapon
    matchTime: 150,      // seconds
    timeLeft: 150,
    kills: 0,
    deaths: 0,
    scoreLimit: 20,
    ended: false,
    sync: 0, overdrive: false, overdriveT: 0,
  };

  // Bot difficulty presets — tune accuracy, fire cadence, damage and move
  // speed together so each tier feels distinctly easier/harder, not just
  // "same bot, different hit chance".
  const DIFFICULTY = {
    // reactionMs controls how long a bot waits after spotting the player.
    // aimJitter reduces effective hit chance so each difficulty affects both
    // responsiveness and accuracy without ever producing NaN.
    easy:   { hitChance: 0.30, aimJitter: 0.24, reactionMs: 520, fireMin: 1300, fireMax: 2200, dmgMult: 0.70, speedMult: 0.82 },
    normal: { hitChance: 0.55, aimJitter: 0.14, reactionMs: 300, fireMin: 900,  fireMax: 1400, dmgMult: 1.00, speedMult: 1.00 },
    hard:   { hitChance: 0.78, aimJitter: 0.06, reactionMs: 140, fireMin: 550,  fireMax: 950,  dmgMult: 1.30, speedMult: 1.18 },
  };
  function currentDifficulty() { return DIFFICULTY[Game.difficulty] || DIFFICULTY.normal; }

  const clock = new THREE.Clock();

  /* ==========================================================================
     3. AUDIO ENGINE — all sound is synthesized, no external audio files.
     ========================================================================== */
  const AudioEngine = (() => {
    let ctx = null;
    function ensureCtx() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function gainNode(vol) {
      const g = ensureCtx().createGain();
      g.gain.value = vol * Settings.volume;
      g.connect(ctx.destination);
      return g;
    }
    // Generic short noise burst (used for gunshots, footsteps, impacts)
    function noiseBurst({ duration = 0.12, vol = 0.5, filterFreq = 1800, filterType = "lowpass", decay = 0.12 } = {}) {
      const c = ensureCtx();
      const bufferSize = Math.floor(c.sampleRate * duration);
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.5);
      const src = c.createBufferSource();
      src.buffer = buffer;
      const filt = c.createBiquadFilter();
      filt.type = filterType;
      filt.frequency.value = filterFreq;
      const g = c.createGain();
      g.gain.setValueAtTime(vol * Settings.volume, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + decay);
      src.connect(filt); filt.connect(g); g.connect(c.destination);
      src.start();
      src.stop(c.currentTime + duration + 0.05);
    }
    function tone(freq, { duration = 0.08, vol = 0.3, type = "square", slideTo = null } = {}) {
      const c = ensureCtx();
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, c.currentTime);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(vol * Settings.volume, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
      osc.connect(g); g.connect(c.destination);
      osc.start(); osc.stop(c.currentTime + duration + 0.02);
    }
    return {
      gunshot(weaponKey) {
        // Distinct sound per weapon: rifle = punchy mid, smg = quick crack, sniper = deep boom
        if (weaponKey === "rifle") { noiseBurst({ duration: 0.14, vol: 0.55, filterFreq: 2200, decay: 0.1 }); tone(140, { duration: 0.06, vol: 0.25, type: "sawtooth", slideTo: 60 }); }
        else if (weaponKey === "smg") { noiseBurst({ duration: 0.08, vol: 0.4, filterFreq: 3200, decay: 0.06 }); tone(220, { duration: 0.04, vol: 0.18, type: "square", slideTo: 90 }); }
        else if (weaponKey === "sniper") { noiseBurst({ duration: 0.3, vol: 0.75, filterFreq: 900, decay: 0.28 }); tone(80, { duration: 0.22, vol: 0.35, type: "sawtooth", slideTo: 30 }); }
      },
      reload() { tone(300, { duration: 0.05, vol: 0.15, type: "square" }); setTimeout(() => tone(420, { duration: 0.07, vol: 0.15, type: "square" }), 220); },
      footstep() { noiseBurst({ duration: 0.06, vol: 0.12, filterFreq: 500, decay: 0.05 }); },
      hitmarker() { tone(1200, { duration: 0.05, vol: 0.12, type: "sine" }); },
      hurt() { noiseBurst({ duration: 0.15, vol: 0.3, filterFreq: 600, decay: 0.14 }); },
      kill() { tone(600, { duration: 0.09, vol: 0.2, type: "triangle", slideTo: 900 }); },
      jump() { tone(400, { duration: 0.08, vol: 0.15, type: "sine", slideTo: 600 }); },
      land() { noiseBurst({ duration: 0.08, vol: 0.22, filterFreq: 260, decay: 0.08 }); },
      flinch() { noiseBurst({ duration: 0.05, vol: 0.18, filterFreq: 1400, decay: 0.05 }); },
      empty() { tone(160, { duration: 0.05, vol: 0.15, type: "square" }); },
      unlock() { ensureCtx(); },
    };
  })();

  /* ==========================================================================
     4. SCENE / RENDERER / LIGHTING / FOG
     ========================================================================== */
  const canvas = document.getElementById("game-canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic tone mapping + sRGB output give materials richer contrast and more
  // natural highlight roll-off than the flat linear default — a cheap but
  // noticeable visual-quality boost with no extra geometry/fragment cost.
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // Bright daytime sky + matching linear fog (fades in gradually with distance
  // rather than the old dense exponential night fog) so the arena reads as an
  // open-air daylight complex instead of a dark interior.
  scene.background = new THREE.Color(0x9fd4f0);
  scene.fog = new THREE.Fog(0xbfe4f5, 35, 150);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  const EYE_HEIGHT = 1.7, CROUCH_HEIGHT = 1.0;
  camera.position.set(0, EYE_HEIGHT, 0);

  // Weapon viewmodel rig — parented to camera so it stays in view.
  const weaponRig = new THREE.Group();
  camera.add(weaponRig);
  scene.add(camera);

  // Lighting: bright daytime sky/ground hemisphere + a strong warm sun casting
  // soft shadows; the scattered colored point lights (added per-map below)
  // still read clearly as neon accents against the daylight base.
  scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x6b5d4a, 0.85));
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.15);
  sun.position.set(40, 65, -25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -55; sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55; sun.shadow.camera.bottom = -55;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xdcefff, 0.25)); // gentle fill so shadowed faces aren't pure black

  function addAccentLight(x, y, z, color, intensity, dist) {
    const l = new THREE.PointLight(color, intensity, dist);
    l.position.set(x, y, z);
    scene.add(l);
    mapMeshes.push(l);
    return l;
  }

  /* ==========================================================================
     5. MAP CONSTRUCTION — original compact urban/sci-fi arenas.
     Two selectable original layouts (GRIDLOCK / FOUNDRY) share the same
     helper functions below; loadMap() clears whichever is currently built
     and constructs the requested one, so maps can be swapped between matches.
     ========================================================================== */
  const solidBoxes = [];   // THREE.Box3 for wall/building collision (XZ) — cleared & rebuilt per map
  const groundTops = [];   // {minX,maxX,minZ,maxZ,y} standable surfaces — cleared & rebuilt per map
  let mapMeshes = [];       // every object created for the current map, so it can be torn down cleanly

  function makeBox(w, h, d, x, y, z, color, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? 0.75, metalness: opts.metalness ?? 0.25,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    mapMeshes.push(mesh);

    if (opts.collide !== false) {
      const box = new THREE.Box3().setFromObject(mesh);
      solidBoxes.push(box);
    }
    if (opts.standable !== false) {
      groundTops.push({
        minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y: y + h / 2,
      });
    }
    return mesh;
  }

  // Emissive neon trim strip helper — purely visual accent along a box edge
  function neonStrip(w, h, d, x, y, z, color) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    mapMeshes.push(mesh);
    return mesh;
  }

  // Tears down every object belonging to the currently-built map and resets
  // the collision/standable-surface data, so a fresh map can be built in its place.
  function clearMap() {
    mapMeshes.forEach((obj) => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    mapMeshes = [];
    solidBoxes.length = 0;
    groundTops.length = 0;
  }

  function buildMapGridlock() {
    // Ground
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.95, metalness: 0.1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    mapMeshes.push(ground);
    groundTops.push({ minX: -50, maxX: 50, minZ: -50, maxZ: 50, y: 0 });

    // Floor grid accent lines (visual only)
    const grid = new THREE.GridHelper(100, 50, 0x1a5f73, 0x0d2530);
    grid.position.y = 0.01;
    scene.add(grid);
    mapMeshes.push(grid);

    // Perimeter walls
    makeBox(100, 6, 1, 0, 3, -50, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.3 });
    makeBox(100, 6, 1, 0, 3, 50, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.3 });
    makeBox(1, 6, 100, -50, 3, 0, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.3 });
    makeBox(1, 6, 100, 50, 3, 0, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.3 });

    // Central building block with corridors around it
    makeBox(14, 8, 14, 0, 4, 0, 0x1c232c, { emissive: 0x123842, emissiveIntensity: 0.25 });
    neonStrip(14.2, 0.15, 0.15, 0, 7.6, 7.05, 0x00e5ff);
    neonStrip(14.2, 0.15, 0.15, 0, 7.6, -7.05, 0xff5a00);

    // Four corner buildings
    const corners = [[-32, -32], [32, -32], [-32, 32], [32, 32]];
    corners.forEach(([x, z], i) => {
      makeBox(12, 6 + (i % 2) * 2, 12, x, (6 + (i % 2) * 2) / 2, z, 0x1a1f27, { emissive: 0x1a2f3a, emissiveIntensity: 0.2 });
    });

    // Mid cover blocks / crates scattered for sightline breaks
    const covers = [
      [10, 0, 18], [-10, 0, 18], [10, 0, -18], [-10, 0, -18],
      [22, 0, 0], [-22, 0, 0], [0, 0, 22], [0, 0, -22],
      [16, 0, 8], [-16, 0, -8],
    ];
    covers.forEach(([x, , z], i) => {
      const h = 1.4 + (i % 3) * 0.4;
      makeBox(2.4, h, 2.4, x, h / 2, z, 0x232a33, { emissive: i % 2 ? 0xff5a00 : 0x00b3cc, emissiveIntensity: 0.15 });
    });

    // Elevated platforms with ramps for verticality
    makeBox(10, 0.6, 6, 0, 4.3, 20, 0x1c2530, { emissive: 0x0a3d4a, emissiveIntensity: 0.3 }); // platform
    makeBox(10, 0.6, 6, 0, 4.3, -20, 0x1c2530, { emissive: 0x4a1a0a, emissiveIntensity: 0.3 }); // platform (opposite side)

    // Ramps (approximate as tilted boxes — collision handled as solid, standable top surface skipped for simplicity;
    // instead we add stair-stepped small boxes to approximate a ramp a player can walk up)
    for (let i = 0; i < 6; i++) {
      const stepY = 0.4 + i * 0.72;
      makeBox(3, 0.72, 1.6, -8, stepY / 2 + 0, 20 - 5 - i * 1.6, 0x1a222b, { emissive: 0x0a3d4a, emissiveIntensity: 0.2 });
    }
    for (let i = 0; i < 6; i++) {
      const stepY = 0.4 + i * 0.72;
      makeBox(3, 0.72, 1.6, 8, stepY / 2 + 0, -20 + 5 + i * 1.6, 0x1a222b, { emissive: 0x4a1a0a, emissiveIntensity: 0.2 });
    }

    // Accent point lights scattered through the arena
    addAccentLight(0, 6, 0, 0x00e5ff, 1.2, 30);
    addAccentLight(-32, 8, -32, 0xff5a00, 1.0, 22);
    addAccentLight(32, 8, 32, 0x2d8cff, 1.0, 22);
    addAccentLight(0, 6, 20, 0x00ffaa, 0.8, 18);
    addAccentLight(0, 6, -20, 0xff2d55, 0.8, 18);

    // Additional mid-map buildings for more corridor variety and cover
    makeBox(8, 5, 6, -18, 2.5, 8, 0x1b2027, { emissive: 0x0a2a33, emissiveIntensity: 0.22 });
    makeBox(8, 5, 6, 18, 2.5, -8, 0x1b2027, { emissive: 0x2a0a12, emissiveIntensity: 0.22 });
    makeBox(6, 4, 10, 18, 2, 12, 0x1a1f27, { emissive: 0x0a2a33, emissiveIntensity: 0.2 });
    makeBox(6, 4, 10, -18, 2, -12, 0x1a1f27, { emissive: 0x2a0a12, emissiveIntensity: 0.2 });

    // Connector corridor walls (creates a narrow chokepoint lane between the center and north platform)
    makeBox(0.6, 3, 14, -4, 1.5, 13, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.25 });
    makeBox(0.6, 3, 14, 4, 1.5, 13, 0x161c24, { emissive: 0x0a2a33, emissiveIntensity: 0.25 });
    makeBox(0.6, 3, 14, -4, 1.5, -13, 0x161c24, { emissive: 0x2a0a12, emissiveIntensity: 0.25 });
    makeBox(0.6, 3, 14, 4, 1.5, -13, 0x161c24, { emissive: 0x2a0a12, emissiveIntensity: 0.25 });

    // Extra scattered crates / low cover for additional sightline breaks
    const extraCovers = [
      [-18, 20], [18, -20], [26, 14], [-26, -14], [12, -28], [-12, 28], [30, 0], [-30, 0],
    ];
    extraCovers.forEach(([x, z], i) => {
      const h = 1.2 + (i % 3) * 0.3;
      makeBox(2, h, 2, x, h / 2, z, 0x232a33, { emissive: i % 2 ? 0x00b3cc : 0xff5a00, emissiveIntensity: 0.15 });
    });

    // Accent point lights for the new structures
    addAccentLight(-18, 6, 8, 0x00e5ff, 0.9, 18);
    addAccentLight(18, 6, -8, 0xff5a00, 0.9, 18);

    // Recompute solid boxes slightly shrunk vertically doesn't matter for XZ collision.
  }

  // ---- Procedural vegetation: low-cost, original foliage that adds readable
  // cover without turning the arena into a dense GPU-heavy forest.
  function addVegetation(x,z,seed=0,teamTint=null){
    const group=new THREE.Group(); group.position.set(x,0,z);
    const green=teamTint || (seed%2 ? 0x244d2c : 0x315f35);
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(0.10,0.16,1.2,6),new THREE.MeshStandardMaterial({color:0x2a1d14,roughness:1}));
    trunk.position.y=.6; group.add(trunk);
    const h=1.8+(seed%4)*0.35;
    const crown=new THREE.Mesh(new THREE.ConeGeometry(.75+(seed%3)*.12,h,6),new THREE.MeshStandardMaterial({color:green,roughness:.95}));
    crown.position.y=1.35+h*.32; crown.castShadow=true; group.add(crown);
    const low=new THREE.Mesh(new THREE.ConeGeometry(.95,.75,6),new THREE.MeshStandardMaterial({color:green,roughness:1}));
    low.position.y=.72; low.castShadow=true; group.add(low);
    scene.add(group); mapMeshes.push(group);
  }
  function scatterVegetation(points,count,spread=5,tint=null){
    for(let i=0;i<count;i++){ const p=points[i%points.length]; addVegetation(p[0]+(Math.random()-.5)*spread,p[1]+(Math.random()-.5)*spread,i,tint); }
  }

  // ---- Second original layout: FOUNDRY — an industrial cross-shaped complex with
  // tighter corridors, a raised gantry walkway, and open yards on two sides. ----
  function buildMapFoundry() {
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.95, metalness: 0.1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    mapMeshes.push(ground);
    groundTops.push({ minX: -50, maxX: 50, minZ: -50, maxZ: 50, y: 0 });

    const grid = new THREE.GridHelper(100, 50, 0x734a1a, 0x2a1c0d);
    grid.position.y = 0.01;
    scene.add(grid);
    mapMeshes.push(grid);

    // Perimeter walls
    makeBox(100, 6, 1, 0, 3, -50, 0x1e1a16, { emissive: 0x3a2410, emissiveIntensity: 0.3 });
    makeBox(100, 6, 1, 0, 3, 50, 0x1e1a16, { emissive: 0x3a2410, emissiveIntensity: 0.3 });
    makeBox(1, 6, 100, -50, 3, 0, 0x1e1a16, { emissive: 0x3a2410, emissiveIntensity: 0.3 });
    makeBox(1, 6, 100, 50, 3, 0, 0x1e1a16, { emissive: 0x3a2410, emissiveIntensity: 0.3 });

    // Cross-shaped central foundry hall: one long wing east-west, one north-south
    makeBox(34, 7, 8, 0, 3.5, 0, 0x241c16, { emissive: 0xff5a00, emissiveIntensity: 0.18 });
    makeBox(8, 7, 34, 0, 3.5, 0, 0x241c16, { emissive: 0x00b3cc, emissiveIntensity: 0.18 });
    neonStrip(34.2, 0.15, 0.15, 0, 6.9, 4.05, 0xff9500);
    neonStrip(0.15, 0.15, 34.2, 4.05, 6.9, 0, 0x00e5ff);

    // Raised gantry walkway crossing above the hall (accessible via the ramp stacks below)
    makeBox(30, 0.6, 3, 0, 5.6, 0, 0x2a2018, { emissive: 0xff9500, emissiveIntensity: 0.25 });
    for (let i = 0; i < 7; i++) {
      const stepY = 0.4 + i * 0.72;
      makeBox(2.6, 0.72, 1.6, -14 - i * 1.5, stepY / 2, -14, 0x201a14, { emissive: 0xff9500, emissiveIntensity: 0.15 });
    }
    for (let i = 0; i < 7; i++) {
      const stepY = 0.4 + i * 0.72;
      makeBox(2.6, 0.72, 1.6, 14 + i * 1.5, stepY / 2, 14, 0x201a14, { emissive: 0x00e5ff, emissiveIntensity: 0.15 });
    }

    // Four corner storage yards (open areas with low cover, different footprint from Gridlock)
    const yardCorners = [[-36, -36], [36, -36], [-36, 36], [36, 36]];
    yardCorners.forEach(([x, z], i) => {
      makeBox(10, 4 + (i % 2) * 1.5, 10, x, (4 + (i % 2) * 1.5) / 2, z, 0x1c1712, { emissive: 0x3a2410, emissiveIntensity: 0.2 });
    });

    // Corridor wings connecting the yards to the central hall
    makeBox(16, 3.4, 4, -26, 1.7, -20, 0x1a1510, { emissive: 0xff5a00, emissiveIntensity: 0.15 });
    makeBox(16, 3.4, 4, 26, 1.7, 20, 0x1a1510, { emissive: 0x00b3cc, emissiveIntensity: 0.15 });
    makeBox(4, 3.4, 16, -20, 1.7, 26, 0x1a1510, { emissive: 0xff5a00, emissiveIntensity: 0.15 });
    makeBox(4, 3.4, 16, 20, 1.7, -26, 0x1a1510, { emissive: 0x00b3cc, emissiveIntensity: 0.15 });

    // Scattered crates / drums for cover in the yards and corridors
    const crates = [
      [-36, -20], [-20, -36], [36, 20], [20, 36],
      [-10, -6], [10, 6], [-6, 10], [6, -10],
      [-30, 0], [30, 0], [0, -30], [0, 30],
      [-14, -30], [14, 30], [-30, 14], [30, -14],
    ];
    crates.forEach(([x, z], i) => {
      const h = 1.2 + (i % 3) * 0.35;
      makeBox(2, h, 2, x, h / 2, z, 0x2a2118, { emissive: i % 2 ? 0xff5a00 : 0x00b3cc, emissiveIntensity: 0.16 });
    });

    // Accent lighting
    addAccentLight(0, 6, 0, 0xff9500, 1.2, 32);
    addAccentLight(-36, 8, -36, 0xff5a00, 1.0, 22);
    addAccentLight(36, 8, 36, 0x00e5ff, 1.0, 22);
    addAccentLight(-14, 7, -14, 0xff9500, 0.8, 18);
    addAccentLight(14, 7, 14, 0x00e5ff, 0.8, 18);
    scatterVegetation([[-44,-20],[-44,20],[44,-20],[44,20],[-22,-44],[22,44]], 16, 6, 0x3d6b37);
  }

  // Spawn points split per team so, in Team Deathmatch, the player's squad
  // spawns together on one side of the map and the enemy team spawns on the
  // opposite side (Free-for-all / Practice draw from both sides combined).
  const MAP_SPAWNS = {
    gridlock: { blue:[[ -40, 0 ]], red:[[ 40, 0 ]] },
    foundry: { blue:[[ -36, -36 ]], red:[[ 36, 36 ]] },
  };
  // Patrol waypoints, similarly biased to each team's side of the map, with a
  // shared set of central points both teams contest so fights don't only
  // happen right at the spawns.
  const MAP_PATROL = {
    gridlock: {
      blue: [
        [-14, 0], [-22, -22], [-22, 22], [-10, 18], [-10, -18],
        [-30, -10], [-30, 10], [-18, -8], [-18, 8],
        [0, 0], [0, 14], [0, -14], [0, 30], [0, -30],
      ],
      red: [
        [14, 0], [22, 22], [22, -22], [10, 18], [10, -18],
        [30, 10], [30, -10], [18, 8], [18, -8],
        [0, 0], [0, 14], [0, -14], [0, 30], [0, -30],
      ],
    },
    foundry: {
      blue: [
        [-14, 0], [-36, -20], [-20, -36], [-30, 0], [-14, -30], [-30, 14], [-36, -36], [-36, 36],
        [0, 0], [0, -14], [0, 14], [0, -30], [0, 30],
      ],
      red: [
        [14, 0], [36, 20], [20, 36], [30, 0], [14, 30], [30, -14], [36, -36], [36, 36],
        [0, 0], [0, -14], [0, 14], [0, -30], [0, 30],
      ],
    },
  };

  let currentMapId = "gridlock";

  // Tears down the current map and builds the requested one, then resets the
  // spawn / patrol waypoint lists that bots and the player use for that layout.
  function loadMap(id) {
    clearMap();
    if (id === "foundry") buildMapFoundry();
    else buildMapGridlock();
    currentMapId = id;
  }
  loadMap(Game.map);

  // team: "blue" | "red" | undefined. In TDM, a team pulls only from its own
  // side; otherwise (FFA/Practice, or no team given) the full map is used.
  function randomPatrolPoint(team) {
    const mapData = MAP_PATROL[currentMapId] || MAP_PATROL.gridlock;
    const list = (Game.mode === "tdm" && (team === "blue" || team === "red"))
      ? mapData[team]
      : [...mapData.blue, ...mapData.red];
    const p = list[Math.floor(Math.random() * list.length)];
    return new THREE.Vector3(p[0] + (Math.random() - 0.5) * 4, 0, p[1] + (Math.random() - 0.5) * 4);
  }

  function randomSpawn(team) {
    const mapData = MAP_SPAWNS[currentMapId] || MAP_SPAWNS.gridlock;
    const list = (Game.mode === "tdm" && (team === "blue" || team === "red"))
      ? mapData[team]
      : [...mapData.blue, ...mapData.red];
    const p = list[Math.floor(Math.random() * list.length)];
    const jitter = Game.mode === "tdm" ? 2.2 : 0;
    return new THREE.Vector3(p[0] + (Math.random()-0.5)*jitter, 0, p[1] + (Math.random()-0.5)*jitter);
  }

  /* ==========================================================================
     6. WEAPON DEFINITIONS
     ========================================================================== */
  const WEAPONS = {
    rifle: { key:"rifle", label:"ASSAULT RIFLE", damage:34, headMult:2.0, fireRateMs:110, magSize:30, reserveMax:90, reloadTimeMs:1700, spread:0.018, adsSpread:0.006, recoilKick:0.014, automatic:true, color:0x2d8cff, muzzleColor:0x9fdcff },
    smg: { key:"smg", label:"VECTOR SMG", damage:15, headMult:1.8, fireRateMs:70, magSize:40, reserveMax:120, reloadTimeMs:1400, spread:0.03, adsSpread:0.012, recoilKick:0.009, automatic:true, color:0x39ff6a, muzzleColor:0xbfffcf },
    sniper: { key:"sniper", label:"RAILGUN SNIPER", damage:100, headMult:2.2, fireRateMs:1100, magSize:5, reserveMax:20, reloadTimeMs:2400, spread:0.002, adsSpread:0.0003, recoilKick:0.05, automatic:false, color:0xff9500, muzzleColor:0xffe0b0 },
    burst: { key:"burst", label:"VOLT BURST", damage:25, headMult:1.9, fireRateMs:180, magSize:24, reserveMax:72, reloadTimeMs:1550, spread:0.012, adsSpread:0.004, recoilKick:0.012, automatic:false, burstCount:3, color:0xb060ff, muzzleColor:0xe0c8ff },
    shotgun: { key:"shotgun", label:"BREACH-12", damage:14, headMult:1.45, fireRateMs:720, magSize:6, reserveMax:30, reloadTimeMs:1900, spread:0.085, adsSpread:0.055, recoilKick:0.045, automatic:false, pellets:7, color:0xff5a00, muzzleColor:0xffc080 },
    plasma: { key:"plasma", label:"ION PISTOL", damage:48, headMult:1.7, fireRateMs:300, magSize:12, reserveMax:48, reloadTimeMs:1250, spread:0.008, adsSpread:0.003, recoilKick:0.018, automatic:false, color:0x00f0ff, muzzleColor:0x8cffff },
  };
  const WEAPON_ORDER = ["rifle","smg","sniper","burst","shotgun","plasma"];

  // Build a simple viewmodel mesh per weapon (procedural, original design — no external assets)
  // Shared "skin" material — a colored trim/wristband on every weapon that the
  // player can recolor from Settings without affecting weapon-specific accent
  // colors (which stay tied to each gun's muzzle flash / tracer color for clarity).
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.3,
  });
  function applyPlayerSkin(hexColor) {
    skinMat.color.set(hexColor);
    skinMat.emissive.set(hexColor);
  }

  // Per-weapon color palettes, tuned to match each gun's reference art:
  // rifle = tan/desert polymer w/ holo sight, sniper = olive/black bolt-action
  // w/ scope, smg = dark-green compact bullpup w/ red dot.
  const WEAPON_PALETTE = {
    rifle:{body:0xc9b48f,dark:0x2b2b28,metal:0x57534a,lens:0x39ff6a},
    sniper:{body:0x4b5240,dark:0x1c1f18,metal:0x34372c,lens:0xffb347},
    smg:{body:0x3f5334,dark:0x181f14,metal:0x3a3a32,lens:0xff3b3b},
    burst:{body:0x25203a,dark:0x110c1e,metal:0x6f5a8f,lens:0xd9a7ff},
    shotgun:{body:0x4a2b18,dark:0x17100a,metal:0x8b5e34,lens:0xffb060},
    plasma:{body:0x12343a,dark:0x071519,metal:0x2c8791,lens:0x8cffff},
  };

  function buildViewModel(def) {
    const g = new THREE.Group();
    const pal = WEAPON_PALETTE[def.key] || WEAPON_PALETTE.rifle;
    const bodyMat = new THREE.MeshStandardMaterial({ color: pal.body, metalness: 0.3, roughness: 0.55 });
    const darkMat = new THREE.MeshStandardMaterial({ color: pal.dark, metalness: 0.5, roughness: 0.4 });
    const metalMat = new THREE.MeshStandardMaterial({ color: pal.metal, metalness: 0.85, roughness: 0.28 });
    const lensMat = new THREE.MeshBasicMaterial({ color: pal.lens });
    const accentMat = new THREE.MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.3 });

    if (def.key === "sniper") {
      // Long bolt-action-styled body with a raised scope, cheek riser and suppressor —
      // matches the green/black scoped rifle reference.
      const bodyLen = 1.05;
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.10, bodyLen), bodyMat);
      receiver.position.set(0, 0, -bodyLen / 2);
      g.add(receiver);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.12, 0.32), darkMat);
      stock.position.set(0, -0.01, 0.16);
      g.add(stock);
      const riser = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.2), darkMat);
      riser.position.set(0, 0.075, 0.04);
      g.add(riser);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.55, 8), metalMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.005, -bodyLen - 0.28);
      g.add(barrel);
      const supp = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.28, 10), darkMat);
      supp.rotation.x = Math.PI / 2;
      supp.position.set(0, 0.005, -bodyLen - 0.62);
      g.add(supp);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.32), metalMat);
      rail.position.set(0, 0.062, -0.35);
      g.add(rail);
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.36, 10), darkMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.12, -0.35);
      g.add(scope);
      const scopeLensF = new THREE.Mesh(new THREE.CircleGeometry(0.033, 10), lensMat);
      scopeLensF.position.set(0, 0.12, -0.528);
      g.add(scopeLensF);
      const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), metalMat);
      bolt.position.set(0.06, 0.03, -0.15);
      g.add(bolt);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.06), darkMat);
      grip.position.set(0, -0.11, -0.02);
      grip.rotation.x = 0.2;
      g.add(grip);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.1, 0.05), darkMat);
      mag.position.set(0, -0.09, -0.28);
      g.add(mag);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.5), accentMat);
      stripe.position.set(0, 0.045, -0.4);
      g.add(stripe);

    } else if (def.key === "smg") {
      // Compact dark-green bullpup: stock block behind the grip, short vented
      // barrel + muzzle brake, red-dot sight — matches the SMG reference.
      const bodyLen = 0.42;
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, bodyLen), bodyMat);
      receiver.position.set(0, 0, -bodyLen / 2);
      g.add(receiver);
      const stockBlock = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.14, 0.18), darkMat);
      stockBlock.position.set(0, 0, 0.09);
      g.add(stockBlock);
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.16, 8), darkMat);
      shroud.rotation.x = Math.PI / 2;
      shroud.position.set(0, 0.01, -bodyLen - 0.06);
      g.add(shroud);
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.05, 8), metalMat);
      brake.rotation.x = Math.PI / 2;
      brake.position.set(0, 0.01, -bodyLen - 0.17);
      g.add(brake);
      const sightBase = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.06), darkMat);
      sightBase.position.set(0, 0.075, -0.15);
      g.add(sightBase);
      const sightRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 10), metalMat);
      sightRing.position.set(0, 0.10, -0.15);
      g.add(sightRing);
      const sightLens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 10), lensMat);
      sightLens.position.set(0, 0.10, -0.144);
      g.add(sightLens);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.06), darkMat);
      mag.position.set(0, -0.15, -0.16);
      mag.rotation.x = -0.18;
      g.add(mag);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.065), darkMat);
      grip.position.set(0, -0.1, 0.02);
      grip.rotation.x = 0.22;
      g.add(grip);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.22), accentMat);
      stripe.position.set(0, 0.05, -0.12);
      g.add(stripe);

    } else {
      // Tan tactical carbine: holo sight, angled foregrip, laser optic and a
      // full suppressor — matches the desert-tan rifle reference.
      const bodyLen = 0.78;
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.115, bodyLen), bodyMat);
      receiver.position.set(0, 0, -bodyLen / 2);
      g.add(receiver);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.32), darkMat);
      rail.position.set(0, 0.02, -bodyLen - 0.12);
      g.add(rail);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 8), metalMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.01, -bodyLen - 0.32);
      g.add(barrel);
      const supp = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.24, 10), darkMat);
      supp.rotation.x = Math.PI / 2;
      supp.position.set(0, 0.01, -bodyLen - 0.58);
      g.add(supp);
      const sightBase = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.09), darkMat);
      sightBase.position.set(0, 0.09, -0.32);
      g.add(sightBase);
      const sightFrame = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.05, 0.012), metalMat);
      sightFrame.position.set(0, 0.125, -0.36);
      g.add(sightFrame);
      const sightLens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 10), lensMat);
      sightLens.position.set(0, 0.125, -0.353);
      g.add(sightLens);
      const laserTube = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 8), metalMat);
      laserTube.rotation.x = Math.PI / 2;
      laserTube.position.set(0.045, 0.02, -bodyLen - 0.05);
      g.add(laserTube);
      const foregrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.05), darkMat);
      foregrip.position.set(0, -0.09, -bodyLen - 0.02);
      foregrip.rotation.x = -0.35;
      g.add(foregrip);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.07), darkMat);
      grip.position.set(0, -0.12, -0.05);
      grip.rotation.x = 0.25;
      g.add(grip);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.19, 0.06), darkMat);
      mag.position.set(0, -0.14, -bodyLen * 0.35);
      mag.rotation.x = -0.1;
      g.add(mag);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, bodyLen * 0.6), accentMat);
      stripe.position.set(0, 0.05, -bodyLen / 2);
      g.add(stripe);
    }

    // Player-customizable skin trim: a small glowing band near the grip, always
    // visible regardless of weapon, so the chosen skin color reads clearly in first person.
    const skinTrim = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.025, 0.03), skinMat);
    skinTrim.position.set(0, -0.045, -0.02);
    skinTrim.rotation.x = 0.25;
    g.add(skinTrim);

    g.position.set(0.22, -0.2, -0.42);
    g.rotation.y = 0.02;
    g.userData.baseX = 0.22; g.userData.baseY = -0.2; g.userData.baseZ = -0.42;
    if (["burst","shotgun","plasma"].includes(def.key)) {
      // Distinct silhouettes: bullpup burst, drum-fed breach shotgun, compact energy pistol.
      while (g.children.length) g.remove(g.children[0]);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.11,0.13, def.key === "shotgun" ? 0.72 : 0.48), bodyMat);
      body.position.set(0,0,-0.25); g.add(body);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.10,0.22,0.12), darkMat);
      grip.position.set(0,-0.10,0.05); grip.rotation.x=0.28; g.add(grip);
      if(def.key === "burst"){
        const mag=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.20,0.10),metalMat); mag.position.set(0,-0.12,-0.16); g.add(mag);
        const sight=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.06,0.18),accentMat); sight.position.set(0,0.10,-0.18); g.add(sight);
      } else if(def.key === "shotgun"){
        const drum=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.10,12),metalMat); drum.rotation.z=Math.PI/2; drum.position.set(0,-0.10,-0.10); g.add(drum);
        const pump=new THREE.Mesh(new THREE.BoxGeometry(0.14,0.11,0.22),darkMat); pump.position.set(0,0,-0.48); g.add(pump);
      } else {
        const core=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,0.24),lensMat); core.position.set(0,0.08,-0.24); g.add(core);
        const coil=new THREE.Mesh(new THREE.TorusGeometry(0.09,0.018,6,12),accentMat); coil.rotation.x=Math.PI/2; coil.position.set(0,0,-0.44); g.add(coil);
      }
    }
    return g;
  }
  const viewModels = {};
  WEAPON_ORDER.forEach((k) => {
    const vm = buildViewModel(WEAPONS[k]);
    vm.visible = false;
    weaponRig.add(vm);
    viewModels[k] = vm;
  });

  /* ==========================================================================
     7. EFFECTS POOLING — tracers, muzzle flashes, impact sparks, shells
     ========================================================================== */
  const Effects = (() => {
    const tracerPool = [];
    const flashPool = [];
    const sparkPool = [];
    const POOL_SIZE = 24;

    for (let i = 0; i < POOL_SIZE; i++) {
      const geo = new THREE.CylinderGeometry(0.008, 0.008, 1, 5);
      geo.translate(0, 0.5, 0);
      geo.rotateX(Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      tracerPool.push({ mesh, life: 0 });
    }
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const spr = new THREE.Sprite(mat);
      spr.scale.set(0.001, 0.001, 0.001);
      camera.add(spr); // muzzle flash attaches near camera for local weapon; also reused for world sparks
      flashPool.push({ spr, life: 0, worldParent: null });
    }
    for (let i = 0; i < 40; i++) {
      const mat = new THREE.SpriteMaterial({ color: 0xffcc66, transparent: true, opacity: 0, depthWrite: false });
      const spr = new THREE.Sprite(mat);
      scene.add(spr);
      sparkPool.push({ spr, life: 0, vel: new THREE.Vector3() });
    }

    function spawnTracer(from, to, color) {
      const item = tracerPool.find((t) => t.life <= 0) || tracerPool[0];
      const dist = from.distanceTo(to);
      item.mesh.position.copy(from);
      item.mesh.lookAt(to);
      item.mesh.scale.set(1, 1, dist);
      item.mesh.material.color.set(color);
      item.mesh.material.opacity = 0.85;
      item.mesh.visible = true;
      item.life = 0.06;
    }

    function spawnMuzzleFlash(color) {
      const item = flashPool.find((f) => f.life <= 0) || flashPool[0];
      item.spr.parent === camera || camera.add(item.spr);
      item.spr.position.set(0.22, -0.14, -0.85);
      item.spr.material.color.set(color);
      item.spr.material.opacity = 1;
      item.spr.scale.set(0.28, 0.28, 0.28);
      item.life = 0.045;
    }

    function spawnImpactSpark(pos, color) {
      for (let i = 0; i < 5; i++) {
        const item = sparkPool.find((s) => s.life <= 0);
        if (!item) return;
        item.spr.position.copy(pos);
        item.spr.material.color.set(color);
        item.spr.material.opacity = 1;
        item.spr.scale.set(0.06, 0.06, 0.06);
        item.vel.set((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3);
        item.life = 0.35;
      }
    }

    function update(dt) {
      tracerPool.forEach((t) => {
        if (t.life > 0) {
          t.life -= dt;
          t.mesh.material.opacity = Math.max(0, t.life / 0.06) * 0.85;
          if (t.life <= 0) t.mesh.visible = false;
        }
      });
      flashPool.forEach((f) => {
        if (f.life > 0) {
          f.life -= dt;
          f.spr.material.opacity = Math.max(0, f.life / 0.045);
          if (f.life <= 0) f.spr.material.opacity = 0;
        }
      });
      sparkPool.forEach((s) => {
        if (s.life > 0) {
          s.life -= dt;
          s.vel.y -= 9 * dt;
          s.spr.position.addScaledVector(s.vel, dt);
          s.spr.material.opacity = Math.max(0, s.life / 0.35);
          if (s.life <= 0) s.spr.material.opacity = 0;
        }
      });
    }

    return { spawnTracer, spawnMuzzleFlash, spawnImpactSpark, update };
  })();

  /* ==========================================================================
     8. PLAYER CONTROLLER
     ========================================================================== */
  const Player = {
    pos: new THREE.Vector3(0, 0, 0),
    velY: 0,
    yaw: 0, pitch: 0,
    onGround: true,
    crouching: false,
    sprinting: false,
    aiming: false,
    health: 100, maxHealth: 100,
    armor: 50, maxArmor: 100,
    alive: true,
    team: "blue",
    currentWeaponIdx: 0,
    ammo: {}, reserve: {},
    reloading: false,
    reloadStart: 0, reloadDuration: 0,
    lastShotTime: 0,
    footstepTimer: 0,
    radius: 0.5,
    bobT: 0,
    // Ledge-climb (mantle)
    mantling: false, mantleFrom: new THREE.Vector3(), mantleTo: new THREE.Vector3(), mantleT: 0,
    // Lean / take-cover
    lean: 0, // smoothed -1 (left) .. 1 (right)
    scoped: false,
    // Animation state: idle breathing, sprint lean, jump/landing squash, hit reaction
    idlePhase: 0,
    sprintLean: 0,
    wasOnGround: true,
    landSquashT: 0,
    jumpKickT: 0,
    hitReactT: 0,
  };

  function currentWeaponKey() { return WEAPON_ORDER[Player.currentWeaponIdx]; }
  function currentWeapon() { return WEAPONS[currentWeaponKey()]; }

  function resetPlayer() {
    const sp = randomSpawn(Player.team);
    Player.pos.copy(sp);
    Player.velY = 0;
    Player.health = 100;
    Player.armor = 50;
    Player.alive = true;
    Player.crouching = false;
    Player.reloading = false;
    WEAPON_ORDER.forEach((k) => { Player.ammo[k] = WEAPONS[k].magSize; Player.reserve[k] = WEAPONS[k].reserveMax; });
    // Spawn holding whichever weapon was chosen as the loadout in the main menu.
    const loadoutIdx = WEAPON_ORDER.indexOf(Game.loadout);
    Player.currentWeaponIdx = loadoutIdx >= 0 ? loadoutIdx : 0;
    switchWeaponVisual();
  }

  const keys = {};
  let listeningForBind = null; // set while the Settings UI is waiting for a key press to rebind
  window.addEventListener("keydown", (e) => {
    if (listeningForBind) {
      e.preventDefault();
      Bindings[listeningForBind] = e.code;
      saveBindings();
      renderKeybindList();
      listeningForBind = null;
      return;
    }
    keys[e.code] = true;
    if (!Game.running || Game.paused) return;
    if (e.code === Bindings.reload) startReload();
    if (e.code === Bindings.overdrive) activateOverdrive();
    if (e.code === Bindings.weapon1) equipWeapon(0);
    if (e.code === Bindings.weapon2) equipWeapon(1);
    if (e.code === Bindings.weapon3) equipWeapon(2);
    if (e.code === Bindings.weapon4) equipWeapon(3);
    if (e.code === Bindings.weapon5) equipWeapon(4);
    if (e.code === Bindings.weapon6) equipWeapon(5);
    if (e.code === Bindings.jump) { if (!tryMantle()) tryJump(); }
  });
  window.addEventListener("keyup", (e) => { keys[e.code] = false; });

  function equipWeapon(idx) {
    if (Player.reloading) return;
    Player.currentWeaponIdx = idx;
    switchWeaponVisual();
  }
  function switchWeaponVisual() {
    WEAPON_ORDER.forEach((k, i) => viewModels[k].visible = i === Player.currentWeaponIdx);
    document.querySelectorAll(".slot").forEach((el, i) => el.classList.toggle("active", i === Player.currentWeaponIdx));
    document.getElementById("weapon-name").textContent = currentWeapon().label;
    document.getElementById("reload-indicator").classList.add("hidden");
    updateAmmoHUD();
  }

  function tryJump() {
    if (Player.onGround && Player.alive && !Player.crouching && !Player.mantling) {
      Player.velY = 5.2;
      Player.onGround = false;
      Player.jumpKickT = 1; // brief upward weapon-dip kick on takeoff, eased in updatePlayer
      AudioEngine.jump();
    }
  }

  // Ledge-climb ("mantle"): looks a short distance ahead of the player, in the
  // direction they're facing, for a standable surface (a crate, low wall, or
  // platform edge) that's higher than their feet but still within reach. If one
  // is found, the player smoothly climbs up onto it instead of just jumping.
  const MANTLE_MIN_HEIGHT = 0.35, MANTLE_MAX_HEIGHT = 1.7, MANTLE_REACH = 0.9, MANTLE_DURATION = 0.32;
  function findMantleTarget() {
    const fwd = new THREE.Vector3(-Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
    const checkPoint = Player.pos.clone().addScaledVector(fwd, MANTLE_REACH);
    for (const g of groundTops) {
      if (checkPoint.x >= g.minX && checkPoint.x <= g.maxX && checkPoint.z >= g.minZ && checkPoint.z <= g.maxZ) {
        const heightDiff = g.y - Player.pos.y;
        if (heightDiff >= MANTLE_MIN_HEIGHT && heightDiff <= MANTLE_MAX_HEIGHT) {
          return new THREE.Vector3(checkPoint.x, g.y, checkPoint.z);
        }
      }
    }
    return null;
  }
  function tryMantle() {
    if (!Player.alive || Player.mantling || !Player.onGround) return false;
    const target = findMantleTarget();
    if (!target) return false;
    Player.mantling = true;
    Player.mantleFrom.copy(Player.pos);
    Player.mantleTo.copy(target);
    Player.mantleT = 0;
    Player.velY = 0;
    AudioEngine.jump();
    return true;
  }

  function startReload() {
    const wk = currentWeaponKey();
    const w = WEAPONS[wk];
    if (Player.reloading || Player.ammo[wk] >= w.magSize || Player.reserve[wk] <= 0) return;
    Player.reloading = true;
    Player.reloadStart = performance.now();
    Player.reloadDuration = w.reloadTimeMs;
    document.getElementById("reload-indicator").classList.remove("hidden");
    AudioEngine.reload();
    Player.reloadWk = wk;
  }

  function finishReload() {
    const wk = Player.reloadWk || currentWeaponKey();
    const w = WEAPONS[wk];
    const take = Math.min(w.magSize - Player.ammo[wk], Player.reserve[wk]);
    Player.ammo[wk] += take;
    Player.reserve[wk] -= take;
    Player.reloading = false;
    document.getElementById("reload-indicator").classList.add("hidden");
    updateAmmoHUD();
  }

  function updateAmmoHUD() {
    const wk = currentWeaponKey();
    document.getElementById("ammo-mag").textContent = Player.ammo[wk];
    document.getElementById("ammo-reserve").textContent = Player.reserve[wk];
  }

  // Mouse look via pointer lock
  let mouseDown = false, rightDown = false;
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas || Game.paused || !Game.running) return;
    const sens = Settings.sensitivity * 0.0011 * (Player.scoped ? 0.35 : 1);
    Player.yaw -= e.movementX * sens;
    Player.pitch -= e.movementY * sens;
    Player.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, Player.pitch));
  });
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) rightDown = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) rightDown = false;
  });
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  function tryFire(now) {
    const wk = currentWeaponKey();
    const w = WEAPONS[wk];
    if (!Player.alive || Player.reloading) return;
    if (now - Player.lastShotTime < w.fireRateMs) return;
    if (Player.ammo[wk] <= 0) {
      // Auto-reload: an empty trigger pull starts the reload automatically
      // (if there's reserve ammo) instead of just clicking dry — R still works too.
      if (Player.reserve[wk] > 0) startReload(); else AudioEngine.empty();
      return;
    }
    Player.lastShotTime = now;
    Player.ammo[wk]--;
    updateAmmoHUD();
    AudioEngine.gunshot(wk);
    Effects.spawnMuzzleFlash(w.muzzleColor);
    applyRecoil(w);
    fireRaycast(w);
    kickViewmodel();
    // Also auto-reload the instant the mag empties from this shot, so the
    // player doesn't have to pull the trigger again on a dry chamber first.
    if (Player.ammo[wk] === 0 && Player.reserve[wk] > 0) {
      setTimeout(() => { if (!Player.reloading && currentWeaponKey() === wk && Player.ammo[wk] === 0) startReload(); }, 350);
    }
  }

  let recoilPitch = 0, recoilYaw = 0;
  function applyRecoil(w) {
    recoilPitch += w.recoilKick;
    recoilYaw += (Math.random() - 0.5) * w.recoilKick * 0.5;
  }
  function kickViewmodel() {
    const vm = viewModels[currentWeaponKey()];
    vm.position.z = vm.userData.baseZ + 0.06;
    setTimeout(() => { vm.position.z = vm.userData.baseZ; }, 60);
  }

  const raycaster = new THREE.Raycaster();
  function fireRaycast(w) {
    const spread = Player.aiming ? w.adsSpread : w.spread;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    raycaster.set(origin, dir);
    raycaster.far = 200;

    // Gather targetable meshes: hostile bots only (in TDM, teammates aren't
    // shootable — no friendly fire) plus solid world meshes.
    const targets = [];
    Bots.list.forEach((b) => {
      if (!b.alive) return;
      if (Game.mode === "tdm" && b.team === Player.team) return;
      targets.push(b.headMesh, b.bodyMesh);
    });
    const worldMeshes = scene.children.filter((c) => c.isMesh && c.geometry && c.geometry.type === "BoxGeometry" && c !== weaponRig);
    const intersects = raycaster.intersectObjects([...targets, ...worldMeshes], false);

    const end = origin.clone().addScaledVector(dir, 60);
    if (intersects.length > 0) {
      const hit = intersects[0];
      end.copy(hit.point);
      const bot = Bots.list.find((b) => b.headMesh === hit.object || b.bodyMesh === hit.object);
      if (bot) {
        const isHead = hit.object === bot.headMesh;
        const dmg = w.damage * (isHead ? w.headMult : 1) * (Game.overdrive ? 1.5 : 1);
        damageBot(bot, dmg, isHead, dir);
        showHitmarker(isHead);
        addSync(isHead ? 7 : 3);
        Effects.spawnImpactSpark(hit.point, 0xff3355);
      } else {
        Effects.spawnImpactSpark(hit.point, 0x9fdcff);
      }
    }
    Effects.spawnTracer(origin.clone().addScaledVector(dir, 0.5), end, w.muzzleColor);
  }

  function showHitmarker(isHead) {
    const hm = document.getElementById("hitmarker");
    hm.classList.remove("show"); void hm.offsetWidth; hm.classList.add("show");
    AudioEngine.hitmarker();
  }

  function damagePlayer(amount) {
    if (!Player.alive) return;
    let remaining = amount;
    if (Player.armor > 0) {
      const absorbed = Math.min(Player.armor, remaining * 0.66);
      Player.armor -= absorbed;
      remaining -= absorbed;
    }
    Player.health -= remaining;
    AudioEngine.hurt();
    flashDamage();
    Player.hitReactT = 1; // small camera punch, eased out in updatePlayer
    if (Player.health <= 0) {
      Player.health = 0;
      playerDie();
    }
  }
  function flashDamage() {
    const el = document.getElementById("damage-flash");
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 250);
  }
  function playerDie() {
    Player.alive = false;
    Player.scoped = false;
    rightDown = false;
    document.getElementById("scope-overlay").classList.remove("show");
    if (Game.overdrive) endOverdrive();
    Game.sync = Math.floor(Game.sync * 0.5); updateSyncHUD();
    Game.deaths++;
    document.getElementById("death-count").textContent = Game.deaths;
    centerMessage("ELIMINATED");
    setTimeout(() => { if (Game.running && !Game.ended) resetPlayer(); }, 2200);
  }

  // Collision: resolve movement against solidBoxes (expanded by player radius), axis-separated
  function resolveCollision(newPos) {
    const r = Player.radius;
    for (const box of solidBoxes) {
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      const minY = box.min.y, maxY = box.max.y;
      if (newPos.y + 1.8 < minY || newPos.y >= maxY - 0.15) continue; // feet on/above the top = standing on it // rough vertical gate (allow standing on platforms handled separately)
      if (newPos.x > minX && newPos.x < maxX && newPos.z > minZ && newPos.z < maxZ) {
        // push out along smallest penetration axis
        const dLeft = newPos.x - minX, dRight = maxX - newPos.x;
        const dBack = newPos.z - minZ, dFront = maxZ - newPos.z;
        const minPen = Math.min(dLeft, dRight, dBack, dFront);
        if (minPen === dLeft) newPos.x = minX;
        else if (minPen === dRight) newPos.x = maxX;
        else if (minPen === dBack) newPos.z = minZ;
        else newPos.z = maxZ;
      }
    }
    return newPos;
  }

  // Prevent the player from walking straight through enemy bots — pushes the
  // player's intended position out of any alive bot's collision radius.
  function resolvePlayerVsBots(newPos) {
    const r = Player.radius;
    Bots.list.forEach((b) => {
      if (!b.alive) return;
      const dx = newPos.x - b.group.position.x;
      const dz = newPos.z - b.group.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = r + b.radius;
      if (dist > 0.0001 && dist < minDist) {
        const push = minDist - dist;
        newPos.x += (dx / dist) * push;
        newPos.z += (dz / dist) * push;
      }
    });
    return newPos;
  }

  function groundHeightAt(x, z, prevY) {
    let best = 0;
    for (const g of groundTops) {
      if (x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ) {
        if (g.y <= prevY + 1.2 && g.y > best) best = g.y; // only "step up" onto surfaces near current level
      }
    }
    return best;
  }

  function updatePlayer(dt) {
    if (!Player.alive) return;
    if (Player.reloading && performance.now() - Player.reloadStart >= Player.reloadDuration) finishReload();
    const wasSprint = !!Player.sprinting, wasCrouch = !!Player.crouching;
    Player.crouching = !!keys[Bindings.crouch];
    Player.sprinting = !!keys[Bindings.sprint] && !Player.crouching && !!(keys[Bindings.forward] || keys[Bindings.left] || keys[Bindings.back] || keys[Bindings.right]);
    Player.aiming = rightDown && !Player.sprinting;
    // Crouch while sprinting on the ground = SLIDE (handled in the movement block)
    if (Player.crouching && !wasCrouch && wasSprint && Player.onGround && !Player.mantling) Player.slideStart = true;
    if (!Player.crouching) Player.slideT = 0;

    // recoil recovery
    recoilPitch *= Math.pow(0.9, dt * 60); recoilYaw *= Math.pow(0.85, dt * 60);
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = "YXZ";
    camera.rotation.y = Player.yaw + recoilYaw;
    camera.rotation.x = Player.pitch + recoilPitch;

    // Ledge-climb in progress: interpolate position up onto the ledge and skip
    // normal movement/gravity/collision for this frame.
    if (Player.mantling) {
      Player.mantleT += dt / MANTLE_DURATION;
      if (Player.mantleT >= 1) {
        Player.pos.copy(Player.mantleTo);
        Player.mantling = false;
        Player.onGround = true;
        Player.velY = 0;
      } else {
        const t = Player.mantleT;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        Player.pos.lerpVectors(Player.mantleFrom, Player.mantleTo, ease);
        Player.pos.y += Math.sin(Math.PI * t) * 0.15; // slight arc for a natural climb feel
      }
      camera.position.set(Player.pos.x, Player.pos.y + (Player.crouching ? CROUCH_HEIGHT : EYE_HEIGHT), Player.pos.z);
      updateHUDVitals();
      return;
    }

    // movement input
    const forward = new THREE.Vector3(Math.sin(Player.yaw), 0, -Math.cos(-Player.yaw) * -1);
    // build proper forward/right from yaw
    const fwd = new THREE.Vector3(-Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
    const right = new THREE.Vector3(Math.cos(Player.yaw), 0, -Math.sin(Player.yaw));
    let move = new THREE.Vector3();
    if (keys[Bindings.forward]) move.add(fwd);
    if (keys[Bindings.back]) move.sub(fwd);
    if (keys[Bindings.right]) move.add(right);
    if (keys[Bindings.left]) move.sub(right);
    // Mobile joystick — analog input blended in additively, only normalized if it
    // would push total magnitude over 1 so a gentle tilt still moves at partial speed.
    move.addScaledVector(fwd, -TouchInput.move.y);
    move.addScaledVector(right, TouchInput.move.x);
    if (move.length() > 1) move.normalize();

    let speed = Player.crouching ? 2.4 : Player.sprinting ? 7.2 : 4.4;
    if (Player.slideStart) {
      Player.slideStart = false;
      if (move.lengthSq() > 0.01) { Player.slideT = 0.7; Player.slideDir = move.clone().normalize(); }
    }
    if (Player.slideT > 0 && Player.onGround) {
      Player.slideT -= dt;
      const k = Math.max(0, Player.slideT / 0.7);
      move.copy(Player.slideDir);
      speed = 2.6 + 7.2 * k * k;
    } else Player.slideT = 0;
    if (Player.aiming) speed *= 0.65;

    const newPos = Player.pos.clone().addScaledVector(move, speed * dt);
    resolveCollision(newPos);
    resolvePlayerVsBots(newPos);

    // vertical
    const groundY = groundHeightAt(newPos.x, newPos.z, Player.pos.y);
    const wasOnGround = Player.onGround;
    Player.velY -= 14 * dt;
    let newY = Player.pos.y + Player.velY * dt;
    if (newY <= groundY) {
      // Landing squash: a hard enough fall (not just stepping off a curb)
      // triggers a brief downward camera/weapon dip that springs back —
      // scaled by how much downward speed we were carrying.
      if (!wasOnGround && Player.velY < -3.2) {
        Player.landSquashT = Math.min(1, -Player.velY / 10);
        AudioEngine.land();
      }
      newY = groundY; Player.velY = 0; Player.onGround = true;
    } else Player.onGround = false;

    Player.pos.set(newPos.x, newY, newPos.z);

    // footstep audio + bob
    if (move.lengthSq() > 0 && Player.onGround) {
      Player.footstepTimer -= dt;
      if (Player.footstepTimer <= 0) {
        AudioEngine.footstep();
        Player.footstepTimer = Player.sprinting ? 0.28 : Player.crouching ? 0.5 : 0.38;
      }
      Player.bobT += dt * (Player.sprinting ? 14 : 9);
    } else { Player.bobT *= 0.9; }

    // Idle breathing: while standing still, a slow gentle vertical sway so
    // the view never looks frozen between footsteps. Fades out the instant
    // movement starts so it never fights the footstep bob.
    const isMovingNow = move.lengthSq() > 0 && Player.onGround;
    Player.idlePhase += dt * (isMovingNow ? 0 : 1.1);
    const breatheY = isMovingNow ? 0 : Math.sin(Player.idlePhase) * 0.012;

    // Landing squash decays quickly back to zero after triggering above.
    Player.landSquashT = Math.max(0, Player.landSquashT - dt * 5);
    const squashY = -Player.landSquashT * 0.12;

    const targetHeight = Player.crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
    // Crouch-walk gets its own slightly slower, lower-amplitude step bob than
    // standing movement so sneaking around low cover reads differently from
    // a normal jog rather than just being a height change.
    const bobAmp = Player.crouching ? 0.018 : 0.045;
    const bobY = Math.sin(Player.bobT) * bobAmp;
    camera.position.set(Player.pos.x, Player.pos.y + targetHeight + bobY + breatheY + squashY, Player.pos.z);

    // Hit reaction: a short decaying camera micro-shake layered on top of the
    // damage vignette flash, so taking a hit has a physical, not just visual, jolt.
    if (Player.hitReactT > 0) {
      camera.position.x += (Math.random() - 0.5) * 0.02 * Player.hitReactT;
      camera.position.y += (Math.random() - 0.5) * 0.02 * Player.hitReactT;
      Player.hitReactT = Math.max(0, Player.hitReactT - dt * 4.5);
    }

    // Lean / take-cover: hold Q to lean left or E to lean right, peeking the
    // camera sideways around a corner or over low cover without exposing the
    // player's whole body — release to snap back upright.
    const leanTarget = (keys[Bindings.leanLeft] && !keys[Bindings.leanRight]) ? -1 : (keys[Bindings.leanRight] && !keys[Bindings.leanLeft]) ? 1 : 0;
    Player.lean += (leanTarget - Player.lean) * (1 - Math.pow(0.82, dt * 60));
    if (Math.abs(Player.lean) > 0.001) {
      camera.position.addScaledVector(right, Player.lean * 0.5);
      camera.position.y -= Math.abs(Player.lean) * 0.06;
    }
    camera.rotation.z = -Player.lean * 0.13;

    // Sprint lean: smoothed 0..1 toward "fully sprinting", used below to tilt
    // the weapon forward/down while running and ease back the moment the
    // player stops or starts aiming.
    Player.sprintLean += ((Player.sprinting ? 1 : 0) - Player.sprintLean) * 0.15;

    // ADS weapon offset — the sniper gets a true scope (tight zoom + reticle
    // overlay, weapon model hidden) instead of the normal hip-raised ADS.
    const vm = viewModels[currentWeaponKey()];
    const isScoped = Player.aiming && currentWeaponKey() === "sniper";
    const targetX = Player.aiming ? 0 : vm.userData.baseX;
    const targetZFov = (isScoped ? 12 : Player.aiming ? 55 : 75) + (Game.overdrive && !isScoped ? 10 : 0) + (Player.slideT > 0 ? 6 : 0);
    vm.position.x += (targetX - vm.position.x) * 0.25;
    camera.fov += (targetZFov - camera.fov) * (isScoped ? 0.35 : 0.2);
    camera.updateProjectionMatrix();
    document.getElementById("crosshair").classList.toggle("ads", Player.aiming);
    vm.visible = !isScoped;
    document.getElementById("scope-overlay").classList.toggle("show", isScoped);
    Player.scoped = isScoped;

    // Weapon vertical pose: composites reload dip, sprint-lean dip, jump
    // takeoff kick and landing squash into a single target height each frame
    // so they layer cleanly instead of fighting each other frame-to-frame.
    Player.jumpKickT = Math.max(0, Player.jumpKickT - dt * 6);
    const sprintDip = Player.sprintLean * 0.035;
    const jumpDip = Player.jumpKickT * 0.05;
    const landDip = Player.landSquashT * 0.06;
    if (Player.reloading) {
      // Reload animation: the weapon dips down and tilts as the mag comes
      // out, then rises back to its resting pose as the fresh mag seats —
      // timed to exactly match the weapon's reload duration.
      const t = Math.min(1, (performance.now() - Player.reloadStart) / Player.reloadDuration);
      const dip = Math.sin(Math.PI * t) * 0.14;
      vm.position.y = vm.userData.baseY - dip - jumpDip - landDip;
      vm.rotation.x = dip * 1.5;
    } else {
      const targetY = vm.userData.baseY - sprintDip - jumpDip - landDip;
      vm.position.y += (targetY - vm.position.y) * 0.3;
      vm.rotation.x += (0 - vm.rotation.x) * 0.3;
    }
    // Sprint lean tilts the weapon slightly as it dips, on top of the height offset above.
    vm.rotation.z += ((Player.sprintLean * 0.15) - vm.rotation.z) * 0.2;

    // fire input (auto vs semi)
    const now = performance.now();
    if (mouseDown) {
      if (currentWeapon().automatic) tryFire(now);
      else if (!Player._semiLatched) { tryFire(now); Player._semiLatched = true; }
    } else { Player._semiLatched = false; }

    updateHUDVitals();
  }

  /* ==========================================================================
     9. BOT AI
     ========================================================================== */
  const Bots = { list: [] };
  const BOT_NAMES = ["VIPER", "GHOST", "RAZOR", "NOVA", "SLATE", "ECHO", "TALON", "HAVOC"];

  // ------------------------------------------------------------------------
  // BOT ARCHETYPES — four visually and behaviourally distinct bot classes so
  // not every hostile is a palette-swap of the same model. Each type tunes
  // silhouette scale, glow colors, carried weapon and AI engagement style.
  // ------------------------------------------------------------------------
  const BOT_TYPES = {
    scout: {
      label: "SCOUT", weaponKey: "smg", scale: 0.86,
      healthMult: 0.78, speedMult: 1.3,
      bodyColor: 0x18324a, trimColor: 0x0d1c2b, visorColor: 0x00e5ff, coreColor: null,
      aggression: "balanced", cadenceMult: 0.85, dmgMult: 0.85, stealth: false, damaged: false,
    },
    breacher: {
      label: "BREACHER", weaponKey: "rifle", scale: 1.24,
      healthMult: 1.7, speedMult: 0.76,
      bodyColor: 0x3a2410, trimColor: 0x201406, visorColor: 0xff9500, coreColor: 0xff9500,
      aggression: "tank", cadenceMult: 1.1, dmgMult: 1.15, stealth: false, damaged: false,
    },
    phantom: {
      label: "PHANTOM", weaponKey: "sniper", scale: 0.96,
      healthMult: 0.85, speedMult: 1.0,
      bodyColor: 0x0d0d16, trimColor: 0x07070c, visorColor: 0xb060ff, coreColor: 0xb060ff,
      aggression: "sniper", cadenceMult: 1.6, dmgMult: 1.4, stealth: true, damaged: false,
    },
    berserk: {
      label: "BERSERK", weaponKey: "smg", scale: 1.08,
      healthMult: 1.15, speedMult: 1.45,
      bodyColor: 0x3a1010, trimColor: 0x1c0808, visorColor: 0xff2222, coreColor: 0xff2222,
      aggression: "rush", cadenceMult: 0.6, dmgMult: 1.0, stealth: false, damaged: true,
    },
  };
  const BOT_TYPE_KEYS = Object.keys(BOT_TYPES);

  function createBot(idx, team, typeKey) {
    /*
      BLOCKY CHARACTER — original NEON STRIKE design, built entirely from
      BoxGeometry so it stays lightweight with a chunky silhouette: square
      head, box torso, block limbs, boots and a carried weapon. All body
      parts sit inside a `rig` sub-group so each archetype can be scaled
      (slim scout vs. hulking breacher) around the feet without disturbing
      the floating health bar / name tag, which stay unscaled.
    */
    const typeDef = BOT_TYPES[typeKey] || BOT_TYPES.scout;
    const group = new THREE.Group();
    const rig = new THREE.Group();
    group.add(rig);
    const teamColor = team === "red" ? 0xff2d55 : 0x2d8cff;
    const visorColor = typeDef.visorColor;

    const mat = (color, emissive = 0x000000, intensity = 0) =>
      new THREE.MeshStandardMaterial({
        color, emissive, emissiveIntensity: intensity,
        roughness: 0.68, metalness: 0.08
      });

    const skinMat = mat(0xf0c7b7);
    const hairMat = mat(0x161923, 0x05060a, 0.15);
    const dressMat = mat(typeDef.bodyColor, typeDef.damaged ? visorColor : teamColor, typeDef.damaged ? 0.22 : 0.10);
    const apronMat = mat(typeDef.damaged ? 0x2a2a2a : 0xe8e7df);
    const darkMat = mat(typeDef.trimColor);
    const redMat = mat(0x8f1e32, teamColor, 0.08);
    const bootMat = mat(0x0b0d12);
    const eyeMat = new THREE.MeshBasicMaterial({ color: visorColor });
    const visorMat = new THREE.MeshBasicMaterial({ color: visorColor });
    const coreMat = typeDef.coreColor
      ? new THREE.MeshBasicMaterial({ color: typeDef.coreColor, transparent: true, opacity: 0.95 })
      : null;

    const meshes = [];

    function box(name, size, pos, material, rot = [0, 0, 0]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
      mesh.name = name;
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      rig.add(mesh);
      meshes.push(mesh);
      return mesh;
    }

    // Legs — chunky segmented silhouette.
    const legL = box("legL", [0.20, 0.62, 0.22], [-0.19, 0.58, 0], darkMat);
    const legR = box("legR", [0.20, 0.62, 0.22], [ 0.19, 0.58, 0], darkMat);

    // Checker-ish lower leg panels.
    box("sockL", [0.205, 0.25, 0.23], [-0.19, 0.31, 0], apronMat);
    box("sockR", [0.205, 0.25, 0.23], [ 0.19, 0.31, 0], apronMat);

    // Boots with a slightly oversized blocky toe.
    box("bootL", [0.25, 0.18, 0.38], [-0.19, 0.12, 0.055], bootMat);
    box("bootR", [0.25, 0.18, 0.38], [ 0.19, 0.12, 0.055], bootMat);

    // Main torso.
    const body = box("body", [0.72, 0.72, 0.40], [0, 1.20, 0], dressMat);
    box("waist", [0.62, 0.16, 0.36], [0, 0.86, 0], darkMat);
    box("skirt", [0.86, 0.30, 0.48], [0, 0.72, 0], dressMat);
    box("apron", [0.48, 0.44, 0.035], [0, 0.80, 0.245], apronMat);

    // Chest accent — a glowing power core for archetypes that have one
    // (Breacher / Phantom / Berserk), otherwise a plain ribbon (Scout).
    if (coreMat) {
      box("chestCore", [0.16, 0.20, 0.06], [0, 1.36, 0.225], coreMat);
    } else {
      box("chestRibbon", [0.18, 0.32, 0.035], [0, 1.34, 0.222], redMat);
    }
    box("belt", [0.78, 0.08, 0.42], [0, 1.00, 0], darkMat);

    // Block arms + gloves.
    const armL = box("armL", [0.18, 0.58, 0.20], [-0.48, 1.22, 0], dressMat, [0, 0, -0.08]);
    const armR = box("armR", [0.18, 0.58, 0.20], [ 0.48, 1.22, 0], dressMat, [0, 0,  0.08]);
    box("gloveL", [0.20, 0.18, 0.21], [-0.50, 0.88, 0], skinMat);
    box("gloveR", [0.20, 0.18, 0.21], [ 0.50, 0.88, 0], skinMat);

    // Square head — deliberately not a sphere.
    const head = box("head", [0.50, 0.50, 0.46], [0, 1.83, 0], skinMat);

    // Hair cap + side locks.
    box("hairCap", [0.54, 0.22, 0.49], [0, 2.06, -0.015], hairMat);
    box("hairL", [0.12, 0.48, 0.48], [-0.29, 1.86, -0.005], hairMat);
    box("hairR", [0.12, 0.48, 0.48], [ 0.29, 1.86, -0.005], hairMat);

    // Glowing eyes/visor on the front (+Z), tinted per archetype.
    box("eyeL", [0.10, 0.055, 0.025], [-0.12, 1.86, 0.242], eyeMat);
    box("eyeR", [0.10, 0.055, 0.025], [ 0.12, 1.86, 0.242], eyeMat);

    // Ears — blocky, original silhouette.
    box("earL", [0.16, 0.52, 0.14], [-0.17, 2.39, 0], hairMat, [0, 0, -0.12]);
    box("earR", [0.16, 0.52, 0.14], [ 0.17, 2.39, 0], hairMat, [0, 0,  0.12]);
    box("earInnerL", [0.07, 0.30, 0.025], [-0.17, 2.40, 0.075], redMat, [0, 0, -0.12]);
    box("earInnerR", [0.07, 0.30, 0.025], [ 0.17, 2.40, 0.075], redMat, [0, 0,  0.12]);

    // Carried weapon — proportions vary by weaponKey so an SMG, an AR and a
    // sniper rifle actually read differently in silhouette.
    let gunBarrel;
    if (typeDef.weaponKey === "sniper") {
      box("gunGrip", [0.10, 0.25, 0.10], [0.56, 0.86, 0.10], darkMat, [0.2, 0, 0]);
      box("gunBody", [0.11, 0.12, 0.58], [0.56, 0.98, 0.30], darkMat);
      box("gunScope", [0.08, 0.08, 0.16], [0.56, 1.07, 0.20], darkMat);
      gunBarrel = box("gunBarrel", [0.055, 0.055, 0.42], [0.56, 0.98, 0.72], visorMat);
    } else if (typeDef.weaponKey === "rifle") {
      box("gunGrip", [0.10, 0.25, 0.10], [0.56, 0.86, 0.13], darkMat, [0.25, 0, 0]);
      box("gunStock", [0.10, 0.12, 0.16], [0.56, 0.96, -0.02], darkMat);
      box("gunBody", [0.13, 0.14, 0.42], [0.56, 0.98, 0.26], darkMat);
      box("gunMag", [0.07, 0.16, 0.08], [0.56, 0.80, 0.18], darkMat, [0.3, 0, 0]);
      gunBarrel = box("gunBarrel", [0.075, 0.075, 0.32], [0.56, 1.00, 0.56], visorMat);
    } else {
      // smg — short and compact
      box("gunGrip", [0.10, 0.25, 0.10], [0.56, 0.86, 0.13], darkMat, [0.25, 0, 0]);
      box("gunBody", [0.12, 0.12, 0.38], [0.56, 0.96, 0.22], darkMat);
      gunBarrel = box("gunBarrel", [0.07, 0.07, 0.28], [0.56, 0.98, 0.50], visorMat);
    }

    // Team marker on the back/shoulder — keeps team identity readable even
    // though the visor/core color now encodes archetype instead.
    box("teamBadge", [0.22, 0.18, 0.025], [0, 1.40, -0.215], new THREE.MeshBasicMaterial({ color: teamColor }));

    // Scale the whole rig from the feet up — this is what makes the Breacher
    // read as hulking and the Scout as slim without hand-tuning every box.
    rig.scale.set(typeDef.scale, typeDef.scale, typeDef.scale);

    scene.add(group);

    const sp = randomSpawn(team);
    group.position.copy(sp);

    // Floating health bar — Y offset scales with archetype height so it still
    // sits just above a Breacher's taller head.
    const barGroup = new THREE.Group();
    const topY = 2.75 * typeDef.scale;
    barGroup.position.set(0, topY, 0);
    const BAR_W = 0.9, BAR_H = 0.09;

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR_W + 0.03, BAR_H + 0.03),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false })
    );
    bg.renderOrder = 998;

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR_W, BAR_H),
      new THREE.MeshBasicMaterial({
        color: team === "red" ? 0xff2d55 : 0x2d8cff,
        transparent: true, depthTest: false
      })
    );
    fill.renderOrder = 999;
    barGroup.add(bg, fill);
    group.add(barGroup);

    // Name tag — shows the archetype under the callsign so players can read
    // what they're up against at a glance.
    const nameCanvas = document.createElement("canvas");
    nameCanvas.width = 256; nameCanvas.height = 64;
    const nctx = nameCanvas.getContext("2d");
    nctx.clearRect(0, 0, 256, 64);
    nctx.font = "bold 28px Orbitron, sans-serif";
    nctx.fillStyle = team === "red" ? "#ff9aad" : "#9ac9ff";
    nctx.textAlign = "center";
    const botName = BOT_NAMES[idx % BOT_NAMES.length] + "-" + (idx + 1);
    nctx.fillText(botName, 128, 30);
    nctx.font = "bold 16px Orbitron, sans-serif";
    nctx.fillStyle = "#" + visorColor.toString(16).padStart(6, "0");
    nctx.fillText(typeDef.label, 128, 52);

    const nameTex = new THREE.CanvasTexture(nameCanvas);
    const nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthTest: false })
    );
    nameSprite.scale.set(1.1, 0.28, 1);
    nameSprite.position.set(0, topY + 0.22, 0);
    nameSprite.renderOrder = 999;
    group.add(nameSprite);

    const maxHealth = Math.round(100 * typeDef.healthMult);

    return {
      id: idx, name: botName,
      typeKey, typeDef,
      group, rig,
      bodyMesh: body,
      headMesh: head,
      legL, legR, armL, armR, gunBarrel,
      dressMat, coreMat,
      allMeshes: meshes,
      team,
      health: maxHealth, maxHealth, alive: true,
      state: "patrol",
      target: randomPatrolPoint(team),
      lastShot: 0, weapon: WEAPONS[typeDef.weaponKey] || WEAPONS.rifle,
      respawnAt: 0,
      speed: 2.6 * typeDef.speedMult * currentDifficulty().speedMult,
      radius: 0.42 * typeDef.scale,
      animPhase: Math.random() * Math.PI * 2,
      breathPhase: Math.random() * Math.PI * 2,
      flinchT: 0, recoilT: 0, leanRot: 0,
      barFill: fill, barGroup, nameSprite, BAR_W,
      lastPos: group.position.clone(),
      stuckTimer: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1,
      strafeTimer: 1.5 + Math.random() * 2,
    };
  }

  // Update a bot's floating health bar: shrink from the right, hide bar+name when dead,
  // and always billboard it to face the camera.
  function updateBotHealthBar(bot) {
    if (!bot.barGroup) return;
    bot.barGroup.visible = bot.alive;
    bot.nameSprite.visible = bot.alive;
    if (!bot.alive) return;
    const frac = Math.max(0, bot.health / bot.maxHealth);
    bot.barFill.scale.x = Math.max(0.001, frac);
    bot.barFill.position.x = -(bot.BAR_W * (1 - frac)) / 2;
    bot.barFill.material.color.set(frac > 0.5 ? (bot.team === "red" ? 0xff2d55 : 0x2d8cff) : frac > 0.25 ? 0xff9500 : 0xff2d00);
    bot.barGroup.quaternion.copy(camera.quaternion);
  }

  function damageBot(bot, dmg, isHead, shotDir) {
    if (!bot.alive) return;
    bot.health -= dmg;
    // Hit reaction: a quick flinch away from the shot direction, plus a
    // bright emissive pulse on the torso so a hit always reads clearly even
    // mid-firefight. killBot() below overrides this with the death ragdoll.
    bot.flinchT = 1;
    bot.flinchDir = shotDir ? shotDir.clone() : new THREE.Vector3(0, 0, 1);
    AudioEngine.flinch();
    if (bot.health <= 0) { bot.health = 0; killBot(bot, shotDir); }
    updateBotHealthBar(bot);
  }

  function killBot(bot, shotDir) {
    bot.alive = false;
    Game.kills++;
    document.getElementById("kill-count").textContent = Game.kills;
    addKillFeed(`YOU ELIMINATED ${bot.name}`);
    addSync(22);
    if (Game.overdrive) Game.overdriveT = Math.min(OD_DUR, Game.overdriveT + 1.2);
    AudioEngine.kill();

    // Death ragdoll/fall: the bot topples in the direction it was shot
    // (falls away from the shot), limbs splay outward as it goes down, then
    // the whole rig sinks slightly into the ground and fades out.
    const fallAxis = new THREE.Vector3(shotDir ? shotDir.z : 0, 0, shotDir ? -shotDir.x : 1).normalize();
    const fallSign = Math.random() < 0.5 ? 1 : -1;
    const startY = bot.group.position.y;
    const startPos = bot.group.position.clone();
    let t = 0;
    const anim = setInterval(() => {
      t += 0.045;
      const tt = Math.min(1, t);
      const ease = 1 - Math.pow(1 - tt, 2); // fast start, settle at the end
      // Topple onto the ground (~90°) around the fall axis, staggering a
      // step backward as it goes down for a less robotic collapse.
      bot.group.quaternion.setFromAxisAngle(fallAxis, ease * (Math.PI / 2) * fallSign);
      bot.group.position.x = startPos.x - fallAxis.z * ease * 0.5 * fallSign;
      bot.group.position.z = startPos.z + fallAxis.x * ease * 0.5 * fallSign;
      bot.group.position.y = startY - ease * 0.15;
      // Limbs splay outward as the body goes down.
      if (bot.armL) bot.armL.rotation.z = -0.08 - ease * 1.1;
      if (bot.armR) bot.armR.rotation.z = 0.08 + ease * 1.1;
      if (bot.legL) bot.legL.rotation.x = ease * 0.6;
      if (bot.legR) bot.legR.rotation.x = -ease * 0.4;
      // Fade out only after the fall has mostly settled.
      const fade = Math.max(0, (t - 0.7) / 0.3);
      const fadeMeshes = bot.allMeshes || [bot.bodyMesh, bot.headMesh];
      fadeMeshes.forEach((mesh) => {
        if (mesh && mesh.material && "opacity" in mesh.material) {
          mesh.material.opacity = Math.max(0, 1 - fade);
          mesh.material.transparent = true;
        }
      });
      if (t >= 1) { clearInterval(anim); bot.group.visible = false; }
    }, 45);
    bot.respawnAt = performance.now() + 3500;

    checkScoreLimit();
  }

  function respawnBot(bot) {
    const sp = randomSpawn(bot.team);
    bot.group.position.copy(sp);
    bot.group.position.y = 0;
    bot.group.quaternion.set(0, 0, 0, 1);
    bot.group.rotation.set(0, 0, 0);
    if (bot.armL) bot.armL.rotation.set(0, 0, -0.08);
    if (bot.armR) bot.armR.rotation.set(0, 0, 0.08);
    if (bot.legL) bot.legL.rotation.set(0, 0, 0);
    if (bot.legR) bot.legR.rotation.set(0, 0, 0);
    (bot.allMeshes || [bot.bodyMesh, bot.headMesh]).forEach((mesh) => {
      if (mesh && mesh.material && "opacity" in mesh.material) {
        mesh.material.opacity = 1;
        mesh.material.transparent = false;
      }
    });
    bot.group.visible = true;
    bot.health = bot.maxHealth;
    bot.alive = true;
    bot.state = "patrol";
    bot.flinchT = 0; bot.recoilT = 0; bot.leanRot = 0;
    bot.target.set(sp.x, 0, sp.z);
    bot.lastPos.copy(bot.group.position);
    bot.stuckTimer = 0;
    updateBotHealthBar(bot);
  }

  function spawnAllBots() {
    Bots.list.forEach((b) => scene.remove(b.group));
    Bots.list = [];
    const count = Game.mode === "practice" ? 4 : Game.mode === "tdm" ? 8 : 6;
    // Cycle through all four archetypes (shuffled) so a match always sees a
    // mix rather than clumping the same type together.
    const shuffledTypes = [...BOT_TYPE_KEYS].sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      const team = Game.mode === "tdm" ? (i % 2 === 0 ? "red" : "blue") : "red";
      const typeKey = shuffledTypes[i % shuffledTypes.length];
      Bots.list.push(createBot(i, team, typeKey));
    }
  }

  function hasLineOfSight(from, to) {
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    raycaster.set(from, dir);
    raycaster.far = dist;
    const worldMeshes = scene.children.filter((c) => c.isMesh && c.geometry && c.geometry.type === "BoxGeometry");
    const hits = raycaster.intersectObjects(worldMeshes, false);
    return hits.length === 0;
  }

  function updateBot(bot, dt, now) {
    if (!bot.alive) {
      if (now > bot.respawnAt) respawnBot(bot);
      return;
    }
    // TDM bots now understand teams: they can fight enemy bots instead of
    // tunnel-visioning the human. They still prioritize the player when visible.
    const hostileToPlayer = !(Game.mode === "tdm" && bot.team === Player.team);
    const eyePos = bot.group.position.clone().add(new THREE.Vector3(0, 1.75, 0));
    const playerPos = camera.position.clone();
    const distToPlayer = eyePos.distanceTo(playerPos);
    const canSeePlayer = hostileToPlayer && Player.alive && distToPlayer < 45 && hasLineOfSight(eyePos, playerPos);

    // Resolve player visibility before scanning enemy bots. Previously this
    // block referenced eyePos/playerPos/canSeePlayer before their declarations,
    // causing a ReferenceError during the first bot update.
    const enemyBots = Game.mode === "tdm" ? Bots.list.filter(b => b.alive && b.team !== bot.team) : [];
    let enemyTarget = null;
    let enemyDist = Infinity;
    for (const eb of enemyBots) {
      const d = bot.group.position.distanceTo(eb.group.position);
      const ebPos = eb.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      if (d < enemyDist && d < 42 && hasLineOfSight(eyePos, ebPos)) {
        enemyTarget = eb;
        enemyDist = d;
      }
    }
    if (canSeePlayer && !bot.reactAt) bot.reactAt = now + currentDifficulty().reactionMs * (0.75 + Math.random()*0.7);

    if (canSeePlayer || enemyTarget) {
      bot.state = "chase";
      bot.lastSeenPlayerAt = now;
      bot.combatTarget = canSeePlayer ? "player" : enemyTarget.id;
    } else if (bot.state === "chase" && now - (bot.lastSeenPlayerAt || 0) > 2500) {
      bot.state = "patrol";
      bot.target = randomPatrolPoint(bot.team);
    }

    let isMoving = false;
    if (bot.state === "chase") {
      const targetPos = bot.combatTarget === "player" ? playerPos : (Bots.list.find(b => b.id === bot.combatTarget)?.group.position || playerPos);
      const toPlayer = targetPos.clone().sub(bot.group.position); toPlayer.y = 0;
      const dist = toPlayer.length();
      const dir = toPlayer.clone().normalize();

      // Strafe side-to-side while engaging at combat range for less static-feeling bots;
      // close the distance if too far, back off slightly if too close. The
      // exact thresholds/strafe weight depend on the bot's archetype so a
      // Breacher holds ground, a Phantom kites at range, and a Berserk just
      // charges regardless of distance.
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) { bot.strafeDir *= -1; bot.strafeTimer = 1.2 + Math.random() * 1.8; }
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);

      const aggro = bot.typeDef.aggression;
      let farThreshold = 16, nearThreshold = 6, strafeWeight = 0.7;
      if (aggro === "tank") { farThreshold = 20; nearThreshold = 4; strafeWeight = 0.4; }
      else if (aggro === "sniper") { farThreshold = Infinity; nearThreshold = 15; strafeWeight = 0.25; }
      else if (aggro === "rush") { farThreshold = Infinity; nearThreshold = -1; strafeWeight = 0.9; }

      const moveVec = new THREE.Vector3();
      if (aggro === "rush") moveVec.add(dir);         // always closes in, never backs off
      else if (dist > farThreshold) moveVec.add(dir);  // too far: close in
      else if (dist < nearThreshold) moveVec.sub(dir); // too close: back off
      moveVec.addScaledVector(perp, bot.strafeDir * strafeWeight); // always strafe a bit
      if (moveVec.lengthSq() > 0) { moveVec.normalize(); isMoving = true; }

      bot.group.position.addScaledVector(moveVec, bot.speed * dt);
      bot.group.lookAt(targetPos.x, bot.group.position.y, targetPos.z);

      // shoot at player — cadence scales with the selected bot difficulty
      // and the archetype's own cadence multiplier (Berserk sprays fast,
      // Phantom's sniper shot is slow and deliberate).
      const diff = currentDifficulty();
      const cadenceMult = bot.typeDef.cadenceMult || 1;
      if (Game.mode !== "practice" && now >= (bot.reactAt || 0) && now - bot.lastShot > (diff.fireMin + Math.random() * (diff.fireMax - diff.fireMin)) * cadenceMult) {
        bot.lastShot = now;
        fireBotAtPlayer(bot, eyePos, targetPos, 1, targetPos !== playerPos);
      } else if (Game.mode === "practice" && now - bot.lastShot > 2200 * cadenceMult) {
        bot.lastShot = now; // practice bots shoot rarely & weakly, regardless of difficulty
        fireBotAtPlayer(bot, eyePos, playerPos, 0.3);
      }
    } else {
      // patrol toward target waypoint, with stuck-detection so bots don't idle forever
      // if a waypoint is unreachable behind geometry.
      const dir = bot.target.clone().sub(bot.group.position); dir.y = 0;
      const dist = dir.length();
      if (dist < 1.5) {
        bot.target = randomPatrolPoint(bot.team);
      } else {
        dir.normalize();
        bot.group.position.addScaledVector(dir, bot.speed * 0.55 * dt);
        bot.group.lookAt(bot.target.x, bot.group.position.y, bot.target.z);
        isMoving = true;
      }
      const movedDist = bot.group.position.distanceTo(bot.lastPos);
      if (movedDist < 0.03) {
        bot.stuckTimer += dt;
        if (bot.stuckTimer > 1.2) { bot.target = randomPatrolPoint(bot.team); bot.stuckTimer = 0; }
      } else {
        bot.stuckTimer = 0;
      }
    }

    // Phantom stealth: semi-cloaks while patrolling/unseen, and snaps back to
    // full visibility the instant it engages — a soft decloak rather than a
    // hard pop so it still reads fairly in combat.
    if (bot.typeDef.stealth) {
      const targetOpacity = bot.state === "chase" ? 1 : 0.4;
      bot.allMeshes.forEach((mesh) => {
        if (!mesh.material) return;
        mesh.material.transparent = true;
        mesh.material.opacity += (targetOpacity - mesh.material.opacity) * 0.06;
      });
    }

    bot.lastPos.copy(bot.group.position);
    resolveCollision(bot.group.position);
    animateBotLimbs(bot, dt, isMoving);
    updateBotHealthBar(bot);
  }

  // Full limb/body animation rig for bots, layered in priority order:
  // walk cycle -> idle breathing -> sprint lean -> hit-reaction flinch ->
  // firing recoil. Runs every frame for every living bot.
  function animateBotLimbs(bot, dt, moving) {
    if (!bot.legL || !bot.legR || !bot.armL || !bot.armR) return;
    const cycleSpeed = bot.state === "chase" ? 9 : 6.5;

    // Walk cycle: swings the arm/leg pairs opposite each other (marching
    // gait) while moving, and eases the limbs back to neutral when stopped.
    if (moving) {
      bot.animPhase += dt * cycleSpeed;
      const swing = Math.sin(bot.animPhase) * 0.55;
      bot.legL.rotation.x = swing;
      bot.legR.rotation.x = -swing;
      bot.armL.rotation.x = -swing * 0.75 - 0.08;
      bot.armR.rotation.x = swing * 0.75 - 0.08;
      bot.bodyMesh.position.y = 1.20 + Math.abs(Math.sin(bot.animPhase)) * 0.025;
    } else {
      bot.legL.rotation.x *= 0.85;
      bot.legR.rotation.x *= 0.85;
      bot.armL.rotation.x *= 0.85;
      bot.armR.rotation.x *= 0.85;
      bot.bodyMesh.position.y += (1.20 - bot.bodyMesh.position.y) * 0.2;
    }

    // Idle breathing: a slow chest-rise sine that never stops, so a bot
    // standing still still reads as alive rather than a frozen prop. Kept
    // subtle so it doesn't fight the walk-cycle bounce while moving.
    bot.breathPhase += dt * 1.6;
    const breathAmt = moving ? 0.006 : 0.018;
    bot.bodyMesh.scale.y = 1 + Math.sin(bot.breathPhase) * breathAmt;

    // Sprint lean: chasing bots pitch their whole rig forward, proportional
    // to how fast they're actually moving — a Berserk in full charge leans
    // harder than a cautious Breacher shuffling forward.
    const leanTarget = (bot.state === "chase" && moving) ? Math.min(0.22, bot.speed * 0.045) : 0;
    bot.leanRot += (leanTarget - bot.leanRot) * 0.12;
    bot.rig.rotation.x = bot.leanRot;

    // Hit reaction: a quick snap-back flinch that decays over ~0.35s,
    // rocking the head/torso away from the shot and briefly flashing the
    // chest accent brighter.
    if (bot.flinchT > 0) {
      bot.flinchT = Math.max(0, bot.flinchT - dt * 3.2);
      const k = bot.flinchT;
      bot.headMesh.rotation.x = -k * 0.35;
      bot.bodyMesh.rotation.x = -k * 0.15;
      if (bot.dressMat) bot.dressMat.emissiveIntensity = 0.10 + k * 1.2;
      if (bot.coreMat) bot.coreMat.opacity = 0.95 + k * 0.05;
    } else {
      bot.headMesh.rotation.x *= 0.8;
      bot.bodyMesh.rotation.x *= 0.8;
      if (bot.dressMat) bot.dressMat.emissiveIntensity = bot.typeDef.damaged ? 0.22 : 0.10;
    }

    // Firing recoil: kicks the gun arm back and flashes the barrel each time
    // the bot shoots, decaying quickly so rapid-fire archetypes (Berserk)
    // still read each individual shot.
    if (bot.recoilT > 0) {
      bot.recoilT = Math.max(0, bot.recoilT - dt * 8);
      bot.armR.rotation.x -= bot.recoilT * 0.4;
      if (bot.gunBarrel && bot.gunBarrel.material) bot.gunBarrel.material.color.setHex(0xffffff);
    } else if (bot.gunBarrel && bot.gunBarrel.material) {
      bot.gunBarrel.material.color.setHex(bot.typeDef.visorColor);
    }

    // Core pulse for damaged/glowing archetypes — a slow ambient flicker so
    // the Berserk's cracked core and Phantom/Breacher glow feel alive even
    // at rest, independent of the hit-flash above.
    if (bot.coreMat && bot.flinchT <= 0) {
      const flicker = bot.typeDef.damaged ? (0.8 + Math.random() * 0.2) : (0.9 + Math.sin(bot.breathPhase * 2) * 0.1);
      bot.coreMat.opacity = flicker;
    }
  }

  // Keep living bots from overlapping each other or standing inside the player —
  // simple circle-vs-circle separation run once per frame after all bots have moved.
  function resolveBotCollisions() {
    const alive = Bots.list.filter((b) => b.alive);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      // push apart from player
      const dxp = a.group.position.x - Player.pos.x;
      const dzp = a.group.position.z - Player.pos.z;
      const distP = Math.sqrt(dxp * dxp + dzp * dzp);
      const minDistP = a.radius + Player.radius;
      if (distP > 0.0001 && distP < minDistP) {
        const push = (minDistP - distP);
        a.group.position.x += (dxp / distP) * push;
        a.group.position.z += (dzp / distP) * push;
      }
      // push apart from other bots
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const dx = a.group.position.x - b.group.position.x;
        const dz = a.group.position.z - b.group.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const minDist = a.radius + b.radius;
        if (dist > 0.0001 && dist < minDist) {
          const push = (minDist - dist) / 2;
          a.group.position.x += (dx / dist) * push;
          a.group.position.z += (dz / dist) * push;
          b.group.position.x -= (dx / dist) * push;
          b.group.position.z -= (dz / dist) * push;
        }
      }
    }
  }

  function fireBotAtPlayer(bot, eyePos, playerPos, dmgMult = 1, botTarget = false) {
    Effects.spawnImpactSpark(eyePos.clone().addScaledVector(playerPos.clone().sub(eyePos).normalize(), 0.6), 0xff5a00);
    bot.recoilT = 1; // triggers the firing-recoil kick/flash in animateBotLimbs
    const diff = currentDifficulty();
    const jitter = diff.aimJitter * (bot.state === "chase" ? 1 : 1.25);
    const effectiveHit = Math.max(0.08, diff.hitChance - jitter * 0.55);
    if (Math.random() < effectiveHit) {
      const damage = (10 + Math.random() * 8) * dmgMult * diff.dmgMult * (bot.typeDef.dmgMult || 1);
      if (botTarget && Game.mode === "tdm") {
        const victim = Bots.list.find(b => b.alive && b.team !== bot.team && b.group.position.distanceTo(playerPos) < 2.0);
        if (victim) damageBot(victim, damage * 0.75, false, playerPos.clone().sub(eyePos).normalize());
      } else { damagePlayer(damage); }
    }
  }

  function checkScoreLimit() {
    if (Game.mode !== "practice" && Game.kills >= Game.scoreLimit) endMatch("VICTORY");
  }

  /* ==========================================================================
     10. HUD + MENU WIRING
     ========================================================================== */
  function updateHUDVitals() {
    document.getElementById("health-val").textContent = Math.ceil(Player.health);
    document.getElementById("armor-val").textContent = Math.ceil(Player.armor);
    document.getElementById("health-bar").style.width = Player.health + "%";
    document.getElementById("armor-bar").style.width = (Player.armor / Player.maxArmor) * 100 + "%";
  }

  function addKillFeed(text) {
    const feed = document.getElementById("kill-feed");
    const el = document.createElement("div");
    el.className = "kf-item";
    el.textContent = text;
    feed.appendChild(el);
    setTimeout(() => el.remove(), 3200);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
  }

  // Live "HOSTILES" roster panel — shows every bot's name, team color, health %,
  // and current AI state (patrolling / engaging / down) at a glance.
  let enemyStatusTimer = 0;
  function updateEnemyStatusHUD(dt) {
    enemyStatusTimer -= dt;
    if (enemyStatusTimer > 0) return;
    enemyStatusTimer = 0.2; // throttle DOM rebuilds to 5x/sec
    const list = document.getElementById("enemy-status-list");
    list.innerHTML = Bots.list.map((b) => {
      const pct = Math.max(0, Math.round((b.health / b.maxHealth) * 100));
      const stateIcon = !b.alive ? "☠" : b.state === "chase" ? "⚠" : "•";
      return `<div class="es-row ${b.alive ? "" : "dead"} team-${b.team}">
        <span class="es-state">${stateIcon}</span>
        <span class="es-name">${b.name}</span>
        <div class="es-bar-track"><div class="es-bar-fill" style="width:${b.alive ? pct : 0}%"></div></div>
      </div>`;
    }).join("");
  }

  function centerMessage(text) {
    const el = document.getElementById("center-msg");
    el.textContent = text;
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  }

  function formatTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // ---- Main menu ----
  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Game.mode = btn.dataset.mode;
    });
  });
  document.getElementById("btn-play").addEventListener("click", startGame);
  document.getElementById("btn-settings").addEventListener("click", () => openSettings("main-menu"));
  document.getElementById("btn-settings-back").addEventListener("click", () => closeSettings());
  document.getElementById("btn-pause-settings").addEventListener("click", () => openSettings("pause-menu"));

  let settingsReturnTo = "main-menu";
  function openSettings(returnTo) {
    settingsReturnTo = returnTo;
    document.getElementById(returnTo).classList.add("hidden");
    document.getElementById("settings-menu").classList.remove("hidden");
  }
  function closeSettings() {
    if (isMobile) forceExitHudEditMode();
    document.getElementById("settings-menu").classList.add("hidden");
    document.getElementById(settingsReturnTo).classList.remove("hidden");
  }

  // Settings controls
  function saveSettings() {
    try { localStorage.setItem("neonstrike_settings", JSON.stringify(Settings)); } catch (e) { /* ignore */ }
  }
  const sensSlider = document.getElementById("setting-sensitivity");
  sensSlider.addEventListener("input", () => { Settings.sensitivity = +sensSlider.value; document.getElementById("val-sensitivity").textContent = sensSlider.value; saveSettings(); });
  const volSlider = document.getElementById("setting-volume");
  volSlider.addEventListener("input", () => { Settings.volume = +volSlider.value / 100; document.getElementById("val-volume").textContent = volSlider.value; saveSettings(); });
  document.getElementById("setting-graphics").addEventListener("change", (e) => {
    Settings.graphics = e.target.value;
    applyGraphicsQuality();
    saveSettings();
  });
  document.querySelectorAll("#crosshair-colors .ch-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll("#crosshair-colors .ch-swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      Settings.crosshairColor = sw.dataset.color;
      document.documentElement.style.setProperty("--crosshair-color", Settings.crosshairColor);
      saveSettings();
    });
  });
  document.querySelectorAll("#skin-colors .ch-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll("#skin-colors .ch-swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      Settings.skinColor = sw.dataset.color;
      applyPlayerSkin(Settings.skinColor);
      saveSettings();
    });
  });
  // Restore any previously saved settings and reflect them in the UI.
  (function loadSavedSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem("neonstrike_settings") || "null");
      if (!saved) return;
      Object.assign(Settings, saved);
      sensSlider.value = Settings.sensitivity;
      document.getElementById("val-sensitivity").textContent = Settings.sensitivity;
      volSlider.value = Math.round(Settings.volume * 100);
      document.getElementById("val-volume").textContent = Math.round(Settings.volume * 100);
      document.getElementById("setting-graphics").value = Settings.graphics;
      document.querySelectorAll("#crosshair-colors .ch-swatch").forEach((s) => s.classList.toggle("active", s.dataset.color === Settings.crosshairColor));
      document.querySelectorAll("#skin-colors .ch-swatch").forEach((s) => s.classList.toggle("active", s.dataset.color === Settings.skinColor));
      document.documentElement.style.setProperty("--crosshair-color", Settings.crosshairColor);
      applyPlayerSkin(Settings.skinColor);
    } catch (e) { /* ignore corrupt/unavailable storage */ }
  })();
  document.querySelectorAll(".mode-btn[data-map]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn[data-map]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Game.map = btn.dataset.map;
    });
  });
  document.querySelectorAll(".mode-btn[data-difficulty]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn[data-difficulty]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Game.difficulty = btn.dataset.difficulty;
    });
  });
  document.querySelectorAll(".mode-btn[data-loadout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn[data-loadout]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Game.loadout = btn.dataset.loadout;
    });
  });

  // ---- Key bindings UI: renders one row per action; clicking a row's button
  // arms `listeningForBind`, and the next keydown anywhere (captured at the
  // top of the global keydown handler) assigns that key and re-renders. ----
  function renderKeybindList() {
    const list = document.getElementById("keybind-list");
    list.innerHTML = "";
    Object.keys(DEFAULT_BINDINGS).forEach((action) => {
      const row = document.createElement("div");
      row.className = "keybind-row";
      const label = document.createElement("span");
      label.textContent = BINDING_LABELS[action];
      const btn = document.createElement("button");
      btn.className = "keybind-btn";
      btn.textContent = keyDisplayName(Bindings[action]);
      btn.addEventListener("click", () => {
        if (listeningForBind === action) { listeningForBind = null; renderKeybindList(); return; }
        listeningForBind = action;
        renderKeybindList();
      });
      if (listeningForBind === action) { btn.classList.add("listening"); btn.textContent = "PRESS A KEY…"; }
      row.appendChild(label); row.appendChild(btn);
      list.appendChild(row);
    });
  }
  renderKeybindList();
  document.getElementById("btn-reset-binds").addEventListener("click", () => {
    Bindings = { ...DEFAULT_BINDINGS };
    saveBindings();
    listeningForBind = null;
    renderKeybindList();
  });

  function applyGraphicsQuality() {
    if (Settings.graphics === "low") {
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = false;
      scene.fog.near = 15; scene.fog.far = 90;
    } else if (Settings.graphics === "medium") {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = true;
      scene.fog.near = 35; scene.fog.far = 150;
    } else {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      scene.fog.near = 45; scene.fog.far = 180;
    }
  }

  // ---- Pause ----
  document.getElementById("btn-resume").addEventListener("click", () => {
    if (isMobile) { forceExitHudEditMode(); Game.paused = false; document.getElementById("pause-menu").classList.add("hidden"); }
    else canvas.requestPointerLock();
  });
  document.getElementById("btn-quit").addEventListener("click", quitToMenu);
  document.getElementById("btn-rematch").addEventListener("click", () => { document.getElementById("end-screen").classList.add("hidden"); startGame(); });
  document.getElementById("btn-end-menu").addEventListener("click", quitToMenu);

  function quitToMenu() {
    if (isMobile) forceExitHudEditMode();
    Game.running = false;
    Game.paused = false;
    if (Game.overdrive) endOverdrive();
    document.exitPointerLock();
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("mobile-controls").classList.add("hidden");
    document.getElementById("pause-menu").classList.add("hidden");
    document.getElementById("end-screen").classList.add("hidden");
    document.getElementById("main-menu").classList.remove("hidden");
  }

  function startGame() {
    if (isMobile) forceExitHudEditMode();
    AudioEngine.unlock();
    document.getElementById("main-menu").classList.add("hidden");
    document.getElementById("end-screen").classList.add("hidden");
    Game.running = true;
    Game.paused = false;
    Game.ended = false;
    Game.kills = 0; Game.deaths = 0;
    if (Game.overdrive) endOverdrive();
    Game.sync = 0; updateSyncHUD();
    Game.matchTime = Game.mode === "practice" ? 999999 : 150;
    Game.timeLeft = Game.matchTime;
    document.getElementById("kill-count").textContent = 0;
    document.getElementById("death-count").textContent = 0;
    document.getElementById("match-timer").textContent = Game.mode === "practice" ? "∞" : formatTime(Game.timeLeft);
    if (currentMapId !== Game.map) loadMap(Game.map);
    resetPlayer();
    spawnAllBots();
    applyGraphicsQuality();
    document.getElementById("hud").classList.remove("hidden");
    if (isMobile) {
      document.getElementById("mobile-controls").classList.remove("hidden");
    } else {
      canvas.requestPointerLock();
    }
  }

  function endMatch(title) {
    if (Game.ended) return;
    Game.ended = true;
    if (Game.overdrive) endOverdrive();
    Game.running = false;
    document.exitPointerLock();
    document.getElementById("end-title").textContent = title;
    document.getElementById("end-stats").innerHTML =
      `<div>KILLS: <b>${Game.kills}</b></div><div>DEATHS: <b>${Game.deaths}</b></div><div>MODE: <b>${Game.mode.toUpperCase()}</b></div>`;
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("mobile-controls").classList.add("hidden");
    document.getElementById("end-screen").classList.remove("hidden");
  }

  // ---- Pointer lock handling (desktop only — mobile uses touch controls & the pause button) ----
  document.addEventListener("pointerlockchange", () => {
    if (isMobile) return;
    if (document.pointerLockElement === canvas) {
      Game.paused = false;
      document.getElementById("pause-menu").classList.add("hidden");
      document.getElementById("click-prompt").classList.add("hidden");
    } else if (Game.running && !Game.ended) {
      Game.paused = true;
      document.getElementById("pause-menu").classList.remove("hidden");
    }
  });
  canvas.addEventListener("click", () => {
    if (!isMobile && Game.running && !Game.paused && document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === Bindings.pause && Game.running) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
  });

  /* ==========================================================================
     11.5 MOBILE / TOUCH CONTROLS
     A virtual joystick drives movement, a full-screen drag zone drives look,
     and on-screen buttons map straight onto the same `keys` object / functions
     the keyboard uses — so no gameplay logic is duplicated for touch.
     ========================================================================== */
  const TouchInput = { move: { x: 0, y: 0 } };

  if (isMobile) {
    // (editMode itself is declared up in section 2, near isMobile, so both
    // this setup block and startGame()/Resume can see and reset it.)

    // ---- Movement joystick (identifier-tracked so it doesn't fight the look drag) ----
    const joystickBase = document.getElementById("touch-joystick");
    const joystickKnob = document.getElementById("joystick-knob");
    let joyTouchId = null, joyCenter = { x: 0, y: 0 };
    const JOY_RADIUS = 50;

    joystickBase.addEventListener("touchstart", (e) => {
      if (editMode) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      joyTouchId = t.identifier;
      const rect = joystickBase.getBoundingClientRect();
      joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, { passive: false });

    function handleJoyMove(e) {
      if (editMode || joyTouchId === null) return;
      const t = [...e.changedTouches].find((t) => t.identifier === joyTouchId);
      if (!t) return;
      e.preventDefault();
      let dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
      const dist = Math.min(Math.hypot(dx, dy), JOY_RADIUS);
      const ang = Math.atan2(dy, dx);
      dx = Math.cos(ang) * dist; dy = Math.sin(ang) * dist;
      joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      TouchInput.move.x = dx / JOY_RADIUS;
      TouchInput.move.y = dy / JOY_RADIUS;
    }
    function handleJoyEnd(e) {
      const t = [...e.changedTouches].find((t) => t.identifier === joyTouchId);
      if (!t) return;
      joyTouchId = null;
      TouchInput.move.x = 0; TouchInput.move.y = 0;
      joystickKnob.style.transform = "translate(0,0)";
    }
    window.addEventListener("touchmove", handleJoyMove, { passive: false });
    window.addEventListener("touchend", handleJoyEnd);
    window.addEventListener("touchcancel", handleJoyEnd);

    // ---- Drag-to-look (full-screen zone beneath the buttons/joystick) ----
    const lookZone = document.getElementById("touch-look-zone");
    let lookTouchId = null, lastLookX = 0, lastLookY = 0;
    lookZone.addEventListener("touchstart", (e) => {
      if (editMode || lookTouchId !== null || !Game.running || Game.paused) return;
      const t = e.changedTouches[0];
      lookTouchId = t.identifier;
      lastLookX = t.clientX; lastLookY = t.clientY;
    }, { passive: true });
    lookZone.addEventListener("touchmove", (e) => {
      if (editMode || lookTouchId === null) return;
      const t = [...e.changedTouches].find((t) => t.identifier === lookTouchId);
      if (!t) return;
      const dx = t.clientX - lastLookX, dy = t.clientY - lastLookY;
      lastLookX = t.clientX; lastLookY = t.clientY;
      if (!Game.running || Game.paused) return;
      const sens = Settings.sensitivity * 0.0016 * (Player.scoped ? 0.35 : 1);
      Player.yaw -= dx * sens;
      Player.pitch -= dy * sens;
      Player.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, Player.pitch));
    }, { passive: true });
    function endLook(e) {
      const t = [...e.changedTouches].find((t) => t.identifier === lookTouchId);
      if (t) lookTouchId = null;
    }
    lookZone.addEventListener("touchend", endLook);
    lookZone.addEventListener("touchcancel", endLook);

    // ---- Helper: press-and-hold buttons that just toggle a `keys` flag,
    // reusing exactly the same input path as the equivalent keyboard key.
    // Looks up the current binding each time so rebinding a key from Settings
    // is honored immediately, on both keyboard and touch. ----
    function bindHold(id, action) {
      const el = document.getElementById(id);
      el.addEventListener("touchstart", (e) => { if (editMode) return; e.preventDefault(); keys[Bindings[action]] = true; el.classList.add("pressed"); }, { passive: false });
      const release = () => { keys[Bindings[action]] = false; el.classList.remove("pressed"); };
      el.addEventListener("touchend", release);
      el.addEventListener("touchcancel", release);
    }
    // ---- Helper: tap-to-toggle buttons (sprint/crouch feel better as toggles on touch) ----
    function bindToggle(id, action) {
      const el = document.getElementById(id);
      el.addEventListener("touchstart", (e) => {
        if (editMode) return;
        e.preventDefault();
        const code = Bindings[action];
        keys[code] = !keys[code];
        el.classList.toggle("pressed", !!keys[code]);
      }, { passive: false });
    }

    bindHold("lean-left", "leanLeft");
    bindHold("lean-right", "leanRight");
    bindToggle("touch-sprint", "sprint");
    bindToggle("touch-crouch", "crouch");

    // Fire (hold) — reuses the same mouseDown flag the desktop LMB sets.
    const fireBtn = document.getElementById("touch-fire");
    fireBtn.addEventListener("touchstart", (e) => { if (editMode) return; e.preventDefault(); mouseDown = true; fireBtn.classList.add("pressed"); }, { passive: false });
    const stopFire = () => { mouseDown = false; fireBtn.classList.remove("pressed"); };
    fireBtn.addEventListener("touchend", stopFire);
    fireBtn.addEventListener("touchcancel", stopFire);

    // ADS (hold) — reuses the same rightDown flag the desktop RMB sets. Now its
    // own button pinned to the top-left corner instead of sitting inside the
    // right-hand action cluster, so it can't be mistapped for fire/reload.
    const adsBtn = document.getElementById("touch-ads");
    adsBtn.addEventListener("touchstart", (e) => { if (editMode) return; e.preventDefault(); rightDown = true; adsBtn.classList.add("pressed"); }, { passive: false });
    const stopAds = () => { rightDown = false; adsBtn.classList.remove("pressed"); };
    adsBtn.addEventListener("touchend", stopAds);
    adsBtn.addEventListener("touchcancel", stopAds);

    // Jump / climb — same mantle-then-jump logic as the Space key.
    document.getElementById("touch-jump").addEventListener("touchstart", (e) => {
      if (editMode) return;
      e.preventDefault();
      if (!tryMantle()) tryJump();
    }, { passive: false });

    // Reload
    document.getElementById("touch-reload").addEventListener("touchstart", (e) => { if (editMode) return; e.preventDefault(); startReload(); }, { passive: false });

    // Dedicated weapon-switch button — cycles rifle → smg → sniper → rifle,
    // so switching doesn't depend on precisely tapping the small HUD pills.
    document.getElementById("touch-weapon-switch").addEventListener("touchstart", (e) => {
      if (editMode) return;
      e.preventDefault();
      equipWeapon((Player.currentWeaponIdx + 1) % WEAPON_ORDER.length);
    }, { passive: false });

    // Weapon slots — tapping the existing HUD slot pills switches weapons on any device.
    document.querySelectorAll(".slot").forEach((el, i) => {
      el.style.pointerEvents = "auto";
      el.addEventListener("touchstart", (e) => { if (editMode) return; e.preventDefault(); equipWeapon(i); });
    });

    // Pause
    document.getElementById("touch-pause").addEventListener("touchstart", (e) => {
      if (editMode) return;
      e.preventDefault();
      if (!Game.running || Game.ended) return;
      Game.paused = true;
      document.getElementById("pause-menu").classList.remove("hidden");
    }, { passive: false });

    // Prevent double-tap-to-zoom / pinch-zoom / pull-to-refresh interfering with play.
    document.addEventListener("touchmove", (e) => { if (Game.running && !editMode) e.preventDefault(); }, { passive: false });

    /* ------------------------------------------------------------------
       MOBILE HUD CUSTOMIZATION
       Lets players drag every touch control to wherever fits their grip
       (different phones, left/right-handed, tablet vs phone, etc.) and
       remembers the layout in localStorage. ------------------------------------------------------------------ */
    const LAYOUT_KEY = "neonstrike_mobile_hud_layout_v1";
    const DRAG_IDS = [
      "touch-joystick", "lean-left", "lean-right",
      "touch-sprint", "touch-crouch", "touch-reload", "touch-jump",
      "touch-weapon-switch", "touch-fire", "touch-ads", "touch-pause"
    ];

    function loadHudLayout() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch (e) { saved = {}; }
      DRAG_IDS.forEach((id) => {
        const el = document.getElementById(id);
        const pos = saved[id];
        if (!el || !pos) return;
        el.style.left = pos.left + "px";
        el.style.top = pos.top + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      });
    }
    function saveHudLayout() {
      const layout = {};
      DRAG_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        layout[id] = { left: Math.round(r.left), top: Math.round(r.top) };
      });
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) {}
    }
    function resetHudLayout() {
      try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
      DRAG_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.left = ""; el.style.top = ""; el.style.right = ""; el.style.bottom = "";
      });
    }
    loadHudLayout();

    // Give every repositionable control its own drag handling. Only live
    // while editMode is true, and stopPropagation keeps a drag from also
    // triggering the look-zone drag underneath it.
    DRAG_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      let dragTouchId = null, offX = 0, offY = 0;
      el.addEventListener("touchstart", (e) => {
        if (!editMode) return;
        e.preventDefault(); e.stopPropagation();
        const t = e.changedTouches[0];
        dragTouchId = t.identifier;
        const rect = el.getBoundingClientRect();
        offX = t.clientX - rect.left; offY = t.clientY - rect.top;
        el.classList.add("dragging");
      }, { passive: false });
      el.addEventListener("touchmove", (e) => {
        if (!editMode || dragTouchId === null) return;
        const t = [...e.changedTouches].find((t) => t.identifier === dragTouchId);
        if (!t) return;
        e.preventDefault(); e.stopPropagation();
        const nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, t.clientX - offX));
        const ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, t.clientY - offY));
        el.style.left = nx + "px"; el.style.top = ny + "px";
        el.style.right = "auto"; el.style.bottom = "auto";
      }, { passive: false });
      const endDrag = (e) => {
        if (dragTouchId === null) return;
        e.stopPropagation();
        dragTouchId = null;
        el.classList.remove("dragging");
      };
      el.addEventListener("touchend", endDrag);
      el.addEventListener("touchcancel", endDrag);
    });

    function enterHudEditMode() {
      editMode = true;
      document.getElementById("settings-menu").classList.add("hidden");
      document.getElementById("mobile-controls").classList.remove("hidden");
      document.getElementById("hud-edit-toolbar").classList.remove("hidden");
      document.body.classList.add("hud-edit-mode");
    }
    function exitHudEditMode(save) {
      if (save) saveHudLayout();
      forceExitHudEditMode();
      if (!Game.running) document.getElementById("mobile-controls").classList.add("hidden");
      document.getElementById("settings-menu").classList.remove("hidden");
    }

    const customizeBtn = document.getElementById("btn-customize-hud");
    if (customizeBtn) customizeBtn.addEventListener("touchstart", (e) => { e.preventDefault(); enterHudEditMode(); });
    const editDoneBtn = document.getElementById("btn-edit-done");
    if (editDoneBtn) editDoneBtn.addEventListener("touchstart", (e) => { e.preventDefault(); exitHudEditMode(true); });
    const editResetBtn = document.getElementById("btn-edit-reset");
    if (editResetBtn) editResetBtn.addEventListener("touchstart", (e) => { e.preventDefault(); resetHudLayout(); });
  }

  /* ==========================================================================
     11. MAIN GAME LOOP
     ========================================================================== */
  /* ==========================================================================
     SYNC / OVERDRIVE (new mechanic)
     Hits and kills charge the SYNC meter. At 100 the player can trigger
     OVERDRIVE: hostiles drop to 35% speed (movement, fire cadence, respawns)
     while the player stays at full speed with +50% damage and a wider FOV.
     Kills during Overdrive extend it; dying halves the meter.
     ========================================================================== */
  const OD_DUR = 6, OD_SCALE = 0.35;
  function updateSyncHUD() {
    const wrap = document.getElementById("sync-wrap");
    if (!wrap) return;
    document.getElementById("sync-bar").style.width = Math.round(Game.sync) + "%";
    const ready = Game.sync >= 100 && !Game.overdrive;
    wrap.classList.toggle("ready", ready);
    wrap.classList.toggle("active", Game.overdrive);
    const tb = document.getElementById("touch-overdrive");
    if (tb) tb.classList.toggle("ready", ready);
    document.getElementById("sync-hint").textContent = Game.overdrive ? "OVERDRIVE" : "PRESS " + keyDisplayName(Bindings.overdrive);
  }
  function addSync(n) {
    if (Game.overdrive) return;
    const before = Game.sync;
    Game.sync = Math.min(100, Game.sync + n);
    if (before < 100 && Game.sync >= 100) { centerMessage("SYNC READY — PRESS " + keyDisplayName(Bindings.overdrive)); AudioEngine.hitmarker(); }
    updateSyncHUD();
  }
  function activateOverdrive() {
    if (!Game.running || Game.paused || !Player.alive || Game.overdrive || Game.sync < 100) return;
    Game.overdrive = true;
    Game.overdriveT = OD_DUR;
    document.body.classList.add("overdrive");
    centerMessage("OVERDRIVE");
    AudioEngine.hitmarker();
    updateSyncHUD();
  }
  function endOverdrive() {
    Game.overdrive = false;
    Game.sync = 0;
    document.body.classList.remove("overdrive");
    updateSyncHUD();
  }
  function shiftTimers(ms, includePlayer) {
    Bots.list.forEach((b) => {
      if (typeof b.lastShot === "number") b.lastShot += ms;
      if (typeof b.respawnAt === "number") b.respawnAt += ms;
      if (typeof b.lastSeenPlayerAt === "number") b.lastSeenPlayerAt += ms;
    });
    if (includePlayer) { Player.reloadStart += ms; Player.lastShotTime += ms; }
  }
  function updateOverdrive(dt) {
    if (!Game.overdrive) return;
    Game.overdriveT -= dt;
    shiftTimers((1 - OD_SCALE) * dt * 1000, false); // slows bot cooldowns/respawns to match
    document.getElementById("sync-bar").style.width = Math.max(0, Game.overdriveT / OD_DUR * 100) + "%";
    if (Game.overdriveT <= 0) endOverdrive();
  }

  // Robustness: stuck keys/buttons after alt-tab, auto-pause when the tab is hidden.
  window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; mouseDown = false; rightDown = false; });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && Game.running && !Game.paused && !isMobile) document.exitPointerLock();
  });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== canvas) { mouseDown = false; rightDown = false; }
  });
  const odBtn = document.getElementById("touch-overdrive");
  if (odBtn) odBtn.addEventListener("touchstart", (e) => { e.preventDefault(); activateOverdrive(); }, { passive: false });

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (Game.running && Game.paused) shiftTimers(dt * 1000, true); // pausing freezes bot timers + reload

    if (Game.running && !Game.paused && Player.alive !== undefined) {
      updatePlayer(dt);
      const now = performance.now();
      updateOverdrive(dt);
      const botDt = Game.overdrive ? dt * OD_SCALE : dt;
      Bots.list.forEach((b) => updateBot(b, botDt, now));
      resolveBotCollisions();
      Effects.update(dt);
      updateEnemyStatusHUD(dt);

      if (Game.mode !== "practice") {
        Game.timeLeft -= dt;
        if (Game.timeLeft <= 0) { Game.timeLeft = 0; endMatch(Game.kills >= Game.deaths ? "VICTORY" : "MATCH OVER"); }
        document.getElementById("match-timer").textContent = formatTime(Game.timeLeft);
      }
    }

    renderer.render(scene, camera);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Kick off render loop immediately so menu background could later show 3D if desired.
  animate();

  } catch (err) {
    // Setup failed somewhere in sections 2-11 above. Show a clear on-screen message
    // instead of leaving a dead page with buttons that silently do nothing.
    console.error("NEON STRIKE failed to initialize:", err);
    const el = document.getElementById("webgl-error");
    el.querySelector("h1").textContent = "STARTUP FAILED";
    el.querySelector("p").textContent = "NEON STRIKE hit an error while setting up and couldn't start.";
    const dim = el.querySelector(".dim");
    if (dim) dim.textContent = String(err && err.message ? err.message : err) + " — try reloading the page.";
    el.classList.remove("hidden");
    document.getElementById("main-menu").classList.add("hidden");
  }
})();
