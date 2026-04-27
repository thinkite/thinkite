/**
 * V0 dev shortcut: hardcode a pair offer + project cwd here while QR scan
 * + project picker UI don't exist yet. Replace with real flows in W2.
 *
 * Workflow:
 *   1. Start daemon on Mac:  `pnpm --filter @sidecodeapp/daemon start`
 *   2. In another terminal:  `pnpm --filter @sidecodeapp/daemon exec tsx src/bin/sidecode.ts pair`
 *   3. Copy the printed `<offer-base64>` into DEV_PAIR_OFFER below.
 *   4. Update DEV_PROJECT_CWD to the cwd you want to list sessions for.
 *   5. Reload Expo. iOS auto-pairs and lists sessions for that cwd.
 *
 * Notes:
 *   - Offers expire 5 minutes after `sidecode pair` printed them. Re-run if it ages out.
 *   - Once paired, iOS persists the daemon info via SecureStore and uses
 *     trusted_reconnect on subsequent launches — no need to refresh DEV_PAIR_OFFER
 *     unless you reset the iOS install or the daemon's identity changes.
 *   - For iOS device (not simulator) testing, daemon must be reachable from the
 *     phone — bind daemon on 0.0.0.0 (default) and ensure they're on the same LAN.
 *     Replace the host in the offer's daemonAddress with your Mac's LAN IP.
 */

export const DEV_PAIR_OFFER =
  "eyJ0eXBlIjoicGFpci5vZmZlciIsInYiOjEsImRhZW1vbkZpbmdlcnByaW50IjoiNWU3MDcyYjg1YWUxMTFiMiIsImRhZW1vbklkZW50aXR5UHVibGljS2V5IjoiWVpNT254MEdwT1hzcDFDdmZXVE94bFVsclp0UTJLeUxzT01pY2tzcEpvZyIsImRhZW1vbkFkZHJlc3MiOiJ3czovLzEyNy4wLjAuMTo0MTIzNCIsInNlcnZpY2VOYW1lIjoic2lkZWNvZGUtWXVlcWlhbmRlTWFjQm9vay1BaXIubG9jYWwiLCJleHBpcmVzQXQiOjE3NzcyNjA4NjMzMDd9";

export const DEV_PROJECT_CWD =
  "/Users/yangyueqian/Desktop/projects/sidecode/sidecode";
