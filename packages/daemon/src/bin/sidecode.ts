#!/usr/bin/env node
import { PROTOCOL_VERSION } from "@sidecodeapp/protocol";
import { start } from "../index.js";

const [, , rawSubcommand, ...rest] = process.argv;
const subcommand = rawSubcommand ?? "help";

async function main(): Promise<void> {
  switch (subcommand) {
    case "up":
    case "start": {
      const daemon = await start(parsePortFlag(rest));
      const shutdown = async (signal: string) => {
        console.log(`\nreceived ${signal}, shutting down…`);
        await daemon.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      return;
    }

    case "down":
    case "stop":
      console.log("TODO: signal running daemon");
      return;

    case "pair":
      console.log("TODO: print pairing QR");
      return;

    case "status":
      console.log("TODO: query running daemon");
      return;

    case "logs":
      console.log("TODO: tail $SIDECODE_HOME/daemon.log");
      return;

    case "install-agent":
      console.log("TODO: install launchd plist to ~/Library/LaunchAgents/");
      return;

    case "version":
    case "--version":
    case "-v":
      console.log(`sidecode (protocol ${PROTOCOL_VERSION})`);
      return;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      console.error(`sidecode: unknown command "${subcommand}"\n`);
      printHelp();
      process.exit(1);
  }
}

function parsePortFlag(args: readonly string[]): { port?: number } {
  const i = args.indexOf("--port");
  if (i === -1) return {};
  const value = args[i + 1];
  const port = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(port)) {
    throw new Error(`invalid --port value: ${value}`);
  }
  return { port };
}

function printHelp(): void {
  console.log(`sidecode — remote-control Claude Code from your phone

Usage:
  sidecode <command> [options]

Commands:
  up, start          Start the daemon in the foreground
  down, stop         Stop the running daemon
  pair               Print pairing QR for a new mobile client
  status             Show daemon status and connected clients
  logs               Tail daemon logs
  install-agent      Install launchd plist so daemon starts on login
  version            Print version
  help               Show this help

Options:
  --port <n>         Override default port (used with up/start)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
