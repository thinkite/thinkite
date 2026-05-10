/**
 * Android / web fallback. V0 is iOS-only — the real screen lives in
 * `index.ios.tsx`. This stub exists solely to register the route with
 * expo-router's typed-routes generator (which scans bare-extension files
 * only — `.ios.tsx` doesn't get picked up). On iOS, Metro's platform-
 * suffix resolver prefers `index.ios.tsx`, so this body never renders.
 */
export default function SettingsIndexScreen() {
  return null;
}
