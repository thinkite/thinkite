// The kite sky in three.js: a small phone lying on its back, its screen
// glowing. Light rises from the screen, a rainbow by day and an aurora by
// night; in it float the Thinkite icon, as a thick rounded tile, and each
// model, as a rounded tile in its maker's colours, circling the beam on one
// of two rings. The screen lights the tiles from below.
//
// The kite buttons stay in the DOM for hover names and focus; each frame
// moves them over their tiles.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Fog,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The aurora's colours: teal low down, violet, pink up top.
const AURORA = ["#4fd8c4", "#8f7bf0", "#ee86d2"];
// The rainbow's hue at a height from 0 (the screen) to 1: gold (50°), then
// the long way round through orange, pink and violet to sky blue (200°),
// never through the yellow-greens and greens that read cheap and muddy
// against the sky. The beam's shader uses the same sweep.
const rainbowHue = (rise: number) => ((410 - 210 * rise) % 360) / 360;

// Same corner as .app-icon (iOS continuous corner, approximated).
const RADIUS = 0.2245;
const DEPTH = 0.07;
const BEVEL = 0.035;
const FOV = 30;
const DEG = Math.PI / 180;
// The camera looks on almost level, so the phone, lying flat, shows as a
// thin slit of light; PHONE_TILT would lift its far end toward the viewer.
const ELEVATION = 5 * DEG;
const PHONE_TILT = 0;
const PHONE = { width: 0.58, height: 1.18, radius: 0.105, depth: 0.045 };
const CENTRE = { size: 1.45, height: 2.6 };
// The beam leaves the screen as wide as the screen and widens as it rises.
const BEAM = { bottom: 0.55, top: 2.5, height: 3.3, base: 0.07 };
const MOTES = 22;
// Two rings around the beam, one above the icon and one below, turning
// opposite ways. The camera looks on almost level, so each ring's plane
// tips its near side down (by tilt) to show as an ellipse, as Saturn's do.
// On a phone they draw in and spread apart vertically so the scene stands
// taller.
const RINGS = [
  { radius: 1.85, height: 3.45, tilt: 16 * DEG, period: 34, turn: 1 },
  { radius: 2.45, height: 1.75, tilt: 22 * DEG, period: 46, turn: -1 },
];

/** Knobs for trying the scene out (see KiteSky's `?tune` panel in dev). */
export interface Tuning {
  /** How far the phone's far end lifts toward the viewer, in radians. */
  tilt: number;
  /** How far above level the camera looks down, in radians. */
  elevation: number;
  /** Multiplies the beam's brightness. */
  beam: number;
  /** Raises the icon and both rings, in world units. */
  lift: number;
}

export interface SkyKite {
  el: HTMLElement;
  /** Which ring: 0 (upper, inner) or 1 (lower, outer). */
  ring: number;
  /** Where on the ring it starts, 0..1 of a turn. */
  phase: number;
  /** Tile width in world units; the Thinkite tile is 1.45. */
  size: number;
  /** Turn about the tile's own face, in degrees, so noses point different ways. */
  rot: number;
}

// A unit rounded square from (0,0) to (1,1), so the extruded cap's UVs
// (which three takes straight from x and y) cover a texture exactly.
function roundedSquare() {
  const r = RADIUS;
  const s = new Shape();
  s.moveTo(r, 0);
  s.lineTo(1 - r, 0);
  s.quadraticCurveTo(1, 0, 1, r);
  s.lineTo(1, 1 - r);
  s.quadraticCurveTo(1, 1, 1 - r, 1);
  s.lineTo(r, 1);
  s.quadraticCurveTo(0, 1, 0, 1 - r);
  s.lineTo(0, r);
  s.quadraticCurveTo(0, 0, r, 0);
  return s;
}

// A w × h rounded rectangle centred on the origin.
function roundedRect(w: number, h: number, r: number) {
  const [x, y] = [-w / 2, -h / 2];
  const s = new Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function texture(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d") as CanvasRenderingContext2D);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return map;
}

// favicon.svg's sky and four kite panels, drawn into a size × size square.
function drawIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  const k = size / 1024;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = "#CFE6F5";
  ctx.fillRect(0, 0, 1024, 1024);
  const panels: [string, number[]][] = [
    ["#EE8A57", [163.84, 880.64, 430.08, 0, 711.36, 320.08]],
    ["#F6C67D", [430.08, 0, 1024, 0, 711.36, 320.08]],
    ["#DB6480", [1024, 0, 1024, 675.84, 711.36, 320.08]],
    ["#7A63AC", [163.84, 880.64, 711.36, 320.08, 1024, 675.84]],
  ];
  for (const [fill, p] of panels) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

const iconTexture = () =>
  texture(1024, 1024, (ctx) => drawIcon(ctx, 0, 0, 1024));

// A kite's face: its maker's colours from tail (bottom-left) to nose.
const colourTexture = ([a, b, c]: string[]) =>
  texture(256, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 256, 256, 0);
    g.addColorStop(0, a);
    g.addColorStop(0.55, b);
    g.addColorStop(1, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });

// A soft glow around the screen's edge, clear in the middle: a blurred
// rounded rectangle with the screen cut out.
const haloTexture = (sw: number, sh: number, r: number, margin: number) =>
  texture(
    512,
    Math.round((512 * (sh + 2 * margin)) / (sw + 2 * margin)),
    (ctx) => {
      const { width } = ctx.canvas;
      const k = width / (sw + 2 * margin);
      const [x, y, w, h] = [margin * k, margin * k, sw * k, sh * k];
      // Draw the shape far off the canvas and let only its blurred shadow land.
      ctx.shadowColor = "rgba(255,255,255,0.9)";
      ctx.shadowBlur = margin * k * 0.8;
      ctx.shadowOffsetX = width * 2;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.roundRect(x - width * 2, y, w, h, r * k);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r * k);
      ctx.fill();
    },
  );

// A round, soft-edged dot for the motes rising in the beam.
const moteTexture = () =>
  texture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });

// The beam is one flat sheet facing the viewer, not a shell: a shell is
// thickest at its silhouette and reads as two bright lines. The sheet is a
// trapezoid of light, as wide as the screen at the bottom and widening
// upward, brightest down the middle and fading at the sides, the top and
// (briefly) the base.
const beamMaterial = () =>
  new ShaderMaterial({
    uniforms: {
      night: { value: 0 },
      source: { value: new Color("#ffffff") },
      time: { value: 0 },
      strength: { value: 0.5 },
      base: { value: BEAM.bottom / BEAM.top },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float night;
      uniform vec3 source;
      uniform float time;
      uniform float strength;
      uniform float base;
      varying vec2 vUv;
      vec3 hue(float h) {
        return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      }
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        float halfWidth = mix(base, 1.0, vUv.y);
        float side = (vUv.x - 0.5) * 2.0 / halfWidth;
        float d = abs(side);
        // A soft sheet with a brighter core down the middle.
        float spread = 0.7 * (1.0 - smoothstep(0.2, 1.0, d))
          + 0.5 * (1.0 - smoothstep(0.0, 0.45, d));
        float up = smoothstep(0.0, 0.04, vUv.y) * pow(1.0 - vUv.y, 1.8);

        // By day, a rainbow from gold at the screen the long way round to
        // sky blue up high (as rainbowHue), skipping green; pastel, paler
        // down the core, with a slow upward ripple. (Linear light: pastel
        // sRGB squared, roughly.)
        float rise = clamp(vUv.y * 1.35
          + (noise(vec2(side * 1.2, vUv.y * 2.0 - time * 0.15)) - 0.5) * 0.18, 0.0, 1.0);
        vec3 rainbow = mix(vec3(1.0), hue(fract((410.0 - 210.0 * rise) / 360.0)), 0.62);
        rainbow = mix(rainbow, vec3(1.0), (1.0 - smoothstep(0.0, 0.5, d)) * 0.3);

        // By night, an aurora: vertical curtains that sway and drift upward,
        // teal low down, through violet, to pink up top, brighter along each
        // fold.
        float fold = noise(vec2(side * 2.6
          + (noise(vec2(vUv.y * 1.4 - time * 0.12, 1.7)) - 0.5) * 1.4
          + time * 0.05, vUv.y * 0.5 - time * 0.18));
        float curtains = pow(fold, 1.6);
        float height = clamp(vUv.y * 2.0 + (noise(vec2(side * 1.5, time * 0.1)) - 0.5) * 0.5, 0.0, 1.0);
        vec3 aurora = mix(vec3(0.31, 0.85, 0.77), vec3(0.56, 0.48, 0.94), smoothstep(0.0, 0.4, height));
        aurora = mix(aurora, vec3(0.93, 0.53, 0.82), smoothstep(0.4, 0.85, height));

        vec3 color = mix(rainbow * rainbow, aurora * aurora, night);
        // Just above the screen the beam still has the screen's own colour,
        // so the light seems to come out of it rather than start above it.
        color = mix(color, source, (1.0 - smoothstep(0.0, 0.14, vUv.y)) * 0.8);
        float shimmer = mix(1.0, 0.35 + 1.4 * curtains, night);
        gl_FragColor = vec4(color, spread * up * strength * shimmer);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
  });

const glossy = (props: ConstructorParameters<typeof MeshPhysicalMaterial>[0]) =>
  new MeshPhysicalMaterial({
    roughness: 0.55,
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
    ...props,
  });

export function mountSkyScene(canvas: HTMLCanvasElement, kites: SkyKite[]) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  // 1.5× is hard to tell from 2× for soft light and moving tiles, and
  // draws a little over half the pixels.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.toneMapping = NeutralToneMapping;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  // The far side of the rings fades into the sky.
  scene.fog = new Fog("#cfe6f5", 6, 18);
  const sun = new DirectionalLight("#fff6e8", 1.4);
  sun.position.set(-1.5, 3, 2);
  scene.add(sun);
  // The screen's glow, lighting the undersides of everything above it.
  const glow = new PointLight("#cfe6ff", 9, 7, 1.2);
  glow.position.set(0, 0.35, 0.05);
  scene.add(glow);

  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  // The phone: a dark rounded slab on its back, its top end away from the
  // viewer.
  const body = new ExtrudeGeometry(
    roundedRect(PHONE.width, PHONE.height, PHONE.radius),
    {
      depth: PHONE.depth,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 6,
      curveSegments: 16,
    },
  );
  const phone = new Group();
  phone.add(
    new Mesh(
      body,
      glossy({ color: "#24272d", roughness: 0.35, metalness: 0.4 }),
    ),
  );
  // The screen, inset from the edge: plain light in the colour the beam
  // leaves it in, nothing to read at this size anyway.
  const [sw, sh] = [PHONE.width - 0.05, PHONE.height - 0.05];
  const screenMaterial = new MeshBasicMaterial({
    fog: false,
    toneMapped: false,
  });
  const screen = new Mesh(
    new ShapeGeometry(roundedRect(sw, sh, PHONE.radius - 0.045), 12),
    screenMaterial,
  );
  screen.position.z = PHONE.depth + 0.031;
  phone.add(screen);
  // A pill-shaped cutout near the top, so it reads as a phone.
  const island = new Mesh(
    new ShapeGeometry(roundedRect(0.17, 0.05, 0.025), 8),
    new MeshBasicMaterial({ color: "#0b0c0f", fog: false }),
  );
  island.position.set(0, sh / 2 - 0.075, screen.position.z + 0.001);
  phone.add(island);
  const margin = 0.2;
  const haloMaterial = new MeshBasicMaterial({
    map: haloTexture(sw, sh, PHONE.radius - 0.045, margin),
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const halo = new Mesh(
    new PlaneGeometry(sw + 2 * margin, sh + 2 * margin),
    haloMaterial,
  );
  halo.position.z = screen.position.z + 0.002;
  phone.add(halo);
  scene.add(phone);

  const sheet = beamMaterial();
  const beam = new Mesh(new PlaneGeometry(BEAM.top, BEAM.height), sheet);
  beam.position.y = BEAM.base + BEAM.height / 2;
  scene.add(beam);

  // Motes drift up the beam, each at its own pace and place across it, and
  // fade in and out over the climb.
  const motes = Array.from({ length: MOTES }, () => ({
    start: Math.random(),
    hue: Math.random(),
    speed: 0.05 + Math.random() * 0.06,
    across: Math.random() * 2 - 1,
    depth: (Math.random() * 2 - 1) * 0.35,
  }));
  const moteGeometry = new BufferGeometry();
  moteGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(MOTES * 3), 3),
  );
  moteGeometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(MOTES * 4), 4),
  );
  const moteMaterial = new PointsMaterial({
    map: moteTexture(),
    size: 0.11,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    fog: false,
  });
  scene.add(new Points(moteGeometry, moteMaterial));

  // Every tile shares one geometry; group 0 is the two caps, group 1 the
  // sides and bevel.
  const geometry = new ExtrudeGeometry(roundedSquare(), {
    depth: DEPTH,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 8,
    curveSegments: 20,
  });
  geometry.translate(-0.5, -0.5, -DEPTH / 2);

  const icon = iconTexture();
  icon.anisotropy = anisotropy;
  const centre = new Mesh(geometry, [
    glossy({ map: icon }),
    glossy({ color: "#b8d8ef" }),
  ]);
  centre.scale.setScalar(CENTRE.size);
  scene.add(centre);

  const orbiting = kites.map((kite) => {
    const face = glossy({});
    const side = glossy({});
    const mesh = new Mesh(geometry, [face, side]);
    mesh.scale.setScalar(kite.size);
    scene.add(mesh);
    return { kite, mesh, face, side };
  });

  // Colours come from the page's CSS, so dark mode's lighter opencode, the
  // night sky's fog and the light follow the theme.
  const tuning: Tuning = {
    tilt: PHONE_TILT,
    elevation: ELEVATION,
    beam: 1,
    lift: 0,
  };
  let beamStrength = 1;
  let night = false;
  const white = new Color("#ffffff");
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const paint = () => {
    // The sky behind the scene, read where the canvas sits.
    const fog = (scene.fog as Fog).color;
    fog.set(
      getComputedStyle(canvas).getPropertyValue("--sky-low").trim() ||
        "#cfe6f5",
    );
    night = fog.getHSL({ h: 0, s: 0, l: 0 }).l < 0.4;
    for (const { kite, face, side } of orbiting) {
      const css = getComputedStyle(kite.el);
      const a = css.getPropertyValue("--a").trim();
      const b = css.getPropertyValue("--b").trim() || a;
      const c = css.getPropertyValue("--c").trim() || b;
      face.map?.dispose();
      face.map = colourTexture([a, b, c]);
      face.map.anisotropy = anisotropy;
      face.needsUpdate = true;
      side.color.set(b).multiplyScalar(0.9);
    }
    // Light adds up against a dark sky. Against a pale one it would vanish,
    // so it's laid over instead, and the rainbow's hues, not its brightness,
    // set it apart from the blue.
    const blending = night ? AdditiveBlending : NormalBlending;
    sheet.blending = blending;
    sheet.uniforms.night.value = night ? 1 : 0;
    beamStrength = night ? 1.2 : 0.85;
    sheet.uniforms.strength.value = beamStrength * tuning.beam;
    // The colour the light leaves the screen in: the beam's base colour.
    // The screen glows a paler version of it, the halo and the light on the
    // tiles take it too, so screen, halo and beam run into one another.
    const source = night ? "#9ff0e2" : "#ffd98f";
    sheet.uniforms.source.value.set(source);
    haloMaterial.blending = blending;
    haloMaterial.color.set(source);
    haloMaterial.opacity = night ? 0.9 : 0.8;
    moteMaterial.blending = blending;
    screenMaterial.color.set(source).lerp(white, 0.6);
    glow.color.set(source).lerp(white, 0.3);
    for (const m of [sheet, haloMaterial, moteMaterial]) m.needsUpdate = true;
  };
  paint();
  dark.addEventListener("change", paint);

  const camera = new PerspectiveCamera(FOV, 1, 0.1, 60);
  const halfH = Math.tan((FOV / 2) * DEG);
  const target = new Vector3();
  const spot = new Vector3();
  const tint = new Color();
  let distance = 10;
  // On a tall screen the rings draw in and spread apart vertically; on a
  // wide one they reach out sideways into the room it has.
  let shape: "tall" | "square" | "wide" = "square";
  const ring = (i: number) => {
    const { radius, height, ...rest } = RINGS[i];
    const spread = shape === "tall" ? 1.5 : 1;
    return {
      ...rest,
      radius: radius * { tall: 0.68, square: 1, wide: 1.45 }[shape],
      height: CENTRE.height + (height - CENTRE.height) * spread + tuning.lift,
    };
  };
  // Where on ring i a tile at `angle` sits: a circle in the ground plane,
  // its near half (z > 0) tipped down about the x axis.
  const onRing = (i: number, angle: number, out = new Vector3()) => {
    const { radius, height, tilt } = ring(i);
    const [x, z] = [radius * Math.cos(angle), radius * Math.sin(angle)];
    return out.set(x, height - z * Math.sin(tilt), z * Math.cos(tilt));
  };

  // Points that must stay in view: the phone's corners, the top of the
  // beam's contents, and each ring's extremes with room for a tile.
  const extremes = () => {
    phone.updateMatrixWorld();
    const points = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].map(([x, y]) =>
      new Vector3(
        (x * PHONE.width) / 2,
        (y * PHONE.height) / 2,
        0,
      ).applyMatrix4(phone.matrixWorld),
    );
    for (let i = 0; i < RINGS.length; i++) {
      for (let k = 0; k < 8; k++) {
        const p = onRing(i, (k / 8) * 2 * Math.PI);
        for (const dy of [-0.45, 0.45]) points.push(p.clone().setY(p.y + dy));
      }
    }
    points.push(new Vector3(0, CENTRE.height + tuning.lift + 0.7, 0));
    return points;
  };

  // Aim at the middle of everything, then find the nearest distance at
  // which it all fits.
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    shape =
      camera.aspect < 0.9 ? "tall" : camera.aspect > 1.4 ? "wide" : "square";
    phone.rotation.x = -Math.PI / 2 + tuning.tilt;
    const points = extremes();
    const ys = points.map((p) => p.y);
    target.set(0, (Math.min(...ys) + Math.max(...ys)) / 2, 0);
    const place = (d: number) => {
      camera.position.set(
        0,
        target.y + d * Math.sin(tuning.elevation),
        d * Math.cos(tuning.elevation),
      );
      camera.lookAt(target);
      camera.updateMatrixWorld();
    };
    const fits = (d: number) => {
      place(d);
      return points.every((p) => {
        spot.copy(p).project(camera);
        return (
          Math.abs(spot.x) <= 0.94 && Math.abs(spot.y) <= 0.94 && spot.z < 1
        );
      });
    };
    let [near, far] = [2, 60];
    for (let i = 0; i < 24; i++) {
      const mid = (near + far) / 2;
      if (fits(mid)) far = mid;
      else near = mid;
    }
    distance = far;
    place(distance);
    (scene.fog as Fog).near = distance - 1;
    (scene.fog as Fog).far = distance + 9;
  };
  // The sky changes height once the scene is ready, and with the window.
  new ResizeObserver(resize).observe(canvas);

  return {
    /** Current knob settings. */
    tuning: () => ({ ...tuning }),
    /** Change some knobs and refit the camera. */
    tune(next: Partial<Tuning>) {
      Object.assign(tuning, next);
      paint();
      resize();
    },
    /** Draw a frame at time `t` in seconds and move each kite's button over its tile. */
    render(t: number) {
      // The icon floats in the beam, facing the viewer, turning just enough
      // to catch light on its edge.
      centre.position.y =
        CENTRE.height + tuning.lift + Math.sin(t * 0.8) * 0.05;
      centre.quaternion.copy(camera.quaternion);
      centre.rotateY(Math.sin(t * 0.35) * 0.22);
      centre.rotateX(Math.sin(t * 0.27) * 0.08);

      for (const { kite, mesh } of orbiting) {
        const { period, turn } = RINGS[kite.ring];
        const angle = (kite.phase + (turn * t) / period) * 2 * Math.PI;
        onRing(kite.ring, angle, mesh.position);
        mesh.position.y += Math.sin(t * 0.9 + kite.phase * 7) * 0.06;
        // Face the viewer, nose turned its own way, rocking enough to show
        // the tile's edge.
        mesh.quaternion.copy(camera.quaternion);
        mesh.rotateZ(kite.rot * DEG);
        mesh.rotateY(Math.sin(t * 0.7 + kite.phase * 6) * 0.45);
        mesh.rotateX(Math.sin(t * 0.5 + kite.phase * 4) * 0.2);
      }

      const position = moteGeometry.attributes.position as BufferAttribute;
      const colour = moteGeometry.attributes.color as BufferAttribute;
      motes.forEach((m, i) => {
        const climb = (m.start + t * m.speed) % 1;
        const halfWidth = (BEAM.bottom + (BEAM.top - BEAM.bottom) * climb) / 2;
        position.setXYZ(
          i,
          m.across * halfWidth * 0.7,
          BEAM.base + 0.2 + climb * BEAM.height * 0.8,
          m.depth,
        );
        const alpha = Math.sin(climb * Math.PI) ** 1.5;
        // By day a mote takes the rainbow's colour at the height it has
        // reached; by night one of the aurora's.
        if (night) tint.set(AURORA[Math.floor(m.hue * AURORA.length)]);
        else tint.setHSL(rainbowHue(Math.min(1, climb * 1.1)), 0.8, 0.7);
        colour.setXYZW(i, tint.r, tint.g, tint.b, alpha);
      });
      position.needsUpdate = true;
      colour.needsUpdate = true;
      sheet.uniforms.time.value = t;

      renderer.render(scene, camera);

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      for (const { kite, mesh } of orbiting) {
        const far = mesh.position.distanceTo(camera.position);
        spot.copy(mesh.position).project(camera);
        const size = (kite.size / (2 * far * halfH)) * height;
        const style = kite.el.style;
        style.left = `${canvas.offsetLeft + ((spot.x + 1) / 2) * width}px`;
        style.top = `${canvas.offsetTop + ((1 - spot.y) / 2) * height}px`;
        style.width = `${size * 1.1}px`;
        // Nearer tiles stack above farther ones.
        style.setProperty("--z", String(Math.round((distance + 4 - far) * 2)));
      }
    },
  };
}

export type SkyScene = ReturnType<typeof mountSkyScene>;
