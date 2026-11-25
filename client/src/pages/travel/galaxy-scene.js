/**
 * The 3D galaxy map: a procedural Milky Way in the game's coordinates (light years, Sol at the
 * origin, the galactic core along +z), the commander's jumps as glowing trails, the systems as
 * stars coloured by their class, and a playback clock for the time-lapse.
 *
 * Playback is all on the graphics card: every trail vertex carries the timeline position it's
 * reached at, and the shaders hide what's still in the future, so moving the clock costs one
 * uniform. A jump's start vertex is earlier than its end, so the line draws itself across.
 *
 * Kept out of React: the page drives it through methods, and it reports progress back through
 * onProgress (a few times a second) and onHover.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { describeStarClass } from './star-classes.js';

/** Sagittarius A*, in the game's coordinates. */
const GALACTIC_CENTER = [25.21875, -20.90625, 25899.96875];
export const LANDMARKS = [
  { name: 'Sol', position: [0, 0, 0] },
  { name: 'Sagittarius A*', position: GALACTIC_CENTER },
  { name: 'Colonia', position: [-9530.5, -910.28125, 19808.125] },
  { name: 'Beagle Point', position: [-1111.5625, -134.21875, 65269.75] },
];

export const JUMP_KIND_COLORS = ['#ff9a3c', '#7fe8ff', '#ffd84c', '#c08cff', '#4ee6a0'];
export const JUMP_KIND_LABELS = ['Normal', 'Supercharged', 'Synthesis', 'Carrier', 'Taxi'];
export const COMMANDER_COLORS = ['#ff9a3c', '#5fd4ff', '#ff5fa2', '#a6f05a', '#b794ff', '#ffd84c', '#4ee6a0', '#ff6b6b'];

/** A full replay at 1× takes about this long. */
const BASE_REPLAY_SECONDS = 60;
/** In "time" pacing, idle gaps (between sessions) are shortened to this. */
const MAX_IDLE_GAP_SECONDS = 5 * 60;
/** In "time" pacing, how long a jump takes to draw (roughly a hyperspace jump). */
const JUMP_DRAW_SECONDS = 20;
const GALAXY_VIEW_DISTANCE = 115_000;
const MIN_FIT_RADIUS = 30;

/**
 * The game's x axis points the other way to three.js's when y is up and z faces the core, so
 * x is flipped going in: the map then looks the way it does in the game.
 */
const toScene = (x, y, z) => [-x, y, z];

export class GalaxyScene {
  constructor(container, { onProgress = () => {}, onHover = () => {} } = {}) {
    this.container = container;
    this.onProgress = onProgress;
    this.onHover = onHover;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x020308, 1);
    // Filmic tone mapping keeps the crowded core glowing instead of burning out to flat white.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.domElement.className = 'galaxy-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'galaxy-labels';
    container.appendChild(this.labelLayer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 2_000_000);
    this.camera.position.set(...toScene(0, 60_000, -40_000));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 400_000;
    this.controls.target.set(...toScene(...GALACTIC_CENTER));
    // Dragging the view stops an automatic camera move and following.
    this.controls.addEventListener('start', () => {
      this.cameraFlight = null;
      this.isUserMoving = true;
    });
    this.controls.addEventListener('end', () => { this.isUserMoving = false; });
    this.useControlSpeeds('mouse');

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only bright things bloom (trails, arrivals, commanders), not the galaxy's haze.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.45, 0.35);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.pointScale = { value: 1 };
    this.clock = { value: 0 };
    this.timeline = { value: 0 };

    this.starfield = createStarfield(this.pointScale, this.clock);
    this.scene.add(this.starfield);
    this.galaxy = createGalaxy(this.pointScale);
    for (const layer of this.galaxy.layers) this.scene.add(layer);

    this.landmarkLabels = LANDMARKS.map((landmark) => this.addLabel(landmark.name, 'galaxy-label galaxy-label-landmark', toScene(...landmark.position)));
    this.landmarkMarkers = createLandmarkMarkers(this.pointScale, this.clock);
    this.scene.add(this.landmarkMarkers);

    this.travel = null;
    this.galaxyBrightness = 1;
    this.colorMode = 'type';
    this.trailStyle = 'trail';
    this.pace = 'jumps';
    this.speed = 1;
    this.isPlaying = false;
    this.position = 0;
    this.isFollowing = false;
    this.cameraFlight = null;
    this.playTarget = null;
    this.lastProgressAt = 0;
    this.pointer = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // Each gesture gets the speeds for what's doing it, so a touchscreen laptop still feels right with a mouse.
    this.handlePointerDown = (pointerEvent) => this.useControlSpeeds(pointerEvent.pointerType);
    this.handlePointerMove = (pointerEvent) => {
      const bounds = this.renderer.domElement.getBoundingClientRect();
      this.pointer = { x: pointerEvent.clientX - bounds.left, y: pointerEvent.clientY - bounds.top };
    };
    this.handlePointerLeave = () => {
      this.pointer = null;
      this.hoveredSystem = null;
      this.onHover(null);
    };
    this.handleDoubleClick = () => {
      if (this.hoveredSystem) this.flyTo(this.hoveredSystem.scenePosition, Math.max(40, this.camera.position.distanceTo(this.controls.target) * 0.35));
    };
    // Capture phase: the speeds must be set before the controls see the same pointerdown.
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown, true);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.handlePointerLeave);
    this.renderer.domElement.addEventListener('dblclick', this.handleDoubleClick);

    this.lastFrameAt = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  /**
   * A finger moves many more pixels than a mouse for the same intent, so touch turns, zooms and
   * pans more gently, and stops sooner after a flick instead of spinning on.
   */
  useControlSpeeds(pointerType) {
    const isTouch = pointerType === 'touch' || pointerType === 'pen';
    this.controls.rotateSpeed = isTouch ? 0.35 : 0.8;
    this.controls.zoomSpeed = isTouch ? 0.55 : 1;
    this.controls.panSpeed = isTouch ? 0.45 : 1;
    this.controls.dampingFactor = isTouch ? 0.18 : 0.08;
  }

  addLabel(text, className, scenePosition) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    this.labelLayer.appendChild(element);
    return { element, position: new THREE.Vector3(...scenePosition) };
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
    // Point sizes are in light years; this turns them into device pixels at a distance.
    this.pointScale.value = (height * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.width = width;
    this.height = height;
  }

  /**
   * New map data. isSameView: the same filters as before, with more jumps (a live update), so the
   * camera stays and, if the replay was at the end, the new jumps animate in.
   */
  setData(data, { isSameView = false } = {}) {
    const previousEnd = this.travel?.end ?? 0;
    const wasAtEnd = !this.travel || this.position >= previousEnd - 1e-6;
    const previousCount = this.travel?.jumpCount ?? 0;
    this.disposeTravel();
    this.travel = buildTravel(data, this.pace, this.pointScale, this.timeline, this.clock);
    for (const object of this.travel.objects) this.scene.add(object);
    this.travel.headLabels = data.commanders.map((commander, index) => {
      const label = this.addLabel(`CMDR ${commander.name}`, 'galaxy-label galaxy-label-commander', [0, 0, 0]);
      label.element.style.color = COMMANDER_COLORS[index % COMMANDER_COLORS.length];
      return label;
    });
    this.applyColors();
    this.applyTrailStyle();

    if (isSameView && wasAtEnd && this.travel.jumpCount > previousCount && previousCount > 0) {
      this.position = Math.min(previousEnd, this.travel.end);
      this.playTo(this.travel.end, 2.5);
    } else if (isSameView) {
      this.position = Math.min(this.position, this.travel.end);
    } else {
      this.position = this.travel.end;
      this.isPlaying = false;
      this.fitToTravels({ isInstant: !this.hasFitOnce });
      this.hasFitOnce = true;
    }
    this.reportProgress(true);
  }

  disposeTravel() {
    if (!this.travel) return;
    for (const object of this.travel.objects) {
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    for (const label of this.travel.headLabels ?? []) label.element.remove();
    this.travel = null;
  }

  setPace(pace) {
    if (pace === this.pace) return;
    const fraction = this.travel ? this.position / (this.travel.end || 1) : 1;
    const realTime = this.travel ? getRealTime(this.travel, this.position) : null;
    this.pace = pace;
    if (!this.travel) return;
    retimeTravel(this.travel, pace);
    // Stay at the same moment, as near as possible.
    this.position = realTime === null ? fraction * this.travel.end : getPositionForRealTime(this.travel, realTime);
    this.reportProgress(true);
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  /** How bright the galaxy backdrop is, 0 (off) to 2 (twice the default); the trails aren't affected. */
  setGalaxyBrightness(brightness) {
    this.galaxyBrightness = brightness;
  }

  /** How many jumps finish in each of a number of equal slices of the timeline, for the activity strip. */
  getActivity(binCount) {
    const bins = new Array(binCount).fill(0);
    if (!this.travel || this.travel.end <= 0) return bins;
    const { ends, jumpCount, end } = this.travel;
    for (let index = 0; index < jumpCount; index += 1) {
      bins[Math.min(binCount - 1, Math.floor((ends[index] / end) * binCount))] += 1;
    }
    return bins;
  }

  setColorMode(colorMode) {
    this.colorMode = colorMode;
    this.applyColors();
  }

  applyColors() {
    if (!this.travel) return;
    const { trailColors, jumps, trail } = this.travel;
    const palette = (this.colorMode === 'commander' ? COMMANDER_COLORS : JUMP_KIND_COLORS).map((hex) => new THREE.Color(hex));
    trail.segmentJumps.forEach((jumpIndex, segmentIndex) => {
      const key = this.colorMode === 'commander' ? jumps.commander[jumpIndex] : jumps.kind[jumpIndex];
      const color = palette[key % palette.length];
      for (let vertex = 0; vertex < 2; vertex += 1) {
        trailColors.setXYZ(segmentIndex * 2 + vertex, color.r, color.g, color.b);
      }
    });
    trailColors.needsUpdate = true;
  }

  /** "trail": the whole history stays faintly; "comet": only the latest jumps glow. */
  setTrailStyle(trailStyle) {
    this.trailStyle = trailStyle;
    this.applyTrailStyle();
  }

  applyTrailStyle() {
    if (!this.travel) return;
    this.travel.trailMaterial.uniforms.uFloor.value = this.trailStyle === 'comet' ? 0.015 : 0.2;
  }

  play() {
    if (!this.travel || this.travel.jumpCount === 0) return;
    if (this.position >= this.travel.end - 1e-6) this.position = 0;
    this.playTarget = null;
    this.isPlaying = true;
    this.reportProgress(true);
  }

  pause() {
    this.isPlaying = false;
    this.playTarget = null;
    this.reportProgress(true);
  }

  /** Plays from here to a position over a set time (new live jumps arriving). */
  playTo(position, seconds) {
    this.playTarget = { position, rate: Math.max(1e-6, (position - this.position) / seconds) };
    this.isPlaying = true;
  }

  seek(position) {
    if (!this.travel) return;
    this.position = THREE.MathUtils.clamp(position, 0, this.travel.end);
    this.reportProgress(true);
  }

  setFollowing(isFollowing) {
    this.isFollowing = isFollowing;
    if (isFollowing) this.cameraFlight = null;
  }

  /** Frames every system on the map. */
  fitToTravels({ isInstant = false } = {}) {
    if (!this.travel || this.travel.systemCount === 0) {
      this.showGalaxy({ isInstant });
      return;
    }
    const { center, radius } = this.travel.bounds;
    const distance = Math.max(MIN_FIT_RADIUS, radius) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    this.flyTo(center, distance, { isInstant, direction: new THREE.Vector3(0.35, 0.75, -0.55) });
  }

  showGalaxy({ isInstant = false } = {}) {
    this.isFollowing = false;
    this.flyTo(new THREE.Vector3(...toScene(...GALACTIC_CENTER)), GALAXY_VIEW_DISTANCE, { isInstant, direction: new THREE.Vector3(0.1, 0.85, -0.52) });
  }

  /** Moves the camera to look at a point from a distance, keeping the current angle unless one is given. */
  flyTo(target, distance, { isInstant = false, direction } = {}) {
    const viewDirection = (direction ?? this.camera.position.clone().sub(this.controls.target)).clone().normalize();
    const toTarget = target.clone();
    const toPosition = target.clone().add(viewDirection.multiplyScalar(distance));
    if (isInstant) {
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPosition);
      this.cameraFlight = null;
      return;
    }
    this.cameraFlight = {
      fromTarget: this.controls.target.clone(),
      fromPosition: this.camera.position.clone(),
      toTarget,
      toPosition,
      startedAt: performance.now(),
      durationMs: 1600,
    };
  }

  frame = (now) => {
    this.animationFrame = requestAnimationFrame(this.frame);
    const deltaSeconds = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    this.clock.value = now / 1000;

    if (this.travel && this.isPlaying) {
      const rate = this.playTarget ? this.playTarget.rate : this.travel.baseRate * this.speed;
      const stopAt = this.playTarget ? this.playTarget.position : this.travel.end;
      this.position = Math.min(stopAt, this.position + rate * deltaSeconds);
      if (this.position >= stopAt) {
        this.isPlaying = false;
        this.playTarget = null;
        this.reportProgress(true);
      }
    }
    this.timeline.value = this.position;

    const heads = this.travel ? updateHeads(this.travel, this.position) : null;
    this.updateCamera(now, deltaSeconds, heads);
    this.controls.update();

    // Near and far planes follow the zoom, so close-ups of the bubble and the whole galaxy both work.
    const viewDistance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.05, viewDistance / 2000);
    this.camera.far = Math.max(viewDistance * 40, 600_000);
    this.camera.updateProjectionMatrix();
    this.starfield.position.copy(this.camera.position);
    // The galaxy dims when zoomed in on the travels, so it's a backdrop rather than fog.
    this.galaxy.setOpacity(this.galaxyBrightness * (0.05 + 0.95 * THREE.MathUtils.smoothstep(viewDistance, 3000, 70_000)));

    this.updateLabels(heads);
    this.updateHover();
    this.composer.render();
    this.reportProgress(false);
  };

  updateCamera(now, deltaSeconds, heads) {
    if (this.cameraFlight) {
      const flight = this.cameraFlight;
      const progress = Math.min(1, (now - flight.startedAt) / flight.durationMs);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
      this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
      if (progress >= 1) this.cameraFlight = null;
      return;
    }
    if (this.isFollowing && heads?.leader && !this.isUserMoving) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.lerp(heads.leader, 1 - Math.exp(-deltaSeconds * 4));
      this.camera.position.copy(this.controls.target).add(offset);
    }
  }

  updateLabels(heads) {
    const projected = new THREE.Vector3();
    const place = (label, position, isShown = true) => {
      projected.copy(position).project(this.camera);
      const isVisible = isShown && projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      label.element.style.display = isVisible ? '' : 'none';
      if (!isVisible) return;
      const x = ((projected.x + 1) / 2) * this.width;
      const y = ((1 - projected.y) / 2) * this.height;
      label.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    };
    // Landmarks close to the camera's target crowd the view of the travels around them less when hidden.
    const viewDistance = this.camera.position.distanceTo(this.controls.target);
    for (const label of this.landmarkLabels) {
      const isClose = label.position.distanceTo(this.camera.position) < 25;
      place(label, label.position, !isClose && viewDistance > 60);
    }
    if (this.travel && heads) {
      this.travel.headLabels.forEach((label, index) => place(label, heads.positions[index], heads.isActive[index]));
      this.stackCommanderLabels(heads);
    }
  }

  /** Commanders in the same place (often the bubble) get their names stacked instead of on top of each other. */
  stackCommanderLabels(heads) {
    const projected = new THREE.Vector3();
    const placed = [];
    this.travel.headLabels.forEach((label, index) => {
      if (label.element.style.display === 'none' || !heads.isActive[index]) return;
      projected.copy(heads.positions[index]).project(this.camera);
      const x = ((projected.x + 1) / 2) * this.width;
      let y = ((1 - projected.y) / 2) * this.height;
      while (placed.some((other) => Math.abs(other.x - x) < 140 && Math.abs(other.y - y) < 19)) y -= 19;
      placed.push({ x, y });
      label.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
  }

  updateHover() {
    if (!this.pointer || !this.travel || this.isUserMoving) return;
    // Every system is projected to find the nearest; a few times a second is plenty.
    const now = performance.now();
    if (now - (this.lastHoverAt ?? 0) < 60) return;
    this.lastHoverAt = now;
    const { systems, systemPositions, systemAppearAt } = this.travel;
    const matrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const elements = matrix.elements;
    let best = null;
    let bestDistance = 12 * 12;
    for (let index = 0; index < systems.length; index += 1) {
      if (systemAppearAt[index] > this.position) continue;
      const x = systemPositions[index * 3];
      const y = systemPositions[index * 3 + 1];
      const z = systemPositions[index * 3 + 2];
      const w = elements[3] * x + elements[7] * y + elements[11] * z + elements[15];
      if (w <= 0) continue;
      const screenX = (((elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) / w + 1) / 2) * this.width;
      const screenY = ((1 - (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) / w) / 2) * this.height;
      const distance = (screenX - this.pointer.x) ** 2 + (screenY - this.pointer.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { index, screenX, screenY };
      }
    }
    const hovered = best ? {
      ...systems[best.index],
      x: best.screenX,
      y: best.screenY,
      scenePosition: new THREE.Vector3(systemPositions[best.index * 3], systemPositions[best.index * 3 + 1], systemPositions[best.index * 3 + 2]),
    } : null;
    if (hovered?.name !== this.hoveredSystem?.name || (hovered && (Math.abs(hovered.x - this.hoveredSystem.x) > 1 || Math.abs(hovered.y - this.hoveredSystem.y) > 1))) {
      this.hoveredSystem = hovered;
      this.onHover(hovered);
    }
  }

  /** Tells the page where playback is: every frame would re-render React too often, so a few times a second. */
  reportProgress(isForced) {
    const now = performance.now();
    if (!isForced && (!this.isPlaying || now - this.lastProgressAt < 120)) return;
    this.lastProgressAt = now;
    if (!this.travel) {
      this.onProgress(null);
      return;
    }
    const { travel } = this;
    const reached = countReached(travel, this.position);
    this.onProgress({
      position: this.position,
      end: travel.end,
      isPlaying: this.isPlaying,
      realTime: getRealTime(travel, this.position),
      jumps: reached,
      distance: reached > 0 ? travel.distanceUpTo[reached - 1] : 0,
      newSystems: reached > 0 ? travel.newSystemsUpTo[reached - 1] : 0,
      systems: reached > 0 ? travel.systemsUpTo[reached - 1] : 0,
    });
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown, true);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.handlePointerLeave);
    this.renderer.domElement.removeEventListener('dblclick', this.handleDoubleClick);
    this.disposeTravel();
    for (const object of [this.starfield, this.landmarkMarkers, ...this.galaxy.layers]) {
      object.geometry.dispose();
      object.material.dispose();
    }
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// Travel: trails, systems and the commanders' current positions.

const TRAIL_VERTEX_SHADER = `
  attribute float aTime;
  attribute vec3 aColor;
  varying float vTime;
  varying vec3 vColor;
  void main() {
    vTime = aTime;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uFade;
  uniform float uFloor;
  varying float vTime;
  varying vec3 vColor;
  void main() {
    if (vTime > uTime) discard;
    float glow = exp(-(uTime - vTime) / uFade);
    float brightness = uFloor + (1.0 - uFloor) * glow;
    // The newest part of a trail burns white-hot.
    vec3 color = mix(vColor, vec3(1.0), glow * glow * 0.55);
    gl_FragColor = vec4(color * brightness * 1.4, 1.0);
  }
`;

const SYSTEM_VERTEX_SHADER = `
  attribute float aAppear;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uScale;
  uniform float uPulse;
  varying vec3 vColor;
  varying float vFlash;
  void main() {
    if (aAppear > uTime) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Each arrival flashes, then settles.
    vFlash = exp(-(uTime - aAppear) / uPulse);
    float size = clamp(aSize * uScale / -viewPosition.z, 2.5, 22.0);
    gl_PointSize = size * (1.0 + 2.5 * vFlash);
    vColor = aColor;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const SYSTEM_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vFlash;
  void main() {
    float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
    if (distanceFromCenter > 1.0) discard;
    float core = smoothstep(0.35, 0.0, distanceFromCenter);
    float halo = exp(-distanceFromCenter * distanceFromCenter * 7.0) * 0.35;
    float ring = smoothstep(0.12, 0.0, abs(distanceFromCenter - 0.8)) * vFlash;
    vec3 color = vColor * (halo + core * 0.8) + vec3(1.0) * (core * 0.3 + ring);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const HEAD_VERTEX_SHADER = `
  attribute vec3 aColor;
  attribute float aActive;
  uniform float uClock;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    vColor = aColor;
    vPhase = fract(uClock * 0.7);
    gl_PointSize = aActive > 0.5 ? 30.0 : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HEAD_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
    if (distanceFromCenter > 1.0) discard;
    float core = smoothstep(0.2, 0.05, distanceFromCenter);
    float glow = exp(-distanceFromCenter * distanceFromCenter * 14.0) * 0.5;
    // A ring ripples outwards, like a scanner ping.
    float ring = smoothstep(0.08, 0.0, abs(distanceFromCenter - vPhase)) * (1.0 - vPhase);
    gl_FragColor = vec4(vColor * (glow + ring * 0.9 + core * 0.5) + vec3(core * 0.5), 1.0);
  }
`;

const ADDITIVE = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };
/**
 * The brighter of what's there and what's drawn, instead of their sum: thousands of trails and
 * systems overlap around the bubble, and added up they burned Sol out to a white blob that hid
 * the trails near it. This way a crowded place is no brighter than one trail.
 */
const BRIGHTEST = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation };

function buildTravel(data, pace, pointScale, timeline, clock) {
  const { jumps, systems, commanders } = data;
  const jumpCount = jumps.to.length;

  const systemPositions = new Float32Array(systems.length * 3);
  systems.forEach((system, index) => systemPositions.set(toScene(system.x, system.y, system.z), index * 3));

  // One line segment per jump that knows where it started.
  const segmentJumps = [];
  for (let index = 0; index < jumpCount; index += 1) if (jumps.from[index] >= 0) segmentJumps.push(index);
  const trailPositions = new Float32Array(segmentJumps.length * 6);
  segmentJumps.forEach((jumpIndex, segmentIndex) => {
    trailPositions.set(systemPositions.subarray(jumps.from[jumpIndex] * 3, jumps.from[jumpIndex] * 3 + 3), segmentIndex * 6);
    trailPositions.set(systemPositions.subarray(jumps.to[jumpIndex] * 3, jumps.to[jumpIndex] * 3 + 3), segmentIndex * 6 + 3);
  });
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  const trailTimes = new THREE.BufferAttribute(new Float32Array(segmentJumps.length * 2), 1);
  trailGeometry.setAttribute('aTime', trailTimes);
  const trailColors = new THREE.BufferAttribute(new Float32Array(segmentJumps.length * 6), 3);
  trailGeometry.setAttribute('aColor', trailColors);
  const trailMaterial = new THREE.ShaderMaterial({
    ...BRIGHTEST,
    uniforms: { uTime: timeline, uFade: { value: 10 }, uFloor: { value: 0.2 } },
    vertexShader: TRAIL_VERTEX_SHADER,
    fragmentShader: TRAIL_FRAGMENT_SHADER,
  });
  const trail = new THREE.LineSegments(trailGeometry, trailMaterial);
  trail.frustumCulled = false;
  trail.segmentJumps = segmentJumps;

  const systemGeometry = new THREE.BufferGeometry();
  systemGeometry.setAttribute('position', new THREE.BufferAttribute(systemPositions, 3));
  const systemColors = new Float32Array(systems.length * 3);
  const systemSizes = new Float32Array(systems.length);
  systems.forEach((system, index) => {
    const color = new THREE.Color(describeStarClass(system.starClass).color);
    systemColors.set([color.r, color.g, color.b], index * 3);
    systemSizes[index] = 1.1 + Math.log2(1 + system.visits) * 0.55;
  });
  systemGeometry.setAttribute('aColor', new THREE.BufferAttribute(systemColors, 3));
  systemGeometry.setAttribute('aSize', new THREE.BufferAttribute(systemSizes, 1));
  const systemAppear = new THREE.BufferAttribute(new Float32Array(systems.length), 1);
  systemGeometry.setAttribute('aAppear', systemAppear);
  const systemMaterial = new THREE.ShaderMaterial({
    ...BRIGHTEST,
    uniforms: { uTime: timeline, uScale: pointScale, uPulse: { value: 1 } },
    vertexShader: SYSTEM_VERTEX_SHADER,
    fragmentShader: SYSTEM_FRAGMENT_SHADER,
  });
  const systemPoints = new THREE.Points(systemGeometry, systemMaterial);
  systemPoints.frustumCulled = false;

  const headGeometry = new THREE.BufferGeometry();
  const headPositions = new THREE.BufferAttribute(new Float32Array(commanders.length * 3), 3);
  headGeometry.setAttribute('position', headPositions);
  const headColors = new Float32Array(commanders.length * 3);
  commanders.forEach((commander, index) => {
    const color = new THREE.Color(COMMANDER_COLORS[index % COMMANDER_COLORS.length]);
    headColors.set([color.r, color.g, color.b], index * 3);
  });
  headGeometry.setAttribute('aColor', new THREE.BufferAttribute(headColors, 3));
  const headActive = new THREE.BufferAttribute(new Float32Array(commanders.length), 1);
  headGeometry.setAttribute('aActive', headActive);
  const headMaterial = new THREE.ShaderMaterial({
    // Commanders often sit in the same place (the bubble); stacked, they mustn't add up to a blob.
    ...BRIGHTEST,
    uniforms: { uClock: clock },
    vertexShader: HEAD_VERTEX_SHADER,
    fragmentShader: HEAD_FRAGMENT_SHADER,
  });
  const headPoints = new THREE.Points(headGeometry, headMaterial);
  headPoints.frustumCulled = false;
  // Over the galaxy (0-2) and the landmarks (3): trails, then systems, then the commanders.
  trail.renderOrder = 4;
  systemPoints.renderOrder = 5;
  headPoints.renderOrder = 6;

  // Running totals by jump, for the counters during playback.
  const distanceUpTo = new Float64Array(jumpCount);
  const newSystemsUpTo = new Uint32Array(jumpCount);
  const systemsUpTo = new Uint32Array(jumpCount);
  const seenSystems = new Uint8Array(systems.length);
  let distance = 0;
  let newSystems = 0;
  let systemsSeen = 0;
  for (let index = 0; index < jumpCount; index += 1) {
    distance += jumps.distance[index] ?? 0;
    newSystems += jumps.firstVisit[index] ? 1 : 0;
    if (!seenSystems[jumps.to[index]]) {
      seenSystems[jumps.to[index]] = 1;
      systemsSeen += 1;
    }
    distanceUpTo[index] = distance;
    newSystemsUpTo[index] = newSystems;
    systemsUpTo[index] = systemsSeen;
  }

  const jumpsByCommander = commanders.map(() => []);
  for (let index = 0; index < jumpCount; index += 1) jumpsByCommander[jumps.commander[index]].push(index);

  const travel = {
    jumps,
    systems,
    commanders,
    jumpCount,
    systemCount: systems.length,
    systemPositions,
    systemAppearAt: systemAppear.array,
    trail,
    trailTimes,
    trailColors,
    trailMaterial,
    systemAppear,
    systemMaterial,
    headPositions,
    headActive,
    jumpsByCommander,
    distanceUpTo,
    newSystemsUpTo,
    systemsUpTo,
    bounds: getBounds(systemPositions),
    objects: [trail, systemPoints, headPoints],
  };
  retimeTravel(travel, pace);
  return travel;
}

/**
 * Works out each jump's place on the timeline for a pace: "jumps" gives every jump the same time;
 * "time" follows the clock, with long idle gaps shortened. Each jump draws from `starts` to `ends`.
 */
function retimeTravel(travel, pace) {
  const { jumps, jumpCount, jumpsByCommander } = travel;
  const ends = new Float64Array(jumpCount);
  const starts = new Float64Array(jumpCount);
  if (pace === 'time') {
    let position = JUMP_DRAW_SECONDS;
    for (let index = 0; index < jumpCount; index += 1) {
      if (index > 0) position += Math.min(MAX_IDLE_GAP_SECONDS, Math.max(0, jumps.time[index] - jumps.time[index - 1]));
      ends[index] = position;
    }
    for (const commanderJumps of jumpsByCommander) {
      commanderJumps.forEach((jumpIndex, order) => {
        const previousEnd = order > 0 ? ends[commanderJumps[order - 1]] : 0;
        starts[jumpIndex] = Math.max(previousEnd, ends[jumpIndex] - JUMP_DRAW_SECONDS);
      });
    }
  } else {
    for (let index = 0; index < jumpCount; index += 1) {
      starts[index] = index;
      ends[index] = index + 1;
    }
  }
  travel.starts = starts;
  travel.ends = ends;
  travel.end = jumpCount > 0 ? ends[jumpCount - 1] : 0;
  const unitsPerJump = jumpCount > 0 ? travel.end / jumpCount : 1;
  // At 1×, the whole replay takes about a minute, but never faster than it reads (a handful of jumps).
  travel.baseRate = Math.max(travel.end / BASE_REPLAY_SECONDS, unitsPerJump * 0.4);
  travel.trailMaterial.uniforms.uFade.value = unitsPerJump * 12;
  travel.systemMaterial.uniforms.uPulse.value = unitsPerJump * 1.5;

  travel.trail.segmentJumps.forEach((jumpIndex, segmentIndex) => {
    travel.trailTimes.setX(segmentIndex * 2, starts[jumpIndex]);
    travel.trailTimes.setX(segmentIndex * 2 + 1, ends[jumpIndex]);
  });
  travel.trailTimes.needsUpdate = true;

  // A system appears when it's first reached, or when a jump first leaves it.
  const appear = travel.systemAppear.array;
  appear.fill(Infinity);
  for (let index = 0; index < jumpCount; index += 1) {
    const from = jumps.from[index];
    if (from >= 0 && starts[index] < appear[from]) appear[from] = starts[index];
    if (ends[index] < appear[jumps.to[index]]) appear[jumps.to[index]] = ends[index];
  }
  // Infinity doesn't survive the trip to the graphics card everywhere.
  for (let index = 0; index < appear.length; index += 1) if (appear[index] === Infinity) appear[index] = 1e30;
  travel.systemAppear.needsUpdate = true;
}

/** How many jumps have finished by a timeline position. */
function countReached(travel, position) {
  let low = 0;
  let high = travel.jumpCount;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (travel.ends[middle] <= position + 1e-9) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The real date and time (ms) at a timeline position, between the jumps either side. */
function getRealTime(travel, position) {
  const { jumpCount, ends, jumps } = travel;
  if (jumpCount === 0) return null;
  const reached = countReached(travel, position);
  if (reached === 0) return jumps.time[0] * 1000;
  if (reached >= jumpCount) return jumps.time[jumpCount - 1] * 1000;
  const fromEnd = ends[reached - 1];
  const toEnd = ends[reached];
  const fraction = toEnd > fromEnd ? (position - fromEnd) / (toEnd - fromEnd) : 0;
  return (jumps.time[reached - 1] + fraction * (jumps.time[reached] - jumps.time[reached - 1])) * 1000;
}

function getPositionForRealTime(travel, realTime) {
  const seconds = realTime / 1000;
  const { jumps, jumpCount, ends } = travel;
  let index = 0;
  while (index < jumpCount && jumps.time[index] <= seconds) index += 1;
  return index === 0 ? 0 : ends[index - 1];
}

/** Moves each commander's marker to where they are at a position, partway along a jump if mid-jump. */
function updateHeads(travel, position) {
  const { jumpsByCommander, starts, ends, jumps, systemPositions, headPositions, headActive } = travel;
  const positions = [];
  const isActive = [];
  let leader = null;
  let leaderStart = -Infinity;
  jumpsByCommander.forEach((commanderJumps, commanderIndex) => {
    // The commander's last jump that has started.
    let low = 0;
    let high = commanderJumps.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[commanderJumps[middle]] <= position) low = middle + 1;
      else high = middle;
    }
    const current = low - 1;
    const point = new THREE.Vector3();
    let isShown = true;
    if (current < 0) {
      isShown = false;
    } else {
      const jumpIndex = commanderJumps[current];
      const to = jumps.to[jumpIndex];
      const from = jumps.from[jumpIndex];
      const toPoint = new THREE.Vector3().fromArray(systemPositions, to * 3);
      const span = ends[jumpIndex] - starts[jumpIndex];
      if (from >= 0 && position < ends[jumpIndex] && span > 0) {
        point.fromArray(systemPositions, from * 3).lerp(toPoint, (position - starts[jumpIndex]) / span);
      } else {
        point.copy(toPoint);
      }
      if (starts[jumpIndex] > leaderStart) {
        leaderStart = starts[jumpIndex];
        leader = point;
      }
    }
    positions.push(point);
    isActive.push(isShown);
    headPositions.setXYZ(commanderIndex, point.x, point.y, point.z);
    headActive.setX(commanderIndex, isShown ? 1 : 0);
  });
  headPositions.needsUpdate = true;
  headActive.needsUpdate = true;
  return { positions, isActive, leader };
}

function getBounds(positions) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let index = 0; index < positions.length; index += 3) box.expandByPoint(point.fromArray(positions, index));
  const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 0) : box.getBoundingSphere(new THREE.Sphere());
  return { center: sphere.center, radius: sphere.radius };
}

// ---------------------------------------------------------------------------------------------
// The galaxy backdrop.

const GLOW_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    float distance = -viewPosition.z;
    float size = aSize * uScale / max(distance, 0.001);
    // Particles the camera is among fade away instead of filling the screen.
    float nearFade = smoothstep(aSize * 2.0, aSize * 14.0, distance);
    // Below a pixel, the particle dims instead of shrinking further.
    float subPixel = clamp(size, 0.0, 1.0);
    gl_PointSize = clamp(size, 1.0, 48.0);
    vAlpha = uOpacity * nearFade * subPixel;
    vColor = aColor;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const GLOW_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float falloff = exp(-dot(offset, offset) * 14.0);
    gl_FragColor = vec4(vColor, falloff * vAlpha);
  }
`;

function createGalaxy(pointScale) {
  const random = createRandom(3301);
  const gaussian = () => {
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    return radius * Math.cos(2 * Math.PI * random());
  };
  const [centerX, centerY, centerZ] = GALACTIC_CENTER;
  const solRadius = Math.hypot(centerX, centerZ);
  // Angles are measured around the core (atan2 of x, z); the galaxy turns towards larger angles.
  const solAngle = Math.atan2(-centerX, -centerZ);
  const pitch = THREE.MathUtils.degToRad(13);
  const winding = 1 / Math.tan(pitch);
  // Trailing arms: further out, an arm lags behind the rotation. Sol sits between two of them.
  const armAngle = (armIndex, radius) => solAngle + Math.PI / 4 + (armIndex * Math.PI) / 2 - winding * Math.log(radius / solRadius);
  const barAngle = solAngle + Math.PI + THREE.MathUtils.degToRad(27);

  const glow = { positions: [], colors: [], sizes: [] };
  const haze = { positions: [], colors: [], sizes: [] };
  const dust = { positions: [], colors: [], sizes: [] };
  const color = new THREE.Color();
  const add = (layer, x, y, z, hex, lightness, size) => {
    layer.positions.push(...toScene(centerX + x, centerY + y, centerZ + z));
    color.set(hex).multiplyScalar(lightness);
    layer.colors.push(color.r, color.g, color.b);
    layer.sizes.push(size);
  };
  const polar = (radius, angle) => [radius * Math.sin(angle), radius * Math.cos(angle)];
  const coreColor = new THREE.Color('#ffd49a');
  const armColor = new THREE.Color('#a9c4ff');
  const mixed = new THREE.Color();
  const armHex = (radius) => `#${mixed.copy(coreColor).lerp(armColor, THREE.MathUtils.smoothstep(radius, 4000, 16_000)).getHexString()}`;

  // The bulge and the bar.
  for (let index = 0; index < 16_000; index += 1) {
    const isBar = index % 2 === 0;
    const along = isBar ? gaussian() * 4200 : gaussian() * 2300;
    const across = isBar ? gaussian() * 1300 : gaussian() * 2300;
    const angle = isBar ? barAngle : random() * Math.PI * 2;
    const x = along * Math.sin(angle) + across * Math.cos(angle);
    const z = along * Math.cos(angle) - across * Math.sin(angle);
    const radius = Math.hypot(x, z);
    add(glow, x, gaussian() * (isBar ? 650 : 1500), z, random() < 0.25 ? '#fff1d8' : '#ffb867', Math.max(0.02, 0.13 + random() * 0.1 - radius / 60_000), 220 + random() * 380);
  }

  // Four arms, two of them stronger, and the Orion Spur that Sol lives on.
  for (let index = 0; index < 110_000; index += 1) {
    const armIndex = index % 6 < 4 ? index % 2 : 2 + (index % 2);
    const isMajor = armIndex < 2;
    const radius = 3500 + Math.min(52_000, -Math.log(1 - random()) * (isMajor ? 13_000 : 11_000));
    const width = 900 + radius * 0.035;
    const angle = armAngle(armIndex, radius) + (gaussian() * width) / radius;
    const [x, z] = polar(radius + gaussian() * width * 0.5, angle);
    const thickness = 180 + radius * 0.006;
    // Arms start faint where they leave the bar, so the middle doesn't pile up.
    const innerFade = 0.3 + 0.7 * THREE.MathUtils.smoothstep(radius, 3000, 13_000);
    const lightness = (isMajor ? 0.55 : 0.4) * (0.6 + random() * 0.6) * Math.min(1, 1.25 - radius / 60_000) * innerFade;
    add(glow, x, gaussian() * thickness, z, random() < 0.12 ? '#ffe2b8' : armHex(radius), lightness, 140 + random() * 260);
  }
  for (let index = 0; index < 9000; index += 1) {
    const radius = solRadius - 4500 + random() * 10_000;
    const angle = solAngle - winding * 0.55 * Math.log(radius / solRadius) + (gaussian() * 700) / radius;
    const [x, z] = polar(radius + gaussian() * 300, angle);
    add(glow, x, gaussian() * 220, z, '#c4d4ff', 0.3 + random() * 0.25, 120 + random() * 200);
  }

  // A thin disk of old stars between the arms.
  for (let index = 0; index < 40_000; index += 1) {
    const radius = Math.min(60_000, -Math.log(1 - random()) * 15_000);
    const [x, z] = polar(radius, random() * Math.PI * 2);
    const innerFade = 0.25 + 0.75 * THREE.MathUtils.smoothstep(radius, 2000, 12_000);
    add(haze, x, gaussian() * 500, z, armHex(radius * 0.8), 0.35 * (1.1 - radius / 60_000) * innerFade, 400 + random() * 600);
  }

  // Glowing nebulae (pink star-forming regions, a few blue ones) along the arms.
  // In clumps, as star-forming regions are, rather than evenly along the arm.
  for (let clump = 0; clump < 260; clump += 1) {
    const armIndex = clump % 4;
    const clumpRadius = 6000 + random() * 42_000;
    const clumpAngle = armAngle(armIndex, clumpRadius) + (gaussian() * 1400) / clumpRadius;
    const hex = random() < 0.75 ? '#ff5fa8' : random() < 0.5 ? '#ff8f6b' : '#5fd4ff';
    const clumpSize = 1 + Math.floor(random() * 7);
    for (let index = 0; index < clumpSize; index += 1) {
      const [x, z] = polar(clumpRadius + gaussian() * 500, clumpAngle + (gaussian() * 500) / clumpRadius);
      add(haze, x, gaussian() * 150, z, hex, 0.18 + random() * 0.3, 500 + random() * 1300);
    }
  }

  // Dark dust lanes on the inner edge of the arms.
  for (let index = 0; index < 22_000; index += 1) {
    const armIndex = index % 4;
    const radius = 5000 + Math.min(45_000, -Math.log(1 - random()) * 14_000);
    const angle = armAngle(armIndex, radius) - (700 + radius * 0.02) / radius + (gaussian() * 450) / radius;
    const [x, z] = polar(radius, angle);
    add(dust, x, gaussian() * 120, z, '#05030a', 1, 500 + random() * 700);
  }

  const opacityUniforms = [];
  const makeLayer = (layer, layerOpacity, blending, renderOrder) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(layer.positions, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(layer.colors, 3));
    geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(layer.sizes, 1));
    const opacity = { value: layerOpacity };
    opacityUniforms.push({ uniform: opacity, full: layerOpacity });
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending,
      uniforms: { uScale: pointScale, uOpacity: opacity },
      vertexShader: GLOW_VERTEX_SHADER,
      fragmentShader: GLOW_FRAGMENT_SHADER,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    return points;
  };
  // Kept low: thousands of particles overlap in the core, and on high-density screens even more of
  // them land on each pixel, so anything brighter burns out to white and drowns the trails.
  const layers = [
    makeLayer(haze, 0.13, THREE.AdditiveBlending, 0),
    makeLayer(glow, 0.22, THREE.AdditiveBlending, 1),
    // Drawn over the glow (normal blending), so the lanes darken it.
    makeLayer(dust, 0.22, THREE.NormalBlending, 2),
  ];
  return {
    layers,
    /** 0-1 of each layer's full strength. */
    setOpacity(fraction) {
      for (const { uniform, full } of opacityUniforms) uniform.value = full * fraction;
    },
  };
}

const STARFIELD_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  uniform float uClock;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = 0.55 + 0.45 * sin(uClock * (0.6 + aPhase) + aPhase * 40.0);
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Distant background stars that travel with the camera, so they always look infinitely far away. */
function createStarfield(pointScale, clock) {
  const random = createRandom(42);
  const count = 7000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const palette = ['#ffffff', '#cfdcff', '#ffe9c4', '#ffd0a8', '#bcd0ff'].map((hex) => new THREE.Color(hex));
  for (let index = 0; index < count; index += 1) {
    const theta = random() * Math.PI * 2;
    const cosPhi = random() * 2 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    positions.set([sinPhi * Math.cos(theta) * 1000, cosPhi * 1000, sinPhi * Math.sin(theta) * 1000], index * 3);
    const tint = palette[Math.floor(random() * palette.length)];
    const brightness = 0.25 + random() ** 3 * 0.75;
    colors.set([tint.r * brightness, tint.g * brightness, tint.b * brightness], index * 3);
    sizes[index] = (1 + random() ** 4 * 2.5) * Math.min(window.devicePixelRatio, 2);
    phases[index] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    ...ADDITIVE,
    uniforms: { uClock: clock, uScale: pointScale },
    vertexShader: STARFIELD_VERTEX_SHADER,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(vColor, smoothstep(1.0, 0.0, distanceFromCenter) * vAlpha);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

/** Small diamond markers on the landmarks. */
function createLandmarkMarkers(pointScale, clock) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(LANDMARKS.flatMap((landmark) => toScene(...landmark.position)), 3));
  const material = new THREE.ShaderMaterial({
    ...ADDITIVE,
    uniforms: { uClock: clock },
    vertexShader: `
      void main() {
        gl_PointSize = 14.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      void main() {
        vec2 offset = abs(gl_PointCoord - 0.5) * 2.0;
        float diamond = offset.x + offset.y;
        float outline = smoothstep(0.16, 0.0, abs(diamond - 0.8));
        gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * outline, outline * 0.8);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return points;
}

/** A small seeded random number generator (mulberry32), so the galaxy looks the same every time. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
