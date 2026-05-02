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
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {
      enabled: false,
      proxyPort: 15721,
      defaultModel: "gpt-5.4-mini",
    };
  }
}

function saveConfig(next) {
  config = { ...config, ...next };
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

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("shell:openExternal", (_event, url) => {
  shell.openExternal(url);
  return true;
});
