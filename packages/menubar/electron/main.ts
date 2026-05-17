import { app, BrowserWindow, Tray, ipcMain, nativeImage, screen } from "electron";
import path from "node:path";
import { type Daemon, start as startDaemon } from "@sidecodeapp/daemon";

const POP_W = 320;
const POP_H = 440;

let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
let pairWindow: BrowserWindow | null = null;
let popoverVisible = false;
let isQuitting = false;
let daemon: Daemon | null = null;

function createPopover() {
	const win = new BrowserWindow({
		width: POP_W,
		height: POP_H,
		show: false,
		frame: false,
		resizable: false,
		skipTaskbar: true,
		fullscreenable: false,
		vibrancy: "menu",
		visualEffectState: "active",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(import.meta.dirname, "preload.mjs"),
		},
	});
	win.setAlwaysOnTop(true, "pop-up-menu");
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	win.setHiddenInMissionControl(true);

	const url = process.env.VITE_DEV_SERVER_URL;
	if (url) {
		void win.loadURL(url);
	} else {
		void win.loadFile(path.join(import.meta.dirname, "../dist/index.html"));
	}

	win.on("blur", () => {
		if (popoverVisible) {
			win.hide();
			popoverVisible = false;
		}
	});

	return win;
}

function positionPopoverUnderTray() {
	if (!tray || !popover) return;
	const trayBounds = tray.getBounds();
	const display =
		screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }) ??
		screen.getPrimaryDisplay();
	const trayCenterX = trayBounds.x + trayBounds.width / 2;
	const rawX = Math.round(trayCenterX - POP_W / 2);
	const minX = display.bounds.x + 6;
	const maxX = display.bounds.x + display.bounds.width - POP_W - 6;
	const x = Math.max(minX, Math.min(rawX, maxX));
	const y = display.workArea.y + 4;
	popover.setBounds({ x, y, width: POP_W, height: POP_H });
}

function openPairWindow() {
	if (pairWindow && !pairWindow.isDestroyed()) {
		pairWindow.focus();
		return;
	}
	const win = new BrowserWindow({
		width: 360,
		height: 440,
		show: false,
		resizable: false,
		fullscreenable: false,
		minimizable: false,
		maximizable: false,
		titleBarStyle: "hiddenInset",
		title: "Pair iPhone",
		backgroundColor: "#18181b",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(import.meta.dirname, "preload.mjs"),
		},
	});
	const url = process.env.VITE_DEV_SERVER_URL;
	if (url) {
		void win.loadURL(`${url}#pair`);
	} else {
		void win.loadFile(path.join(import.meta.dirname, "../dist/index.html"), {
			hash: "pair",
		});
	}
	win.once("ready-to-show", () => win.show());
	win.on("closed", () => {
		pairWindow = null;
	});
	pairWindow = win;
}

function togglePopover() {
	if (!popover) return;
	if (popoverVisible) {
		popover.hide();
		popoverVisible = false;
		return;
	}
	positionPopoverUnderTray();
	popover.show();
	popover.focus();
	popoverVisible = true;
}

ipcMain.handle("open-pair-window", () => openPairWindow());

app.whenReady().then(async () => {
	app.dock?.hide();

	console.log("[main] starting daemon...");
	daemon = await startDaemon({ port: 0 });
	console.log(
		`[main] daemon ready at ${daemon.address.host}:${daemon.address.port}`,
	);

	const trayImage = nativeImage.createEmpty();
	tray = new Tray(trayImage);
	tray.setTitle("◉ sc");
	tray.on("click", togglePopover);
	tray.on("right-click", togglePopover);

	popover = createPopover();

	console.log("[main] tray + popover ready");
});

app.on("did-resign-active", () => {
	if (popoverVisible && popover) {
		popover.hide();
		popoverVisible = false;
	}
});

app.on("before-quit", (event: Electron.Event) => {
	if (isQuitting) return;
	event.preventDefault();
	isQuitting = true;
	console.log("[main] before-quit: stopping daemon...");
	const stopPromise = daemon ? daemon.stop() : Promise.resolve();
	void stopPromise.then(() => {
		console.log("[main] daemon stopped, quitting");
		app.quit();
	});
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		console.log(`[main] received ${sig}`);
		app.quit();
	});
}
