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
  MeshStandardMaterial,
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
// About a real phone's proportions: depth plus the rounded edge above and
// below it is about a ninth of the width.
const PHONE = {
  width: 0.58,
  height: 1.18,
  radius: 0.105,
  depth: 0.025,
  edge: 0.02,
};
// The black around the screen: a strip of flat face, then the rounded edge
// outside it, each this wide, so the screen nearly reaches the sides.
const RIM = 0.012;
const CENTRE = { size: 1.45, height: 2.6 };
// The beam leaves the screen as wide as the screen and widens as it rises.
const BEAM = { bottom: 0.55, top: 2.5, height: 3.3, base: 0.045 };
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

// A tile painted in its maker's colours as soft spots bleeding into a base
// colour, for makers whose mark blends several (Gemini's sparkle). `spots`
// is CSS's "colour x y radius, …", in the tile's 0..1 with y down.
const spotTexture = (base: string, spots: string) =>
  texture(256, 256, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 256);
    for (const spot of spots.split(",")) {
      const [colour, x, y, r] = spot.trim().split(/\s+/);
      const [cx, cy, radius] = [x, y, r].map((n) => Number(n) * 256);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, colour);
      g.addColorStop(0.4, `${colour}d0`);
      g.addColorStop(1, `${colour}00`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
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

        // Only one of these is compiled in (NIGHT is defined by theme), so a
        // pixel pays for one set of noise, not both.
      #ifdef NIGHT
        // By night, an aurora: vertical curtains that sway and drift upward,
        // teal low down, through violet, to pink up top, brighter along each
        // fold.
        float fold = noise(vec2(side * 2.6
          + (noise(vec2(vUv.y * 1.4 - time * 0.12, 1.7)) - 0.5) * 1.4
          + time * 0.05, vUv.y * 0.5 - time * 0.18));
        float height = clamp(vUv.y * 2.0 + (noise(vec2(side * 1.5, time * 0.1)) - 0.5) * 0.5, 0.0, 1.0);
        vec3 color = mix(vec3(0.31, 0.85, 0.77), vec3(0.56, 0.48, 0.94), smoothstep(0.0, 0.4, height));
        color = mix(color, vec3(0.93, 0.53, 0.82), smoothstep(0.4, 0.85, height));
        color *= color;
        float shimmer = 0.35 + 1.4 * pow(fold, 1.6);
      #else
        // By day, a rainbow from gold at the screen the long way round to
        // sky blue up high (as rainbowHue), skipping green; pastel, paler
        // down the core, with a slow upward ripple. (Linear light: pastel
        // sRGB squared, roughly.)
        float rise = clamp(vUv.y * 1.35
          + (noise(vec2(side * 1.2, vUv.y * 2.0 - time * 0.15)) - 0.5) * 0.18, 0.0, 1.0);
        vec3 color = mix(vec3(1.0), hue(fract((410.0 - 210.0 * rise) / 360.0)), 0.62);
        color = mix(color, vec3(1.0), (1.0 - smoothstep(0.0, 0.5, d)) * 0.3);
        color *= color;
        float shimmer = 1.0;
      #endif

        // Just above the screen the beam still has the screen's own colour,
        // so the light seems to come out of it rather than start above it.
        color = mix(color, source, (1.0 - smoothstep(0.0, 0.14, vUv.y)) * 0.8);
        gl_FragColor = vec4(color, spread * up * strength * shimmer);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
  });

// A standard material, not a physical one: a clear coat added a faint
// second highlight that cost a good share of each tile's shading.
const glossy = (props: ConstructorParameters<typeof MeshStandardMaterial>[0]) =>
  new MeshStandardMaterial({ roughness: 0.5, ...props });

// The reveal once the scene is ready: the screen switches on, light rises
// from it, the icon floats up into the light, and the model tiles pop in
// one after another. Each step runs over its own share of REVEAL ms.
const REVEAL = 2200;
const easeOut = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
// Overshoots a little before settling, for the tiles popping in.
const easeOutBack = (x: number) => {
  const c = Math.min(1, Math.max(0, x)) - 1;
  return 1 + 2.4 * c ** 3 + 1.4 * c ** 2;
};

export function mountSkyScene(
  canvas: HTMLCanvasElement,
  kites: SkyKite[],
  { reveal = true } = {},
) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  // 1.5× is hard to tell from 2× for soft light and moving tiles, and
  // draws a little over half the pixels; on a phone's small, dense screen
  // 1.25× is plenty, and draws about a third fewer again.
  const coarse = matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.25 : 1.5));
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
      bevelThickness: PHONE.edge,
      bevelSize: RIM,
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
  // leaves it in, nothing to read at this size anyway. Its corners follow
  // the body's.
  const [sw, sh] = [PHONE.width - 2 * RIM, PHONE.height - 2 * RIM];
  const screenMaterial = new MeshBasicMaterial({
    fog: false,
    toneMapped: false,
  });
  const screen = new Mesh(
    new ShapeGeometry(roundedRect(sw, sh, PHONE.radius - RIM), 12),
    screenMaterial,
  );
  screen.position.z = PHONE.depth + PHONE.edge + 0.001;
  phone.add(screen);
  // A pill-shaped cutout near the top, so it reads as a phone.
  const island = new Mesh(
    new ShapeGeometry(roundedRect(0.12, 0.046, 0.023), 8),
    new MeshBasicMaterial({ color: "#0b0c0f", fog: false }),
  );
  island.position.set(0, sh / 2 - 0.07, screen.position.z + 0.001);
  phone.add(island);
  const margin = 0.2;
  const haloMaterial = new MeshBasicMaterial({
    map: haloTexture(sw, sh, PHONE.radius - RIM, margin),
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
  // A trapezoid as wide as the light at each height, so the transparent
  // corners of a rectangle aren't shaded for nothing. UVs are as if it were
  // the full BEAM.top-wide rectangle, which is what the shader expects.
  const trapezoid = new BufferGeometry();
  const corners = [
    [-BEAM.bottom / 2, -BEAM.height / 2],
    [BEAM.bottom / 2, -BEAM.height / 2],
    [-BEAM.top / 2, BEAM.height / 2],
    [BEAM.top / 2, BEAM.height / 2],
  ];
  trapezoid.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array(corners.flatMap(([x, y]) => [x, y, 0])),
      3,
    ),
  );
  trapezoid.setAttribute(
    "uv",
    new BufferAttribute(
      new Float32Array(
        corners.flatMap(([x, y]) => [0.5 + x / BEAM.top, y > 0 ? 1 : 0]),
      ),
      2,
    ),
  );
  trapezoid.setIndex([0, 1, 2, 2, 1, 3]);
  const beam = new Mesh(trapezoid, sheet);
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
  // Map every vertex straight down onto the face: the caps keep the UVs
  // they had, and the sides and bevel pick up the face's colour at that
  // spot, so a tile's edge carries on its face's colours instead of one
  // flat one.
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) + 0.5, position.getY(i) + 0.5);
  }
  // The sides a shade darker than the caps, baked into vertex colours, so a
  // tile is one material and one draw call rather than two.
  const shade = new Float32Array(position.count * 3).fill(1);
  for (const { start, count, materialIndex } of geometry.groups) {
    if (materialIndex === 1) shade.fill(0.85, start * 3, (start + count) * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(shade, 3));
  // Tiles are glossier than the phone: wet-looking, with sharp highlights.
  const tile = (props: ConstructorParameters<typeof MeshStandardMaterial>[0]) =>
    glossy({ roughness: 0.15, vertexColors: true, ...props });

  // The icon's edge, like a model tile's, carries on its face's colours.
  const icon = iconTexture();
  icon.anisotropy = anisotropy;
  const centre = new Mesh(geometry, tile({ map: icon }));
  centre.scale.setScalar(CENTRE.size);
  scene.add(centre);

  const orbiting = kites.map((kite) => {
    const face = tile({});
    const mesh = new Mesh(geometry, face);
    mesh.scale.setScalar(kite.size);
    scene.add(mesh);
    return { kite, mesh, face, z: Number.NaN };
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
  let haloOpacity = 1;
  const screenLit = new Color();
  const screenOff = new Color("#14161a");
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
    for (const { kite, face } of orbiting) {
      const css = getComputedStyle(kite.el);
      const a = css.getPropertyValue("--a").trim();
      const b = css.getPropertyValue("--b").trim() || a;
      const c = css.getPropertyValue("--c").trim() || b;
      const spots = css
        .getPropertyValue("--spots")
        .trim()
        .replace(/^"|"$/g, "");
      face.map?.dispose();
      face.map = spots ? spotTexture(c, spots) : colourTexture([a, b, c]);
      face.map.anisotropy = anisotropy;
      // One map for the whole tile: the face, and the edge (a shade darker by
      // its vertex colours) carrying on the face's colours.
      face.needsUpdate = true;
    }
    // Light adds up against a dark sky. Against a pale one it would vanish,
    // so it's laid over instead, and the rainbow's hues, not its brightness,
    // set it apart from the blue.
    const blending = night ? AdditiveBlending : NormalBlending;
    sheet.blending = blending;
    sheet.defines = night ? { NIGHT: "" } : {};
    beamStrength = night ? 1.2 : 0.85;
    sheet.uniforms.strength.value = beamStrength * tuning.beam;
    // The colour the light leaves the screen in: the beam's base colour.
    // The screen glows a paler version of it, the halo and the light on the
    // tiles take it too, so screen, halo and beam run into one another.
    const source = night ? "#9ff0e2" : "#ffd98f";
    sheet.uniforms.source.value.set(source);
    haloMaterial.blending = blending;
    haloMaterial.color.set(source);
    haloOpacity = night ? 0.9 : 0.8;
    moteMaterial.blending = blending;
    screenLit.set(source).lerp(white, 0.6);
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
        // Room for a tile above and below, and a little either side (the
        // canvas bleeds past the column, so a tile may hang over its edge).
        for (const [dx, dy] of [
          [-0.15, -0.45],
          [0.15, -0.45],
          [-0.15, 0.45],
          [0.15, 0.45],
        ])
          points.push(p.clone().add(new Vector3(dx, dy, 0)));
      }
    }
    points.push(new Vector3(0, CENTRE.height + tuning.lift + 0.7, 0));
    return points;
  };

  // Aim at the middle of everything, then find the nearest distance at
  // which it all fits.
  // Where the canvas sits in the sky, read once per resize: reading it
  // every frame, after moving the buttons, would make the browser lay the
  // page out again each time.
  const box = { left: 0, top: 0, width: 1, height: 1 };
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    Object.assign(box, {
      left: canvas.offsetLeft,
      top: canvas.offsetTop,
      width,
      height,
    });
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
    // The canvas runs the full width of the page so tiles swinging wide
    // aren't cut off, but the scene is fitted to the sky's own column.
    const column = Math.min(
      1,
      (canvas.parentElement?.clientWidth ?? width) / width,
    );
    const fits = (d: number) => {
      place(d);
      return points.every((p) => {
        spot.copy(p).project(camera);
        return (
          Math.abs(spot.x) <= 0.97 * column &&
          Math.abs(spot.y) <= 0.96 &&
          spot.z < 1
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
    // Each button is sized once, for its tile at the middle distance; it
    // only needs to be roughly the tile's size to take the pointer.
    for (const { kite } of orbiting) {
      kite.el.style.width = `${(kite.size / (2 * distance * halfH)) * height * 1.1}px`;
    }
  };
  // The sky changes height once the scene is ready, and with the window.
  new ResizeObserver(resize).observe(canvas);
  // The reveal starts with the first frame drawn, which waits until the
  // sky is on screen, however early the scene loaded.
  let born = 0;
  // How long the last three.js draw call took (for the ?perf overlay).
  let drawMs = 0;

  return {
    /** How long three.js took to draw the last frame, in ms. */
    drawMs: () => drawMs,
    /** Whether the reveal is still playing. */
    revealing: () => reveal && (!born || performance.now() - born < REVEAL),
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
      born ||= performance.now();
      const shown = reveal ? (performance.now() - born) / REVEAL : 1;
      const lit = easeOut(shown / 0.25);
      const beamIn = easeOut((shown - 0.12) / 0.35);
      const rise = easeOut((shown - 0.25) / 0.4);
      screenMaterial.color.copy(screenOff).lerp(screenLit, lit);
      haloMaterial.opacity = haloOpacity * lit;
      glow.intensity = 9 * beamIn;
      sheet.uniforms.strength.value = beamStrength * tuning.beam * beamIn;

      // The icon floats in the beam, facing the viewer, turning just enough
      // to catch light on its edge.
      centre.scale.setScalar(CENTRE.size * (0.7 + 0.3 * rise));
      centre.position.y =
        CENTRE.height +
        tuning.lift +
        Math.sin(t * 0.8) * 0.05 -
        (1 - rise) * 1.2;
      centre.quaternion.copy(camera.quaternion);
      centre.rotateY(Math.sin(t * 0.35) * 0.22);
      centre.rotateX(Math.sin(t * 0.27) * 0.08);

      orbiting.forEach(({ kite, mesh }, i) => {
        mesh.scale.setScalar(
          kite.size * Math.max(0, easeOutBack((shown - 0.5 - i * 0.05) / 0.3)),
        );
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
      });

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
        const alpha = Math.sin(climb * Math.PI) ** 1.5 * beamIn;
        // By day a mote takes the rainbow's colour at the height it has
        // reached; by night one of the aurora's.
        if (night) tint.set(AURORA[Math.floor(m.hue * AURORA.length)]);
        else tint.setHSL(rainbowHue(Math.min(1, climb * 1.1)), 0.8, 0.7);
        colour.setXYZW(i, tint.r, tint.g, tint.b, alpha);
      });
      position.needsUpdate = true;
      colour.needsUpdate = true;
      sheet.uniforms.time.value = t;

      const drawStart = performance.now();
      renderer.render(scene, camera);
      drawMs = performance.now() - drawStart;

      // Move each button over its tile with a transform only (no layout),
      // and restack only when a tile's depth order changes.
      for (const entry of orbiting) {
        const { kite, mesh } = entry;
        const far = mesh.position.distanceTo(camera.position);
        spot.copy(mesh.position).project(camera);
        const x = box.left + ((spot.x + 1) / 2) * box.width;
        const y = box.top + ((1 - spot.y) / 2) * box.height;
        kite.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        // Nearer tiles stack above farther ones.
        const z = Math.round((distance + 4 - far) * 2);
        if (z !== entry.z) {
          entry.z = z;
          kite.el.style.setProperty("--z", String(z));
        }
      }
    },
  };
}

export type SkyScene = ReturnType<typeof mountSkyScene>;
