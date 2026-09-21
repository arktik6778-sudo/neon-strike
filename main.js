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

  /* ==========================================================================
     2. GLOBAL STATE & SETTINGS
     ========================================================================== */
  const Settings = {
    sensitivity: 8,    // 1-20
    volume: 0.6,       // 0-1
    graphics: "medium", // low|medium|high
    crosshairColor: "#00f0ff",
  };

  const Game = {
    running: false,
    paused: false,
    mode: "ffa",        // ffa | tdm | practice
    matchTime: 150,      // seconds
    timeLeft: 150,
    kills: 0,
    deaths: 0,
    scoreLimit: 20,
    ended: false,
  };

  // Touch/mobile detection — drives on-screen control visibility and input handling.
  const isTouchDevice = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  if (isTouchDevice) document.body.classList.add("is-touch");

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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  scene.fog = new THREE.FogExp2(0x05070a, 0.028);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  const EYE_HEIGHT = 1.7, CROUCH_HEIGHT = 1.0;
  camera.position.set(0, EYE_HEIGHT, 0);

  // Weapon viewmodel rig — parented to camera so it stays in view.
  const weaponRig = new THREE.Group();
  camera.add(weaponRig);
  scene.add(camera);

  // Lighting: dim ambient + hemisphere for neon industrial mood, plus colored point lights
  scene.add(new THREE.HemisphereLight(0x2b4a66, 0x0a0a10, 0.55));
  const sun = new THREE.DirectionalLight(0x8fd6ff, 0.35);
  sun.position.set(30, 50, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
  scene.add(sun);

  function addAccentLight(x, y, z, color, intensity, dist) {
    const l = new THREE.PointLight(color, intensity, dist);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  }

  /* ==========================================================================
     5. MAP CONSTRUCTION — original compact urban/sci-fi arena
     ========================================================================== */
  const solidBoxes = [];   // THREE.Box3 for wall/building collision (XZ)
  const groundTops = [];   // {box2D:{minX,maxX,minZ,maxZ}, y: topHeight} for standable surfaces

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
    return mesh;
  }

  function buildMap() {
    // Ground
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.95, metalness: 0.1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    groundTops.push({ minX: -50, maxX: 50, minZ: -50, maxZ: 50, y: 0 });

    // Floor grid accent lines (visual only)
    const grid = new THREE.GridHelper(100, 50, 0x1a5f73, 0x0d2530);
    grid.position.y = 0.01;
    scene.add(grid);

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
  buildMap();

  // Patrol waypoints spread across the arena (open areas, corridors, near cover) — bots wander between
  // these when they don't have a player to chase, giving more varied and natural movement than just
  // walking between the (sparser) spawn points.
  const PATROL_WAYPOINTS = [
    [0, 0], [0, 14], [0, -14], [14, 0], [-14, 0],
    [22, 22], [-22, -22], [22, -22], [-22, 22],
    [10, 18], [-10, 18], [10, -18], [-10, -18],
    [30, 10], [-30, -10], [30, -10], [-30, 10],
    [18, 8], [-18, -8], [18, -8], [-18, 8],
    [0, 30], [0, -30],
  ];
  function randomPatrolPoint() {
    const p = PATROL_WAYPOINTS[Math.floor(Math.random() * PATROL_WAYPOINTS.length)];
    return new THREE.Vector3(p[0] + (Math.random() - 0.5) * 4, 0, p[1] + (Math.random() - 0.5) * 4);
  }

  // Spawn points (player + bots), spread around the arena
  const SPAWN_POINTS = [
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [40, 40], [-40, -40], [40, -40], [-40, 40],
    [20, 30], [-20, -30],
  ];
  function randomSpawn() {
    const p = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    return new THREE.Vector3(p[0], 0, p[1]);
  }

  /* ==========================================================================
     6. WEAPON DEFINITIONS
     ========================================================================== */
  const WEAPONS = {
    rifle: {
      key: "rifle", label: "ASSAULT RIFLE", damage: 34, headMult: 2.0,
      fireRateMs: 110, magSize: 30, reserveMax: 90, reloadTimeMs: 1700,
      spread: 0.018, adsSpread: 0.006, recoilKick: 0.014, automatic: true,
      color: 0x2d8cff, muzzleColor: 0x9fdcff,
    },
    smg: {
      key: "smg", label: "SUBMACHINE GUN", damage: 15, headMult: 1.8,
      fireRateMs: 70, magSize: 40, reserveMax: 120, reloadTimeMs: 1400,
      spread: 0.03, adsSpread: 0.012, recoilKick: 0.009, automatic: true,
      color: 0x39ff6a, muzzleColor: 0xbfffcf,
    },
    sniper: {
      key: "sniper", label: "RAILGUN SNIPER", damage: 100, headMult: 2.2,
      fireRateMs: 1100, magSize: 5, reserveMax: 20, reloadTimeMs: 2400,
      spread: 0.002, adsSpread: 0.0003, recoilKick: 0.05, automatic: false,
      color: 0xff9500, muzzleColor: 0xffe0b0,
    },
  };
  const WEAPON_ORDER = ["rifle", "smg", "sniper"];

  // Build a simple viewmodel mesh per weapon (procedural, original design — no external assets)
  function buildViewModel(def) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x20242b, metalness: 0.6, roughness: 0.4 });
    const accentMat = new THREE.MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.3 });

    const bodyLen = def.key === "sniper" ? 1.1 : def.key === "smg" ? 0.55 : 0.8;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, bodyLen), bodyMat);
    body.position.set(0, 0, -bodyLen / 2);
    g.add(body);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, bodyLen * 0.7), accentMat);
    stripe.position.set(0, 0.045, -bodyLen / 2);
    g.add(stripe);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.35, 8), bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -bodyLen - 0.1);
    g.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.07), bodyMat);
    grip.position.set(0, -0.12, -0.05);
    grip.rotation.x = 0.25;
    g.add(grip);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.06), accentMat);
    mag.position.set(0, -0.13, -bodyLen * 0.35);
    g.add(mag);

    g.position.set(0.22, -0.2, -0.42);
    g.rotation.y = 0.02;
    g.userData.baseX = 0.22; g.userData.baseY = -0.2; g.userData.baseZ = -0.42;
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
    lastShotTime: 0,
    footstepTimer: 0,
    radius: 0.5,
    bobT: 0,
  };

  function currentWeaponKey() { return WEAPON_ORDER[Player.currentWeaponIdx]; }
  function currentWeapon() { return WEAPONS[currentWeaponKey()]; }

  function resetPlayer() {
    const sp = randomSpawn();
    Player.pos.copy(sp);
    Player.velY = 0;
    Player.health = 100;
    Player.armor = 50;
    Player.alive = true;
    Player.crouching = false;
    Player.reloading = false;
    WEAPON_ORDER.forEach((k) => { Player.ammo[k] = WEAPONS[k].magSize; Player.reserve[k] = WEAPONS[k].reserveMax; });
    Player.currentWeaponIdx = 0;
    switchWeaponVisual();
  }

  const keys = {};
  window.addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (!Game.running || Game.paused) return;
    if (e.code === "KeyR") startReload();
    if (e.code === "Digit1") equipWeapon(0);
    if (e.code === "Digit2") equipWeapon(1);
    if (e.code === "Digit3") equipWeapon(2);
    if (e.code === "Space") tryJump();
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
    document.querySelectorAll(".mobile-weapon-btn").forEach((el) => el.classList.toggle("active", +el.dataset.slot === Player.currentWeaponIdx));
    document.getElementById("weapon-name").textContent = currentWeapon().label;
    document.getElementById("reload-indicator").classList.add("hidden");
    updateAmmoHUD();
  }

  function tryJump() {
    if (Player.onGround && Player.alive && !Player.crouching) {
      Player.velY = 5.2;
      Player.onGround = false;
      AudioEngine.jump();
    }
  }

  function startReload() {
    const wk = currentWeaponKey();
    const w = WEAPONS[wk];
    if (Player.reloading || Player.ammo[wk] >= w.magSize || Player.reserve[wk] <= 0) return;
    Player.reloading = true;
    document.getElementById("reload-indicator").classList.remove("hidden");
    AudioEngine.reload();
    setTimeout(() => {
      const need = w.magSize - Player.ammo[wk];
      const take = Math.min(need, Player.reserve[wk]);
      Player.ammo[wk] += take;
      Player.reserve[wk] -= take;
      Player.reloading = false;
      document.getElementById("reload-indicator").classList.add("hidden");
      updateAmmoHUD();
    }, w.reloadTimeMs);
  }

  function updateAmmoHUD() {
    const wk = currentWeaponKey();
    document.getElementById("ammo-mag").textContent = Player.ammo[wk];
    document.getElementById("ammo-reserve").textContent = Player.reserve[wk];
  }

  // Mouse look via pointer lock
  let mouseDown = false, rightDown = false;
  // Touch control state (joystick vector + toggles), used alongside keys[] on mobile.
  const joystickVec = { x: 0, y: 0 };
  let touchSprintActive = false, touchCrouchActive = false;
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas || Game.paused || !Game.running) return;
    const sens = Settings.sensitivity * 0.0011;
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
    if (Player.ammo[wk] <= 0) { AudioEngine.empty(); return; }
    Player.lastShotTime = now;
    Player.ammo[wk]--;
    updateAmmoHUD();
    AudioEngine.gunshot(wk);
    Effects.spawnMuzzleFlash(w.muzzleColor);
    applyRecoil(w);
    fireRaycast(w);
    kickViewmodel();
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

    // Gather targetable meshes: bot hit meshes + solid world meshes
    // (skip bots on the player's own team in TDM — no friendly fire)
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
        const dmg = w.damage * (isHead ? w.headMult : 1);
        damageBot(bot, dmg, isHead);
        showHitmarker(isHead);
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
    Game.deaths++;
    document.getElementById("death-count").textContent = Game.deaths;
    centerMessage("ELIMINATED");
    setTimeout(() => { resetPlayer(); }, 2200);
  }

  // Collision: resolve movement against solidBoxes (expanded by player radius), axis-separated
  function resolveCollision(newPos) {
    const r = Player.radius;
    for (const box of solidBoxes) {
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      const minY = box.min.y, maxY = box.max.y;
      if (newPos.y + 1.8 < minY || newPos.y > maxY + 3) continue; // rough vertical gate (allow standing on platforms handled separately)
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
    const joystickActive = joystickVec.x !== 0 || joystickVec.y !== 0;
    const anyMoveInput = keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || joystickActive;
    Player.crouching = !!(keys.ControlLeft || keys.ControlRight || touchCrouchActive);
    Player.sprinting = (keys.ShiftLeft || keys.ShiftRight || touchSprintActive) && !Player.crouching && anyMoveInput;
    Player.aiming = rightDown && !Player.sprinting;

    // recoil recovery
    recoilPitch *= 0.9; recoilYaw *= 0.85;
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = "YXZ";
    camera.rotation.y = Player.yaw + recoilYaw;
    camera.rotation.x = Player.pitch + recoilPitch;

    // movement input — proper forward/right from yaw
    const fwd = new THREE.Vector3(-Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
    const right = new THREE.Vector3(Math.cos(Player.yaw), 0, -Math.sin(Player.yaw));
    let move = new THREE.Vector3();
    if (keys.KeyW) move.add(fwd);
    if (keys.KeyS) move.sub(fwd);
    if (keys.KeyD) move.add(right);
    if (keys.KeyA) move.sub(right);
    if (joystickActive) {
      move.addScaledVector(fwd, joystickVec.y);
      move.addScaledVector(right, joystickVec.x);
    }
    if (move.lengthSq() > 0) move.normalize();

    let speed = Player.crouching ? 2.4 : Player.sprinting ? 7.2 : 4.4;
    if (Player.aiming) speed *= 0.65;

    const newPos = Player.pos.clone().addScaledVector(move, speed * dt);
    resolveCollision(newPos);
    resolvePlayerVsBots(newPos);

    // vertical
    const groundY = groundHeightAt(newPos.x, newPos.z, Player.pos.y);
    Player.velY -= 14 * dt;
    let newY = Player.pos.y + Player.velY * dt;
    if (newY <= groundY) { newY = groundY; Player.velY = 0; Player.onGround = true; }
    else Player.onGround = false;

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

    const targetHeight = Player.crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
    const bobY = Math.sin(Player.bobT) * (Player.crouching ? 0.02 : 0.045);
    camera.position.set(Player.pos.x, Player.pos.y + targetHeight + bobY, Player.pos.z);

    // ADS weapon offset
    const vm = viewModels[currentWeaponKey()];
    const targetX = Player.aiming ? 0 : vm.userData.baseX;
    const targetZFov = Player.aiming ? 55 : 75;
    vm.position.x += (targetX - vm.position.x) * 0.25;
    camera.fov += (targetZFov - camera.fov) * 0.2;
    camera.updateProjectionMatrix();
    document.getElementById("crosshair").classList.toggle("ads", Player.aiming);

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

  function createBot(idx, team) {
    const group = new THREE.Group();
    const teamColor = team === "red" ? 0xff2d55 : 0x2d8cff;
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, emissive: teamColor, emissiveIntensity: 0.25, roughness: 0.6 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, emissive: teamColor, emissiveIntensity: 0.4 });

    const body = new THREE.Mesh(
      (typeof THREE.CapsuleGeometry === "function")
        ? new THREE.CapsuleGeometry(0.35, 0.9, 4, 8)
        : new THREE.CylinderGeometry(0.35, 0.35, 1.4, 8),
      bodyMat
    );
    body.position.y = 1.0;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 10), headMat);
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: teamColor }));
    visor.position.set(0, 1.78, 0.24);
    group.add(visor);

    scene.add(group);

    const sp = randomSpawn();
    group.position.copy(sp);

    // ---- Floating health bar (billboard, always faces the camera) ----
    const barGroup = new THREE.Group();
    barGroup.position.set(0, 2.15, 0);
    const BAR_W = 0.8, BAR_H = 0.09;
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR_W + 0.03, BAR_H + 0.03),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false })
    );
    bg.renderOrder = 998;
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR_W, BAR_H),
      new THREE.MeshBasicMaterial({ color: team === "red" ? 0xff2d55 : 0x2d8cff, transparent: true, depthTest: false })
    );
    fill.renderOrder = 999;
    barGroup.add(bg, fill);
    group.add(barGroup);

    // Name tag sprite (rendered once to a canvas texture — cheap, static per bot)
    const nameCanvas = document.createElement("canvas");
    nameCanvas.width = 256; nameCanvas.height = 48;
    const nctx = nameCanvas.getContext("2d");
    nctx.fillStyle = "rgba(0,0,0,0)"; nctx.fillRect(0, 0, 256, 48);
    nctx.font = "bold 28px Orbitron, sans-serif";
    nctx.fillStyle = team === "red" ? "#ff9aad" : "#9ac9ff";
    nctx.textAlign = "center";
    const botName = BOT_NAMES[idx % BOT_NAMES.length] + "-" + (idx + 1);
    nctx.fillText(botName, 128, 34);
    const nameTex = new THREE.CanvasTexture(nameCanvas);
    const nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthTest: false }));
    nameSprite.scale.set(1.1, 0.2, 1);
    nameSprite.position.set(0, 2.35, 0);
    nameSprite.renderOrder = 999;
    group.add(nameSprite);

    return {
      id: idx, name: botName,
      group, bodyMesh: body, headMesh: head,
      team,
      health: 100, maxHealth: 100, alive: true,
      state: "patrol",
      target: randomPatrolPoint(),
      lastShot: 0, weapon: WEAPONS.rifle,
      respawnAt: 0,
      speed: 2.6,
      radius: 0.42,
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

  function damageBot(bot, dmg, isHead) {
    if (!bot.alive) return;
    bot.health -= dmg;
    if (bot.health <= 0) { bot.health = 0; killBot(bot); }
    updateBotHealthBar(bot);
  }

  function killBot(bot) {
    bot.alive = false;
    Game.kills++;
    document.getElementById("kill-count").textContent = Game.kills;
    addKillFeed(`YOU ELIMINATED ${bot.name}`);
    AudioEngine.kill();
    // simple death animation: sink & fade
    const startY = bot.group.position.y;
    let t = 0;
    const anim = setInterval(() => {
      t += 0.05;
      bot.group.position.y = startY - t * 1.2;
      bot.group.rotation.z = t * 1.2;
      bot.bodyMesh.material.opacity = Math.max(0, 1 - t);
      bot.bodyMesh.material.transparent = true;
      bot.headMesh.material.opacity = Math.max(0, 1 - t);
      bot.headMesh.material.transparent = true;
      if (t >= 1) { clearInterval(anim); bot.group.visible = false; }
    }, 50);
    bot.respawnAt = performance.now() + 3500;

    checkScoreLimit();
  }

  function respawnBot(bot) {
    const sp = randomSpawn();
    bot.group.position.copy(sp);
    bot.group.position.y = 0;
    bot.group.rotation.z = 0;
    bot.bodyMesh.material.opacity = 1; bot.headMesh.material.opacity = 1;
    bot.group.visible = true;
    bot.health = bot.maxHealth;
    bot.alive = true;
    bot.state = "patrol";
    bot.target.set(sp.x, 0, sp.z);
    bot.lastPos.copy(bot.group.position);
    bot.stuckTimer = 0;
    updateBotHealthBar(bot);
  }

  function spawnAllBots() {
    Bots.list.forEach((b) => scene.remove(b.group));
    Bots.list = [];
    const count = Game.mode === "practice" ? 4 : Game.mode === "tdm" ? 8 : 6;
    for (let i = 0; i < count; i++) {
      const team = Game.mode === "tdm" ? (i % 2 === 0 ? "red" : "blue") : "red";
      Bots.list.push(createBot(i, team));
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
    // Friendly bots on player's team in TDM don't target the player
    const hostileToPlayer = !(Game.mode === "tdm" && bot.team === "blue");

    const eyePos = bot.group.position.clone().add(new THREE.Vector3(0, 1.75, 0));
    const playerPos = camera.position.clone();
    const distToPlayer = eyePos.distanceTo(playerPos);
    const canSeePlayer = hostileToPlayer && Player.alive && distToPlayer < 45 && hasLineOfSight(eyePos, playerPos);

    if (canSeePlayer) {
      bot.state = "chase";
      bot.lastSeenPlayerAt = now;
    } else if (bot.state === "chase" && now - (bot.lastSeenPlayerAt || 0) > 2500) {
      bot.state = "patrol";
      bot.target = randomPatrolPoint();
    }

    if (bot.state === "chase") {
      const toPlayer = playerPos.clone().sub(bot.group.position); toPlayer.y = 0;
      const dist = toPlayer.length();
      const dir = toPlayer.clone().normalize();

      // Strafe side-to-side while engaging at combat range for less static-feeling bots;
      // close the distance if too far, back off slightly if too close.
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) { bot.strafeDir *= -1; bot.strafeTimer = 1.2 + Math.random() * 1.8; }
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);

      const moveVec = new THREE.Vector3();
      if (dist > 16) moveVec.add(dir);              // too far: close in
      else if (dist < 6) moveVec.sub(dir);           // too close: back off
      moveVec.addScaledVector(perp, bot.strafeDir * 0.7); // always strafe a bit
      if (moveVec.lengthSq() > 0) moveVec.normalize();

      bot.group.position.addScaledVector(moveVec, bot.speed * dt);
      bot.group.lookAt(playerPos.x, bot.group.position.y, playerPos.z);

      // shoot at player
      if (Game.mode !== "practice" && now - bot.lastShot > 900 + Math.random() * 500) {
        bot.lastShot = now;
        fireBotAtPlayer(bot, eyePos, playerPos);
      } else if (Game.mode === "practice" && now - bot.lastShot > 2200) {
        bot.lastShot = now; // practice bots shoot rarely & weakly
        fireBotAtPlayer(bot, eyePos, playerPos, 0.3);
      }
    } else {
      // patrol toward target waypoint, with stuck-detection so bots don't idle forever
      // if a waypoint is unreachable behind geometry.
      const dir = bot.target.clone().sub(bot.group.position); dir.y = 0;
      const dist = dir.length();
      if (dist < 1.5) {
        bot.target = randomPatrolPoint();
      } else {
        dir.normalize();
        bot.group.position.addScaledVector(dir, bot.speed * 0.55 * dt);
        bot.group.lookAt(bot.target.x, bot.group.position.y, bot.target.z);
      }
      const movedDist = bot.group.position.distanceTo(bot.lastPos);
      if (movedDist < 0.03) {
        bot.stuckTimer += dt;
        if (bot.stuckTimer > 1.2) { bot.target = randomPatrolPoint(); bot.stuckTimer = 0; }
      } else {
        bot.stuckTimer = 0;
      }
    }

    bot.lastPos.copy(bot.group.position);
    resolveCollision(bot.group.position);
    // Snap bots onto ramps/platforms the same way the player does, so they
    // aren't permanently stuck at ground level.
    bot.group.position.y = groundHeightAt(bot.group.position.x, bot.group.position.z, bot.group.position.y);
    updateBotHealthBar(bot);
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

  function fireBotAtPlayer(bot, eyePos, playerPos, dmgMult = 1) {
    Effects.spawnImpactSpark(eyePos.clone().addScaledVector(playerPos.clone().sub(eyePos).normalize(), 0.6), 0xff5a00);
    const hitChance = 0.55; // bots aren't perfectly accurate
    if (Math.random() < hitChance) {
      damagePlayer((10 + Math.random() * 8) * dmgMult);
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
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
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
    document.getElementById("settings-menu").classList.add("hidden");
    document.getElementById(settingsReturnTo).classList.remove("hidden");
  }

  // Settings controls
  const sensSlider = document.getElementById("setting-sensitivity");
  sensSlider.addEventListener("input", () => { Settings.sensitivity = +sensSlider.value; document.getElementById("val-sensitivity").textContent = sensSlider.value; });
  const volSlider = document.getElementById("setting-volume");
  volSlider.addEventListener("input", () => { Settings.volume = +volSlider.value / 100; document.getElementById("val-volume").textContent = volSlider.value; });
  document.getElementById("setting-graphics").addEventListener("change", (e) => {
    Settings.graphics = e.target.value;
    applyGraphicsQuality();
  });
  document.querySelectorAll(".ch-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll(".ch-swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      Settings.crosshairColor = sw.dataset.color;
      document.documentElement.style.setProperty("--crosshair-color", Settings.crosshairColor);
    });
  });
  function applyGraphicsQuality() {
    if (Settings.graphics === "low") {
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = false;
      scene.fog.density = 0.045;
    } else if (Settings.graphics === "medium") {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = true;
      scene.fog.density = 0.028;
    } else {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      scene.fog.density = 0.02;
    }
  }

  // ---- Pause ----
  document.getElementById("btn-resume").addEventListener("click", () => {
    if (isTouchDevice) {
      Game.paused = false;
      document.getElementById("pause-menu").classList.add("hidden");
    } else {
      canvas.requestPointerLock();
    }
  });
  document.getElementById("btn-quit").addEventListener("click", quitToMenu);
  document.getElementById("btn-rematch").addEventListener("click", () => { document.getElementById("end-screen").classList.add("hidden"); startGame(); });
  document.getElementById("btn-end-menu").addEventListener("click", quitToMenu);

  function quitToMenu() {
    Game.running = false;
    Game.paused = false;
    document.exitPointerLock();
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("pause-menu").classList.add("hidden");
    document.getElementById("end-screen").classList.add("hidden");
    document.getElementById("main-menu").classList.remove("hidden");
  }

  function startGame() {
    AudioEngine.unlock();
    document.getElementById("main-menu").classList.add("hidden");
    document.getElementById("end-screen").classList.add("hidden");
    Game.running = true;
    Game.paused = false;
    Game.ended = false;
    Game.kills = 0; Game.deaths = 0;
    Game.matchTime = Game.mode === "practice" ? 999999 : 150;
    Game.timeLeft = Game.matchTime;
    document.getElementById("kill-count").textContent = 0;
    document.getElementById("death-count").textContent = 0;
    document.getElementById("match-timer").textContent = Game.mode === "practice" ? "∞" : formatTime(Game.timeLeft);
    resetPlayer();
    spawnAllBots();
    applyGraphicsQuality();
    document.getElementById("hud").classList.remove("hidden");
    if (!isTouchDevice) canvas.requestPointerLock();
  }

  function endMatch(title) {
    if (Game.ended) return;
    Game.ended = true;
    Game.running = false;
    document.exitPointerLock();
    document.getElementById("end-title").textContent = title;
    document.getElementById("end-stats").innerHTML =
      `<div>KILLS: <b>${Game.kills}</b></div><div>DEATHS: <b>${Game.deaths}</b></div><div>MODE: <b>${Game.mode.toUpperCase()}</b></div>`;
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("end-screen").classList.remove("hidden");
  }

  // ---- Pointer lock handling (desktop/mouse only — touch devices skip pointer lock entirely) ----
  document.addEventListener("pointerlockchange", () => {
    if (isTouchDevice) return;
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
    if (isTouchDevice) return;
    if (Game.running && !Game.paused && document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && Game.running) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
  });

  /* ==========================================================================
     10b. MOBILE / TOUCH CONTROLS
     Floating joystick (movement) + drag-look zone + on-screen action buttons.
     Only wired up when a touch-capable device is detected; harmless no-op
     listeners otherwise since the elements stay hidden via CSS.
     ========================================================================== */
  (function setupMobileControls() {
    const joyZone = document.getElementById("joystick-zone");
    const joyBase = document.getElementById("joystick-base");
    const joyKnob = document.getElementById("joystick-knob");
    const lookZone = document.getElementById("look-zone");
    if (!joyZone || !lookZone) return;

    // ---- Floating joystick (movement) ----
    let joyTouchId = null;
    let joyCenter = { x: 0, y: 0 };
    const JOY_MAX_R = 46;

    joyZone.addEventListener("touchstart", (e) => {
      if (joyTouchId !== null) return;
      const t = e.changedTouches[0];
      joyTouchId = t.identifier;
      const rect = joyZone.getBoundingClientRect();
      joyCenter.x = t.clientX; joyCenter.y = t.clientY;
      joyBase.style.left = (t.clientX - rect.left - joyBase.offsetWidth / 2) + "px";
      joyBase.style.top = (t.clientY - rect.top - joyBase.offsetHeight / 2) + "px";
      joyBase.style.opacity = "1";
      joyKnob.style.transform = "translate(0px,0px)";
      e.preventDefault();
    }, { passive: false });

    joyZone.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyTouchId) continue;
        const dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
        const dist = Math.min(Math.hypot(dx, dy), JOY_MAX_R);
        const angle = Math.atan2(dy, dx);
        const kx = Math.cos(angle) * dist, ky = Math.sin(angle) * dist;
        joyKnob.style.transform = `translate(${kx}px, ${ky}px)`;
        joystickVec.x = kx / JOY_MAX_R;
        joystickVec.y = -ky / JOY_MAX_R;
      }
      e.preventDefault();
    }, { passive: false });

    function endJoy(e) {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyTouchId) continue;
        joyTouchId = null;
        joystickVec.x = 0; joystickVec.y = 0;
        joyBase.style.opacity = "0";
        joyKnob.style.transform = "translate(0px,0px)";
      }
    }
    joyZone.addEventListener("touchend", endJoy);
    joyZone.addEventListener("touchcancel", endJoy);

    // ---- Drag-look zone (camera yaw/pitch) ----
    let lookTouchId = null;
    let lookLast = { x: 0, y: 0 };

    lookZone.addEventListener("touchstart", (e) => {
      if (lookTouchId !== null || !Game.running || Game.paused) return;
      const t = e.changedTouches[0];
      lookTouchId = t.identifier;
      lookLast.x = t.clientX; lookLast.y = t.clientY;
      e.preventDefault();
    }, { passive: false });

    lookZone.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookTouchId) continue;
        const dx = t.clientX - lookLast.x, dy = t.clientY - lookLast.y;
        lookLast.x = t.clientX; lookLast.y = t.clientY;
        if (!Game.running || Game.paused) continue;
        const sens = Settings.sensitivity * 0.0018;
        Player.yaw -= dx * sens;
        Player.pitch -= dy * sens;
        Player.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, Player.pitch));
      }
      e.preventDefault();
    }, { passive: false });

    function endLook(e) {
      for (const t of e.changedTouches) if (t.identifier === lookTouchId) lookTouchId = null;
    }
    lookZone.addEventListener("touchend", endLook);
    lookZone.addEventListener("touchcancel", endLook);

    // ---- Action buttons ----
    function bindHold(id, onStart, onEnd) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("touchstart", (e) => { el.classList.add("touch-active"); onStart && onStart(); e.preventDefault(); }, { passive: false });
      el.addEventListener("touchend", (e) => { el.classList.remove("touch-active"); onEnd && onEnd(); e.preventDefault(); }, { passive: false });
      el.addEventListener("touchcancel", (e) => { el.classList.remove("touch-active"); onEnd && onEnd(); }, { passive: false });
    }
    function bindTap(id, onTap) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("touchstart", (e) => { el.classList.add("touch-active"); onTap && onTap(); e.preventDefault(); }, { passive: false });
      el.addEventListener("touchend", (e) => { el.classList.remove("touch-active"); e.preventDefault(); }, { passive: false });
    }

    bindHold("btn-touch-fire", () => { mouseDown = true; }, () => { mouseDown = false; });
    bindHold("btn-touch-ads", () => { rightDown = true; }, () => { rightDown = false; });
    bindTap("btn-touch-jump", () => tryJump());
    bindTap("btn-touch-reload", () => startReload());
    bindTap("btn-touch-sprint", () => {
      touchSprintActive = !touchSprintActive;
      document.getElementById("btn-touch-sprint").classList.toggle("toggled-on", touchSprintActive);
    });
    bindTap("btn-touch-crouch", () => {
      touchCrouchActive = !touchCrouchActive;
      document.getElementById("btn-touch-crouch").classList.toggle("toggled-on", touchCrouchActive);
    });
    bindTap("btn-touch-pause", () => {
      if (!Game.running || Game.ended) return;
      Game.paused = !Game.paused;
      document.getElementById("pause-menu").classList.toggle("hidden", !Game.paused);
    });

    document.querySelectorAll(".mobile-weapon-btn").forEach((btn) => {
      btn.addEventListener("touchstart", (e) => {
        equipWeapon(+btn.dataset.slot);
        document.querySelectorAll(".mobile-weapon-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        e.preventDefault();
      }, { passive: false });
    });
  })();

  /* ==========================================================================
     11. MAIN GAME LOOP
     ========================================================================== */
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    if (Game.running && !Game.paused && Player.alive !== undefined) {
      updatePlayer(dt);
      const now = performance.now();
      Bots.list.forEach((b) => updateBot(b, dt, now));
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
})();
