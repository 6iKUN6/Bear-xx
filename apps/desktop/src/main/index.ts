import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";

/**
 * Sola 主进程：单窗口工作台。
 * v1 用系统原生标题栏（不自绘），安全基线：contextIsolation + sandbox + 关 nodeIntegration。
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Sola",
    autoHideMenuBar: true,
    // 主题 A（warm-workbench）页面底色，避免启动白闪；主题注入后由渲染层接管。
    backgroundColor: "#f2f3f5",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on("ready-to-show", () => {
    win.show();
  });

  // 渲染层一律不新开窗口，外链交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // electron-vite dev 注入 dev server URL；生产加载打包产物。
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    // dev 默认打开分离式 DevTools，方便看 Network（生产不开启）
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
