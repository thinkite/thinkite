import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the daemon's semver from its own package.json so iOS can compare
 * it to the app's appVersion in the hello / server_info exchange.
 *
 * Read at module-load time. Works in both `tsx` (src/version.ts →
 * ../package.json) and built JS (dist/version.js → ../package.json)
 * because package.json sits at the daemon root either way.
 *
 * We could `import pkg from "../package.json" with { type: "json" }`
 * (NodeNext supports the import assertion), but `readFileSync` keeps the
 * resolution explicit and the dependency on the package.json physical
 * location obvious. Either works.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

export const DAEMON_VERSION: string = pkg.version;
