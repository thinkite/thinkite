import * as Application from "expo-application";

/**
 * iOS app semver string (e.g. `"1.0.0"`), reported to the daemon in the
 * `hello` handshake so daemon-side UI can show a mismatch warning when
 * the user is running mismatched app + daemon majors.
 *
 * Source = `expo-application.nativeApplicationVersion`, which reads
 * `CFBundleShortVersionString` from Info.plist. That's the same number
 * the App Store shows, so it stays in sync with releases automatically
 * (no separate constant to remember to bump).
 *
 * In contexts where the native version can't be resolved (web preview /
 * a vanilla Expo Go shell), fall back to a literal `"0.0.0"` — same
 * shape, gets us through semver compare without throwing.
 */
export const APP_VERSION: string =
  Application.nativeApplicationVersion ?? "0.0.0";
