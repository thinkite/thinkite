/**
 * Site-wide constants. Centralized here so URLs / contact / author
 * are edited in one place instead of grepping through components.
 */

export const links = {
  // Set to "" to render the linked buttons as visually disabled
  // (pointer-events:none + dimmed). Restore the URL here to re-enable.
  github: "",
  appStore: "",
  // Mac DMG download URL. Once releases are on GitHub, this will be:
  //   https://github.com/sidecodeapp/sidecode/releases/latest/download/sidecode.dmg
  download: "",
  contactEmail: "contact@sidecode.app",
} as const;

export const site = {
  url: "https://sidecode.app",
  name: "sidecode",
  author: "Richard Yang",
  license: "Apache 2.0",
} as const;
