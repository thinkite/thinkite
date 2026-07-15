// Repack the release DMG with the EXTRACTED app instead of electrobun's
// self-extracting wrapper. Run by `bun run package` after `electrobun build`.
//
// Why: the wrapper rewrites the .app on first launch, which (a) silently
// dies under Gatekeeper path translocation when users launch straight from
// the DMG (electrobun#359), (b) costs a ~5s extract+relaunch on first run,
// and (c) double-compresses (a zstd tarball inside a compressed DMG). The
// extracted app is signed+notarized by electrobun BEFORE tarring, so
// repacking loses nothing.
//
// Updater compatibility (verified against Updater.ts): with no cached tar
// for the current hash it logs "local-tar-missing" and downloads the FULL
// bundle — updates keep working, first one is just non-incremental (and
// caches the tar, restoring bsdiff patching afterwards). The update FEED
// (update.json + .tar.zst) is untouched by this script.
//
// The wrapper DMG electrobun made is REPLACED; wrapper .app stays in
// build/ for local runs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "..");
const artifactsDir = join(desktopRoot, "artifacts");

function run(cmd: string[], opts: { cwd?: string } = {}): void {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${r.status})`);
  }
}

const tarZst = readdirSync(artifactsDir).find((f) =>
  f.endsWith(".app.tar.zst"),
);
if (!tarZst) {
  console.error(`[make-flat-dmg] no .app.tar.zst in ${artifactsDir} — abort`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "sidecode-flat-dmg-"));

// tar.zst → tar → untar into a fresh subdir; returns the extracted .app.
// (Bun-native zstd; one shot in memory is fine at our sizes.)
async function unpackApp(tarZstPath: string, label: string): Promise<string> {
  const dir = join(work, label);
  run(["mkdir", dir]);
  const tarPath = join(dir, "bundle.tar");
  const compressed = await Bun.file(tarZstPath).bytes();
  await Bun.write(tarPath, Bun.zstdDecompressSync(compressed));
  run(["tar", "-xf", tarPath, "-C", dir]);
  rmSync(tarPath);
  const appName = readdirSync(dir).find((f) => f.endsWith(".app"));
  if (!appName) throw new Error(`no .app inside ${tarZstPath}`);
  return join(dir, appName);
}

try {
  // The artifacts tarball holds the REAL app (it's also the updater's
  // full-download feed). Be layout-defensive anyway: if the unpacked app
  // turns out to be the self-extracting WRAPPER (Resources carries a
  // <hash>.tar.zst), unwrap that inner tarball too.
  let appPath = await unpackApp(join(artifactsDir, tarZst), "outer");
  const innerZst = readdirSync(join(appPath, "Contents/Resources")).find(
    (f) => f.endsWith(".tar.zst"),
  );
  if (innerZst) {
    appPath = await unpackApp(
      join(appPath, "Contents/Resources", innerZst),
      "inner",
    );
    if (
      readdirSync(join(appPath, "Contents/Resources")).some((f) =>
        f.endsWith(".tar.zst"),
      )
    ) {
      throw new Error("inner app still looks like a self-extractor — abort");
    }
  }
  const appName = appPath.split("/").at(-1)!;

  // The inner app was signed before tarring — verify rather than trust.
  run(["codesign", "--verify", "--deep", "--strict", appPath]);

  // Staging dir = app + /Applications symlink (drag-to-install).
  const staging = join(work, "dmg-staging");
  run(["mkdir", staging]);
  run(["cp", "-R", appPath, join(staging, appName)]);
  symlinkSync("/Applications", join(staging, "Applications"));

  const dmgName = tarZst.replace(".app.tar.zst", ".dmg");
  const dmgPath = join(artifactsDir, dmgName);
  rmSync(dmgPath, { force: true });
  const volName = appName.replace(/\.app$/, "");
  run([
    "hdiutil",
    "create",
    "-volname",
    volName,
    "-srcfolder",
    staging,
    "-ov",
    "-format",
    "ULFO",
    dmgPath,
  ]);

  // Sign + notarize + staple the DMG itself when credentials are present
  // (same env the package script sourced from .env.local / CI secrets).
  // The app inside carries its own stapled ticket either way.
  const identity = process.env.ELECTROBUN_DEVELOPER_ID;
  if (identity) {
    run(["codesign", "--force", "--sign", identity, dmgPath]);
    const teamId = process.env.ELECTROBUN_TEAMID;
    const apiKeyPath = process.env.ELECTROBUN_APPLEAPIKEYPATH;
    const notarizeArgs = apiKeyPath
      ? [
          "--key",
          apiKeyPath,
          "--key-id",
          process.env.ELECTROBUN_APPLEAPIKEY ?? "",
          "--issuer",
          process.env.ELECTROBUN_APPLEAPIISSUER ?? "",
        ]
      : process.env.ELECTROBUN_APPLEIDPASS
        ? [
            "--apple-id",
            process.env.ELECTROBUN_APPLEID ?? "",
            "--password",
            process.env.ELECTROBUN_APPLEIDPASS,
            "--team-id",
            teamId ?? "",
          ]
        : null;
    if (notarizeArgs) {
      run([
        "xcrun",
        "notarytool",
        "submit",
        dmgPath,
        ...notarizeArgs,
        "--wait",
      ]);
      run(["xcrun", "stapler", "staple", dmgPath]);
    } else {
      console.warn(
        "[make-flat-dmg] identity present but no notarization creds — DMG signed, not notarized",
      );
    }
  } else {
    console.warn("[make-flat-dmg] no signing creds — DMG left unsigned");
  }

  console.log(`[make-flat-dmg] ${dmgPath} (extracted app, no self-extractor)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
