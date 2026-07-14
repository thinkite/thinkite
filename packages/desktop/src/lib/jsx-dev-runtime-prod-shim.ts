// Build-only alias target for `react/jsx-dev-runtime` (see vite.config.ts).
//
// astryx 0.1.5 shipped its dist compiled with the DEV jsx transform — 192
// files import `react/jsx-dev-runtime` (0.1.4 used `react/jsx-runtime`).
// React's PRODUCTION copy of that module exports `jsxDEV = undefined`, so a
// `vite build` bundle dies at module evaluation with
// "(0, x.jsxDEV) is not a function" — blank #root, nothing in the console.
// The vite DEV server resolves the development condition, so `deno task dev`
// never sees it; only built/packaged runs break.
//
// Forwarding jsxDEV → jsx is lossless in production: jsxDEV's extra
// parameters (isStaticChildren, source, self) only feed dev-time validation,
// and prod `jsx`/`jsxs` are behaviorally identical. Remove this shim (and
// the alias) once astryx publishes a fixed build.
export { Fragment, jsx as jsxDEV } from "react/jsx-runtime";
