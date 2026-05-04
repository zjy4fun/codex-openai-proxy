const els = {
  dot: document.querySelector("#dot"),
  stateText: document.querySelector("#stateText"),
  enabledSwitch: document.querySelector("#enabledSwitch"),
  switchNote: document.querySelector("#switchNote"),
  authState: document.querySelector("#authState"),
  modelsList: document.querySelector("#modelsList"),
  portInput: document.querySelector("#portInput"),
  saveSettingsBtn: document.querySelector("#saveSettingsBtn"),
  baseUrl: document.querySelector("#baseUrl"),
  chatUrl: document.querySelector("#chatUrl"),
  baseRow: document.querySelector("#baseRow"),
  chatRow: document.querySelector("#chatRow"),
  message: document.querySelector("#message"),
  refreshBtn: document.querySelector("#refreshBtn"),
  testBtn: document.querySelector("#testBtn"),
  copyBase: document.querySelector("#copyBase"),
  copyChat: document.querySelector("#copyChat"),
  copyKey: document.querySelector("#copyKey"),
};

let current = null;
let settingsDirty = false;
let renderedModels = "";

function setMessage(text, kind = "") {
  els.message.textContent = text || "";
  els.message.className = "message" + (kind ? " " + kind : "");
}

function render(status) {
  current = status;
  els.enabledSwitch.checked = status.enabled;
  els.dot.classList.toggle("on", status.enabled);
  els.stateText.textContent = status.enabled ? "运行中" : "已关闭";
  els.switchNote.textContent = status.enabled ? "OpenAI Base URL 已可用。" : "打开后显示可用 Base URL。";
  els.authState.textContent = status.auth.ready ? status.auth.source : "未找到";
  const models = Array.isArray(status.supportedModels) ? status.supportedModels : [];
  const modelsKey = models.join("\n");
  if (modelsKey !== renderedModels) {
    renderedModels = modelsKey;
    els.modelsList.replaceChildren(...models.map((model) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "model-copy";
      button.type = "button";
      button.textContent = model;
      button.setAttribute("aria-label", `复制模型名 ${model}`);
      button.addEventListener("click", () => copy(model, `已复制模型：${model}`));
      item.append(button);
      return item;
    }));
  }
  if (!settingsDirty) {
    els.portInput.value = String(status.proxyPort);
    els.saveSettingsBtn.disabled = true;
  }
  els.baseUrl.textContent = status.enabled ? status.baseUrl : "打开开关后显示";
  els.chatUrl.textContent = status.enabled ? status.chatCompletionsUrl : "打开开关后显示";
  els.baseRow.classList.toggle("dim", !status.enabled);
  els.chatRow.classList.toggle("dim", !status.enabled);
  if (status.lastError) setMessage(status.lastError, "bad");
}

async function loadStatus() {
  try {
    render(await window.proxyApp.getStatus());
  } catch (error) {
    setMessage(error.message, "bad");
  }
}

async function toggle(enabled) {
  els.enabledSwitch.disabled = true;
  setMessage(enabled ? "正在启动..." : "正在关闭...");
  try {
    render(await window.proxyApp.toggle(enabled));
    setMessage(enabled ? "代理已启动。" : "代理已关闭。", enabled ? "good" : "");
  } catch (error) {
    setMessage(error.message, "bad");
    await loadStatus();
  } finally {
    els.enabledSwitch.disabled = false;
  }
}

async function copy(text, successMessage = "已复制。") {
  await window.proxyApp.copy(text);
  setMessage(successMessage, "good");
}

function markSettingsDirty() {
  settingsDirty = true;
  els.saveSettingsBtn.disabled = false;
  setMessage("配置有改动，保存后生效。");
}

async function saveSettings() {
  const previousPort = current?.proxyPort;
  els.saveSettingsBtn.disabled = true;
  setMessage("正在保存配置...");
  try {
    const status = await window.proxyApp.updateSettings({
      proxyPort: Number(els.portInput.value),
    });
    settingsDirty = false;
    render(status);
    setMessage(previousPort && previousPort !== status.proxyPort && status.enabled
      ? "配置已保存，代理已切换到新端口。"
      : "配置已保存。", "good");
  } catch (error) {
    els.saveSettingsBtn.disabled = false;
    setMessage(error.message, "bad");
    await loadStatus();
  }
}

els.enabledSwitch.addEventListener("change", (event) => toggle(event.target.checked));
els.portInput.addEventListener("input", markSettingsDirty);
els.saveSettingsBtn.addEventListener("click", saveSettings);
els.refreshBtn.addEventListener("click", loadStatus);
els.copyBase.addEventListener("click", () => current?.enabled && copy(current.baseUrl));
els.copyChat.addEventListener("click", () => current?.enabled && copy(current.chatCompletionsUrl));
els.copyKey.addEventListener("click", () => copy("dummy"));
els.testBtn.addEventListener("click", async () => {
  setMessage("正在测试...");
  try {
    const payload = await window.proxyApp.testChat();
    const content = payload.choices?.[0]?.message?.content || "";
    setMessage(content.trim() === "ok" ? "测试通过。" : "测试返回：" + content, "good");
  } catch (error) {
    setMessage(error.message, "bad");
  }
});

if (typeof window.proxyApp.onStatusUpdated === "function") {
  window.proxyApp.onStatusUpdated((status) => {
    render(status);
  });
}

loadStatus();
setInterval(loadStatus, 5000);
