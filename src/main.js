const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, Tray, nativeImage, dialog, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { CodexOpenAIProxy, SUPPORTED_MODELS } = require("./proxy");
const {
  applyPendingUpdate,
  checkForUpdatesManual,
  initAutoUpdater,
  registerUpdaterIpcHandlers,
} = require("./updater");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

let mainWindow;
let tray;
let isQuitting = false;
let config;
let proxy;

function normalizeThemeSource(themeSource) {
  return ["system", "light", "dark"].includes(themeSource) ? themeSource : "system";
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return normalizeConfig({});
  }
}

function normalizeConfig(raw) {
  const proxyPort = Number(raw.proxyPort || 15721);
  const defaultModel = String(raw.defaultModel || "gpt-5.4-mini").trim();
  return {
    enabled: Boolean(raw.enabled),
    proxyPort: Number.isInteger(proxyPort) ? proxyPort : 15721,
    defaultModel: defaultModel || "gpt-5.4-mini",
    themeSource: normalizeThemeSource(raw.themeSource),
  };
}

function validateSettings(settings) {
  const proxyPort = Number(settings.proxyPort);
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) {
    throw new Error("代理端口必须是 1024 到 65535 之间的整数");
  }
  return { proxyPort };
}

function saveConfig(next) {
  config = normalizeConfig({ ...config, ...next });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function createProxy() {
  proxy = new CodexOpenAIProxy({
    port: config.proxyPort || 15721,
    defaultModel: config.defaultModel || "gpt-5.4-mini",
  });
}

function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? "#111719" : "#f5f7f8";
}

function updateWindowTheme() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(windowBackgroundColor());
  }
}

function assetPath(...parts) {
  if (!app.isPackaged) return path.join(app.getAppPath(), ...parts);
  const externalPath = path.join(process.resourcesPath, ...parts);
  if (fs.existsSync(externalPath)) return externalPath;
  return path.join(app.getAppPath(), ...parts);
}

function runtimeAssetPath(fileName) {
  const externalPath = assetPath("build", fileName);
  if (fs.existsSync(externalPath)) return externalPath;
  return assetPath("src", "assets", fileName);
}

function statusPayload() {
  return {
    ...proxy.status(),
    desiredEnabled: Boolean(config.enabled),
    themeSource: normalizeThemeSource(config.themeSource),
    resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  };
}

function broadcastStatus() {
  const status = statusPayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("proxy:status-updated", status);
  }
  updateTrayMenu();
  return status;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const iconPath = runtimeAssetPath("icon.png");
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 720,
    minHeight: 560,
    title: "Codex OpenAI Proxy",
    backgroundColor: windowBackgroundColor(),
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (process.platform !== "darwin" || isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  createWindow();
}

async function setProxyEnabled(enabled) {
  if (enabled) {
    try {
      await proxy.start();
      saveConfig({ enabled: true });
    } catch (error) {
      proxy.lastError = error?.code === "EADDRINUSE"
        ? `端口 ${config.proxyPort || 15721} 已被占用`
        : error?.message || String(error);
      updateTrayMenu();
      throw new Error(proxy.lastError);
    }
  } else {
    await proxy.stop();
    saveConfig({ enabled: false });
  }
  return broadcastStatus();
}

async function toggleProxyFromMenu(enabled) {
  try {
    await setProxyEnabled(enabled);
  } catch (error) {
    const message = enabled ? "代理启动失败" : "代理关闭失败";
    dialogOrLog(message, error);
  }
}

function dialogOrLog(message, error) {
  const detail = error?.message || String(error);
  if (app.isReady()) {
    dialog.showMessageBox({
      type: "error",
      title: message,
      message,
      detail,
    });
    return;
  }
  console.error(`${message}: ${detail}`);
}

function createTray() {
  if (process.platform !== "darwin" || tray) return;

  const image = nativeImage.createFromPath(runtimeAssetPath("trayTemplate.png"));
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setIgnoreDoubleClickEvents(true);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || !proxy) return;

  const status = proxy.status();
  const baseUrl = status.baseUrl;
  const chatUrl = status.chatCompletionsUrl;
  tray.setToolTip([
    "Codex OpenAI Proxy",
    status.enabled ? "运行中" : "已关闭",
    `端口 ${status.proxyPort}`,
  ].join("\n"));

  const menu = Menu.buildFromTemplate([
    {
      label: status.enabled ? "代理运行中" : "代理已关闭",
      enabled: false,
    },
    {
      label: `支持模型：${SUPPORTED_MODELS.length} 个`,
      enabled: false,
    },
    {
      label: `端口：${status.proxyPort}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: status.enabled ? "关闭代理" : "开启代理",
      click: () => toggleProxyFromMenu(!status.enabled),
    },
    {
      label: "显示主窗口",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "复制 Base URL",
      enabled: status.enabled,
      click: () => clipboard.writeText(baseUrl),
    },
    {
      label: "复制 Chat Completions URL",
      enabled: status.enabled,
      click: () => clipboard.writeText(chatUrl),
    },
    { type: "separator" },
    {
      label: "检查更新...",
      click: () => checkForUpdatesManual(),
    },
    { type: "separator" },
    {
      label: "退出 Codex OpenAI Proxy",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function setMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "检查更新...",
          click: () => checkForUpdatesManual(),
        },
        {
          label: "显示主窗口",
          click: () => showMainWindow(),
        },
        { type: "separator" },
        {
          label: "退出 Codex OpenAI Proxy",
          accelerator: "Cmd+Q",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  app.setName("Codex OpenAI Proxy");
  if (applyPendingUpdate()) return;

  config = readConfig();
  nativeTheme.themeSource = normalizeThemeSource(config.themeSource);
  createProxy();
  registerUpdaterIpcHandlers();
  setMenu();
  createTray();
  initAutoUpdater();

  nativeTheme.on("updated", () => {
    updateWindowTheme();
    broadcastStatus();
  });

  if (config.enabled) {
    try {
      await proxy.start();
    } catch (error) {
      proxy.lastError = error?.code === "EADDRINUSE"
        ? `端口 ${config.proxyPort || 15721} 已被占用`
        : error?.message || String(error);
    }
  }
  updateTrayMenu();

  createWindow();

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  isQuitting = true;
  if (proxy?.enabled) await proxy.stop();
});

ipcMain.handle("proxy:status", () => statusPayload());

ipcMain.handle("proxy:toggle", async (_event, enabled) => {
  return setProxyEnabled(Boolean(enabled));
});

ipcMain.handle("proxy:testChat", async () => {
  if (!proxy.enabled) throw new Error("代理未启动");
  const response = await fetch(proxy.chatCompletionsUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer dummy",
    },
    body: JSON.stringify({
      model: proxy.defaultModel,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      stream: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "测试请求失败");
  return payload;
});

ipcMain.handle("settings:update", async (_event, settings) => {
  const nextSettings = validateSettings(settings);
  const previousConfig = { ...config };
  const wasEnabled = proxy.enabled;
  const portChanged = nextSettings.proxyPort !== config.proxyPort;

  if (!portChanged) {
    saveConfig(nextSettings);
    return broadcastStatus();
  }

  if (wasEnabled) await proxy.stop();
  saveConfig({ ...nextSettings, enabled: wasEnabled });
  createProxy();

  try {
    if (wasEnabled) await proxy.start();
  } catch (error) {
    const message = error?.code === "EADDRINUSE"
      ? `端口 ${nextSettings.proxyPort} 已被占用`
      : error?.message || String(error);
    saveConfig(previousConfig);
    createProxy();
    if (wasEnabled) {
      try {
        await proxy.start();
      } catch (restoreError) {
        proxy.lastError = restoreError?.message || String(restoreError);
      }
    }
    throw new Error(message);
  }

  return broadcastStatus();
});

ipcMain.handle("theme:update", (_event, themeSource) => {
  saveConfig({ themeSource: normalizeThemeSource(themeSource) });
  nativeTheme.themeSource = config.themeSource;
  updateWindowTheme();
  return broadcastStatus();
});

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("shell:openExternal", (_event, url) => {
  shell.openExternal(url);
  return true;
});
