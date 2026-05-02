const { app, BrowserWindow, ipcMain, clipboard, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { CodexOpenAIProxy } = require("./proxy");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

let mainWindow;
let config;
let proxy;

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
  };
}

function validateSettings(settings) {
  const proxyPort = Number(settings.proxyPort);
  const defaultModel = String(settings.defaultModel || "").trim();
  if (!defaultModel) {
    throw new Error("默认模型不能为空");
  }
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) {
    throw new Error("代理端口必须是 1024 到 65535 之间的整数");
  }
  return { proxyPort, defaultModel };
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

function statusPayload() {
  return {
    ...proxy.status(),
    desiredEnabled: Boolean(config.enabled),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 720,
    minHeight: 560,
    title: "Codex OpenAI Proxy",
    backgroundColor: "#f5f7f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function setMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" },
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
  config = readConfig();
  createProxy();
  setMenu();

  if (config.enabled) {
    try {
      await proxy.start();
    } catch (error) {
      proxy.lastError = error?.code === "EADDRINUSE"
        ? `端口 ${config.proxyPort || 15721} 已被占用`
        : error?.message || String(error);
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (proxy?.enabled) await proxy.stop();
});

ipcMain.handle("proxy:status", () => statusPayload());

ipcMain.handle("proxy:toggle", async (_event, enabled) => {
  if (enabled) {
    try {
      await proxy.start();
      saveConfig({ enabled: true });
    } catch (error) {
      proxy.lastError = error?.code === "EADDRINUSE"
        ? `端口 ${config.proxyPort || 15721} 已被占用`
        : error?.message || String(error);
      throw new Error(proxy.lastError);
    }
  } else {
    await proxy.stop();
    saveConfig({ enabled: false });
  }
  return statusPayload();
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
      model: config.defaultModel || "gpt-5.4-mini",
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
    proxy.defaultModel = config.defaultModel;
    return statusPayload();
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

  return statusPayload();
});

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("shell:openExternal", (_event, url) => {
  shell.openExternal(url);
  return true;
});
