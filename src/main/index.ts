import path from "node:path";
import { app, BrowserWindow } from "electron";
import { registerIpcHandlers, shutdownSession } from "./ipc";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Quitting has to wait for the container to go away. Electron would otherwise
 * tear the process down while `docker rm` is still in flight, and the thing
 * that survives the app is the one that matters: a container holding port
 * 5001, and a running SC2 the user has to find and kill by hand.
 */
let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  void shutdownSession().finally(() => app.quit());
});
