// A dev-only panel of sliders for trying the kite sky's phone angle,
// camera, beam and lift. Open the site
// with `?tune` under `astro dev`.
import type { SkyScene, Tuning } from "./sky-scene";

const DEG = Math.PI / 180;

const knobs: {
  key: keyof Tuning;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Slider value ↔ the scene's units. */
  scale: number;
  unit: string;
}[] = [
  {
    key: "tilt",
    label: "Phone tilt",
    min: 0,
    max: 60,
    step: 1,
    scale: DEG,
    unit: "°",
  },
  {
    key: "elevation",
    label: "Camera",
    min: 5,
    max: 60,
    step: 1,
    scale: DEG,
    unit: "°",
  },
  {
    key: "beam",
    label: "Beam",
    min: 0,
    max: 2.5,
    step: 0.05,
    scale: 1,
    unit: "×",
  },
  {
    key: "lift",
    label: "Icon lift",
    min: -1,
    max: 1.5,
    step: 0.05,
    scale: 1,
    unit: "",
  },
];

export function mountTuner(scene: SkyScene, redraw: () => void) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;right:12px;top:76px;z-index:9999;width:230px;padding:12px 14px;border-radius:14px;" +
    "background:rgba(20,24,33,.88);color:#fff;font:12px/1.4 ui-sans-serif,system-ui;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.3);backdrop-filter:blur(8px)";
  const readout = document.createElement("code");
  readout.style.cssText =
    "display:block;margin-top:8px;opacity:.75;white-space:pre-wrap;font-size:11px";

  const show = () => {
    const now = scene.tuning();
    readout.textContent = knobs
      .map((k) => `${k.key}: ${+(now[k.key] / k.scale).toFixed(2)}${k.unit}`)
      .join("  ");
  };

  for (const knob of knobs) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:grid;grid-template-columns:72px 1fr 44px;gap:8px;align-items:center;margin:4px 0";
    const name = document.createElement("span");
    name.textContent = knob.label;
    const input = document.createElement("input");
    Object.assign(input, {
      type: "range",
      min: String(knob.min),
      max: String(knob.max),
      step: String(knob.step),
      value: String(scene.tuning()[knob.key] / knob.scale),
    });
    input.style.cssText = "width:100%;min-width:0;margin:0";
    const value = document.createElement("span");
    value.style.textAlign = "right";
    const update = () => {
      value.textContent = `${input.value}${knob.unit}`;
      scene.tune({ [knob.key]: Number(input.value) * knob.scale });
      show();
      redraw();
    };
    input.addEventListener("input", update);
    value.textContent = `${input.value}${knob.unit}`;
    row.append(name, input, value);
    panel.append(row);
  }
  show();
  panel.append(readout);
  document.body.append(panel);
}
