// TURN-minting secrets, set in production via `wrangler secret put`
// (TURN_KEY_ID / TURN_API_TOKEN — see wrangler.jsonc). They are NOT in
// wrangler.jsonc, and the only local source that feeds `wrangler types`
// (a gitignored `.env`) is absent in CI — so the generated
// `worker-configuration.d.ts` carries them on a dev machine but NOT in a
// fresh CI checkout. Declaring them here merges them into the global `Env`
// unconditionally, keeping `env.TURN_*` typed everywhere without ever
// committing a value. A no-import .d.ts is a global script, so this
// `interface Env` augments the generated one via declaration merging.
interface Env {
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
}
