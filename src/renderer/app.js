const els = {
  dot: document.querySelector("#dot"),
  stateText: document.querySelector("#stateText"),
  enabledSwitch: document.querySelector("#enabledSwitch"),
  switchNote: document.querySelector("#switchNote"),
  authState: document.querySelector("#authState"),
  modelState: document.querySelector("#modelState"),
  portState: document.querySelector("#portState"),
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
  els.modelState.textContent = status.defaultModel;
  els.portState.textContent = String(status.proxyPort);
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

async function copy(text) {
  await window.proxyApp.copy(text);
  setMessage("已复制。", "good");
}

els.enabledSwitch.addEventListener("change", (event) => toggle(event.target.checked));
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

loadStatus();
setInterval(loadStatus, 5000);
