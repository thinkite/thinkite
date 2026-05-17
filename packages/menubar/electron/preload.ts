import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
	openPairWindow: () => ipcRenderer.invoke("open-pair-window"),
});
