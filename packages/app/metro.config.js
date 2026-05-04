const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// react-native-diffs is consumed via `link:../../../react-native-diffs` for
// local Swift iteration ahead of upstream PR. Two things Metro needs:
//   1. follow symlinks so node_modules/react-native-diffs (a symlink to the
//      clone) actually resolves
//   2. watchFolders includes the clone path so Metro indexes its source files
//      and picks up edits
const reactNativeDiffsClone = path.resolve(
  __dirname,
  "../../../react-native-diffs",
);
config.resolver.unstable_enableSymlinks = true;
config.watchFolders = [...(config.watchFolders ?? []), reactNativeDiffsClone];
// Prevent Metro from descending into the clone's own node_modules and picking
// up duplicate copies of react / react-native that conflict with this app's.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : []),
  new RegExp(`${reactNativeDiffsClone}/node_modules/.*`),
];

module.exports = withUniwindConfig(config, {
  // relative path to your global.css file (from previous step)
  cssEntryFile: "./src/global.css",
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: "./src/uniwind-types.d.ts",
});
