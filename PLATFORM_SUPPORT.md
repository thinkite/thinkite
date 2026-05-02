# Platform Support

V0 targets **iOS only**. Android support is deferred until V1+.

## iOS-only dependencies

These libraries do not work on Android in their current form. When we
add Android, each one needs a replacement strategy.

### `react-native-diffs` (vercel-labs)

Used for tool-detail rendering (Edit / Write / Read / Bash) and
markdown rendering inside tool blocks.

- The npm package ships `ios/` and `android/` directories, but the
  Android side is a stub. The actual rendering engine is the Swift
  library [`HumanInterfaceDesign/MarkdownView`](https://github.com/HumanInterfaceDesign/MarkdownView),
  which is Apple-platforms-only (iOS / macOS / visionOS).
- No Android port of MarkdownView exists.
- When porting to Android, options are:
  1. Roll our own diff renderer (parse unified diff in JS, render
     `<View>` rows with red/green backgrounds — Paseo's approach).
  2. Use a web-based renderer in a `WebView` (heavy, but reuses
     existing JS diff libraries like `git-diff-view` or `diff2html`).
  3. Wait for someone to write an Android backend for the
     `react-native-diffs` Nitro module.

Tracked in memory: see `reference_react_native_diffs.md`.
