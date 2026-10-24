// A small overlay of frame numbers for checking the kite sky on a real
// device: open the site with `?perf`. Once a second it shows how many
// frames the scene drew, how long its JavaScript took per frame, the
// screen's refresh rate and how many of its frames came late, and the
// canvas's drawing size. (GPU time isn't measurable from the page on iOS.)

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Mounts the overlay; returns a function to record each scene frame: its
 * total ms, and the part spent in three.js's draw.
 */
export function mountPerf(canvas: HTMLCanvasElement) {
  const panel = document.createElement("pre");
  panel.style.cssText =
    "position:fixed;left:8px;top:8px;z-index:10000;margin:0;padding:8px 10px;" +
    "border-radius:10px;background:rgba(0,0,0,.72);color:#9f9;" +
    "font:11px/1.45 ui-monospace,Menlo,monospace;pointer-events:none;white-space:pre";
  document.body.append(panel);

  let renders: number[] = [];
  let draws: number[] = [];
  let gaps: number[] = [];
  let last = 0;
  // The screen's own frames, whether or not the scene drew in them.
  const tick = (now: number) => {
    if (last) gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  setInterval(() => {
    const frame = median(gaps);
    const late = gaps.filter((gap) => gap > frame * 1.5).length;
    const sorted = [...renders].sort((a, b) => a - b);
    const avg =
      renders.reduce((sum, ms) => sum + ms, 0) / (renders.length || 1);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const ratio = canvas.clientWidth ? canvas.width / canvas.clientWidth : 0;
    panel.textContent = [
      renders.length
        ? `scene  ${renders.length} fps`
        : "scene  idle (off screen)",
      `js     ${avg.toFixed(2)} ms avg · ${p95.toFixed(2)} p95`,
      `  draw ${(draws.reduce((sum, ms) => sum + ms, 0) / (draws.length || 1)).toFixed(2)} ms (three.js)`,
      `screen ${frame ? Math.round(1000 / frame) : 0} Hz · ${late} late`,
      `canvas ${canvas.width}×${canvas.height} · ${ratio.toFixed(2)}×`,
    ].join("\n");
    renders = [];
    draws = [];
    gaps = [];
  }, 1000);

  return (ms: number, drawMs: number) => {
    renders.push(ms);
    draws.push(drawMs);
  };
}
