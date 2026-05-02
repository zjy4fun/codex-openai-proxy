const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, shell } = require("electron");
const originalFs = require("original-fs");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "zjy4fun/codex-openai-proxy";
const PRODUCT_NAME = "Codex OpenAI Proxy";
const ASAR_ASSET_NAME = "app.asar";
const UPDATE_WINDOW_CHANNEL = "proxy:update-state";
const SKIPPED_UPDATE_FILE = "skipped-update.json";
const COMPACT_UPDATE_WINDOW_SIZE = { width: 480, height: 198 };
const RELEASE_NOTES_WINDOW_SIZE = { width: 680, height: 560 };

class GitHubApiStatusError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "GitHubApiStatusError";
    this.statusCode = statusCode;
  }
}

class UpdateCancelledError extends Error {
  constructor() {
    super("Update download canceled");
    this.name = "UpdateCancelledError";
  }
}

let updateWindow = null;
let updateWindowState = null;
let cancelActiveDownload = null;
let pendingUpdateActionResolver = null;
let pendingUpdateActionButtons = new Set();
let updaterIpcRegistered = false;
let updaterLifecycleRegistered = false;
let updateApplyHelperScheduled = false;
let pendingUpdateLaunchNotice = null;

function getPendingUpdateDir() {
  return path.join(app.getPath("userData"), "pending-update");
}

function getStagedAsarPath() {
  return path.join(getPendingUpdateDir(), ASAR_ASSET_NAME);
}

function getInstalledAsarPath() {
  return path.join(process.resourcesPath, ASAR_ASSET_NAME);
}

function getAsarBackupPath() {
  return path.join(getPendingUpdateDir(), "app.asar.backup");
}

function getApplyUpdateScriptPath() {
  return path.join(getPendingUpdateDir(), "apply-update.sh");
}

function getApplyUpdateLogPath() {
  return path.join(getPendingUpdateDir(), "apply-update.log");
}

function getSkippedUpdateStatePath() {
  return path.join(app.getPath("userData"), SKIPPED_UPDATE_FILE);
}

function loadSkippedUpdateState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSkippedUpdateStatePath(), "utf8"));
    return {
      version: typeof parsed.version === "string" && parsed.version.trim()
        ? parsed.version.trim()
        : null,
    };
  } catch {
    return { version: null };
  }
}

function saveSkippedUpdateState(state) {
  try {
    const filePath = getSkippedUpdateStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    console.error("Failed to save skipped update state:", error);
  }
}

function skipVersion(version) {
  saveSkippedUpdateState({ version });
}

function clearSkippedVersion(version) {
  const current = loadSkippedUpdateState();
  if (!current.version) return;
  if (version && current.version !== version) return;
  saveSkippedUpdateState({ version: null });
}

function isVersionSkipped(version) {
  return loadSkippedUpdateState().version === version;
}

function ensurePendingUpdateDir() {
  fs.mkdirSync(getPendingUpdateDir(), { recursive: true });
}

function getMacAppBundlePath() {
  const appBundlePath = path.resolve(process.execPath, "..", "..", "..");
  if (!appBundlePath.endsWith(".app")) {
    throw new Error(`无法从当前进程路径解析 macOS app bundle: ${process.execPath}`);
  }
  return appBundlePath;
}

function writeMacApplyUpdateScript(scriptPath) {
  const script = `#!/bin/sh
set -eu

PID="$1"
STAGED="$2"
TARGET="$3"
BACKUP="$4"
APP_BUNDLE="$5"
RELAUNCH="$6"
LOG_FILE="$7"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG_FILE"
}

reopen_app() {
  if [ "$RELAUNCH" != "1" ]; then
    return
  fi
  /usr/bin/open -n "$APP_BUNDLE" >/dev/null 2>&1 || true
}

: > "$LOG_FILE"
log "waiting for pid $PID to exit"

while kill -0 "$PID" 2>/dev/null; do
  sleep 1
done

if [ ! -f "$STAGED" ]; then
  log "staged update missing: $STAGED"
  reopen_app
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  log "installed app.asar missing: $TARGET"
  reopen_app
  exit 1
fi

if ! cp -f "$TARGET" "$BACKUP"; then
  log "failed to back up installed app.asar"
  reopen_app
  exit 1
fi

if ! cp -f "$STAGED" "$TARGET"; then
  STATUS=$?
  log "failed to copy staged update into place (exit $STATUS)"
  if [ -f "$BACKUP" ]; then
    cp -f "$BACKUP" "$TARGET" || true
  fi
  reopen_app
  exit "$STATUS"
fi

rm -f "$STAGED" "$BACKUP"
log "update applied successfully"
reopen_app
log "helper finished"
`;

  originalFs.writeFileSync(scriptPath, script, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
}

function scheduleMacApplyUpdate(relaunchAfterApply) {
  if (updateApplyHelperScheduled) return;

  const staged = getStagedAsarPath();
  if (!originalFs.existsSync(staged)) {
    throw new Error("没有找到已下载的更新包。");
  }

  ensurePendingUpdateDir();

  const scriptPath = getApplyUpdateScriptPath();
  writeMacApplyUpdateScript(scriptPath);

  const helper = spawn(
    "/bin/sh",
    [
      scriptPath,
      String(process.pid),
      staged,
      getInstalledAsarPath(),
      getAsarBackupPath(),
      getMacAppBundlePath(),
      relaunchAfterApply ? "1" : "0",
      getApplyUpdateLogPath(),
    ],
    { detached: true, stdio: "ignore" },
  );

  helper.unref();
  updateApplyHelperScheduled = true;
}

function showApplyUpdateError(error) {
  const detail = error instanceof Error ? error.message : "未知错误";
  dialog.showMessageBox({
    type: "error",
    title: "更新失败",
    message: "无法准备已下载的更新。",
    detail: `${detail}\n\n如果一直失败，请从 GitHub Release 手动安装最新版。`,
  });
}

function restartToApplyUpdate() {
  closeUpdateWindow();

  if (!app.isPackaged) {
    app.relaunch();
    app.exit(0);
    return;
  }

  if (process.platform === "darwin" && originalFs.existsSync(getStagedAsarPath())) {
    scheduleMacApplyUpdate(true);
    app.quit();
    return;
  }

  app.relaunch();
  app.exit(0);
}

function showPendingUpdateLaunchNoticeIfNeeded() {
  if (!pendingUpdateLaunchNotice) return;

  const detail = pendingUpdateLaunchNotice;
  pendingUpdateLaunchNotice = null;

  dialog.showMessageBox({
    type: "info",
    title: "更新仍在等待安装",
    message: `${PRODUCT_NAME} 还有一个已下载更新等待安装。`,
    detail,
  });
}

function registerUpdaterLifecycleHandlers() {
  if (updaterLifecycleRegistered) return;
  updaterLifecycleRegistered = true;

  app.on("before-quit", () => {
    if (
      !app.isPackaged ||
      process.platform !== "darwin" ||
      updateApplyHelperScheduled ||
      !originalFs.existsSync(getStagedAsarPath())
    ) {
      return;
    }

    try {
      scheduleMacApplyUpdate(false);
    } catch (error) {
      console.error("Failed to schedule pending update on quit:", error);
    }
  });
}

function applyPendingUpdate() {
  if (!app.isPackaged) return false;

  const staged = getStagedAsarPath();
  if (!originalFs.existsSync(staged)) return false;

  if (process.platform === "darwin") {
    pendingUpdateLaunchNotice =
      "请完全退出应用一次，让后台更新助手替换 app.asar。若版本号仍未变化，请从 GitHub Release 手动安装最新版。";
    return false;
  }

  const target = getInstalledAsarPath();
  const backup = getAsarBackupPath();

  try {
    ensurePendingUpdateDir();
    originalFs.copyFileSync(target, backup);
    originalFs.copyFileSync(staged, target);
    originalFs.unlinkSync(staged);

    try {
      originalFs.unlinkSync(backup);
    } catch {
      // Ignore cleanup failures.
    }

    app.relaunch();
    app.exit(0);
    return true;
  } catch (error) {
    console.error("Failed to apply pending update:", error);
    if (originalFs.existsSync(backup)) {
      try {
        originalFs.copyFileSync(backup, target);
        originalFs.unlinkSync(backup);
      } catch {
        // Ignore restore cleanup failures.
      }
    }
    try {
      originalFs.unlinkSync(staged);
    } catch {
      // Ignore cleanup failures.
    }
    return false;
  }
}

function readHeaderValue(header) {
  if (!header) return null;
  return Array.isArray(header) ? header[0] || null : header;
}

function parseReleaseTagFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/releases\/(?:tag|download)\/([^/]+)/i);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseReleaseTagFromHtml(html) {
  if (!html) return null;
  const match = html.match(/\/releases\/tag\/(v[0-9][0-9A-Za-z._-]*)/i);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseGitHubApiErrorMessage(statusCode, body) {
  let details = "";
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      details = parsed.message.trim();
    }
  } catch {
    // Ignore JSON parse failures.
  }

  return details
    ? `GitHub API returned ${statusCode}: ${details}`
    : `GitHub API returned ${statusCode}`;
}

async function fetchLatestReleaseFromApi() {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url: `https://api.github.com/repos/${REPO}/releases/latest`,
    });
    request.setHeader("Accept", "application/vnd.github.v3+json");
    request.setHeader("User-Agent", `${PRODUCT_NAME}/${app.getVersion()}`);

    let body = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          const statusCode = response.statusCode || 0;
          reject(new GitHubApiStatusError(statusCode, parseGitHubApiErrorMessage(statusCode, body)));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchLatestReleaseTagFromPage() {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url: `https://github.com/${REPO}/releases/latest`,
    });
    request.setHeader("Accept", "text/html");
    request.setHeader("User-Agent", `${PRODUCT_NAME}/${app.getVersion()}`);

    let body = "";
    let redirectTag = null;

    request.on("redirect", (_statusCode, _method, redirectUrl) => {
      if (redirectTag) return;
      redirectTag = parseReleaseTagFromUrl(redirectUrl);
    });

    request.on("response", (response) => {
      if ((response.statusCode || 0) >= 400) {
        reject(new Error(`GitHub releases page returned ${response.statusCode}`));
        return;
      }

      const locationTag = parseReleaseTagFromUrl(readHeaderValue(response.headers.location) || "");
      if (!redirectTag && locationTag) redirectTag = locationTag;

      response.on("data", (chunk) => {
        if (body.length >= 512_000) return;
        body += chunk.toString();
      });

      response.on("end", () => {
        if (redirectTag) {
          resolve(redirectTag);
          return;
        }

        const htmlTag = parseReleaseTagFromHtml(body);
        if (htmlTag) {
          resolve(htmlTag);
          return;
        }

        reject(new Error("无法解析 GitHub 最新 Release。"));
      });
    });

    request.on("error", reject);
    request.end();
  });
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const na = pa[index] || 0;
    const nb = pb[index] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function fetchLatestRelease() {
  try {
    return await fetchLatestReleaseFromApi();
  } catch (error) {
    if (
      !(error instanceof GitHubApiStatusError) ||
      (error.statusCode !== 403 && error.statusCode !== 429)
    ) {
      throw error;
    }

    const tag = await fetchLatestReleaseTagFromPage();
    return {
      tag_name: tag,
      body: "",
      html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
      assetInfoIncomplete: true,
      assets: [
        {
          name: ASAR_ASSET_NAME,
          browser_download_url: `https://github.com/${REPO}/releases/latest/download/${ASAR_ASSET_NAME}`,
          size: 0,
        },
      ],
    };
  }
}

function formatReleaseNotes(body) {
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) return "此版本没有发布更新说明。";
  return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000).trim()}\n\n...` : trimmed;
}

function resolveAvailableUpdatePlan(input) {
  if (!input.manual && input.skipped) return { kind: "skip" };
  if (!input.hasHotUpdateAsset || input.assetInfoIncomplete) return { kind: "prompt-open-release" };
  return { kind: "prompt-download" };
}

function shouldCloseWindowForAction(action) {
  return action !== "download";
}

function createManualUpdatePromptState(release, remoteVersion, options) {
  const detailLines = [`${PRODUCT_NAME} ${remoteVersion} 已可用。`];
  if (options.skipped) detailLines.push("你之前选择跳过这个版本。");
  if (options.detailSuffix) detailLines.push(options.detailSuffix);

  return {
    title: `发现新版本 ${remoteVersion}`,
    detail: detailLines.join(" "),
    downloadedBytes: 0,
    totalBytes: 1,
    progress: 0,
    showProgress: false,
    badge: options.skipped ? "已跳过" : "新版本",
    notesLabel: "更新说明",
    notes: formatReleaseNotes(release.body),
    tertiaryAction: "skip-version",
    tertiaryLabel: "跳过此版本",
    secondaryAction: "close",
    secondaryLabel: "稍后",
    primaryAction: options.primaryAction,
    primaryLabel: options.primaryLabel,
  };
}

function promptForManualUpdateAction(state) {
  return new Promise((resolve) => {
    pendingUpdateActionResolver = resolve;
    pushUpdateWindowState(state);
  });
}

async function confirmManualUpdateAvailable(release, remoteVersion) {
  return promptForManualUpdateAction(
    createManualUpdatePromptState(release, remoteVersion, {
      primaryAction: "download",
      primaryLabel: "下载更新",
      skipped: isVersionSkipped(remoteVersion),
    }),
  );
}

async function handleManualInstallerOnlyUpdate(release, remoteVersion) {
  const action = await promptForManualUpdateAction(
    createManualUpdatePromptState(release, remoteVersion, {
      primaryAction: "open-release",
      primaryLabel: "打开 Release",
      detailSuffix: "这个版本没有发布热更新包，需要下载完整安装包。",
      skipped: isVersionSkipped(remoteVersion),
    }),
  );

  if (action === "skip-version") {
    skipVersion(remoteVersion);
    return;
  }

  if (action === "open-release" && release.html_url) {
    clearSkippedVersion(remoteVersion);
    await shell.openExternal(release.html_url);
  }
}

async function handleManualUpdateWithUnknownAssets(release, remoteVersion) {
  const action = await promptForManualUpdateAction(
    createManualUpdatePromptState(release, remoteVersion, {
      primaryAction: "open-release",
      primaryLabel: "打开 Release",
      detailSuffix: "暂时无法确认是否有热更新包。",
      skipped: isVersionSkipped(remoteVersion),
    }),
  );

  if (action === "skip-version") {
    skipVersion(remoteVersion);
    return;
  }

  if (action === "open-release" && release.html_url) {
    clearSkippedVersion(remoteVersion);
    await shell.openExternal(release.html_url);
  }
}

function normalizeByteCount(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw);
}

function parseContentLength(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return 0;
  return normalizeByteCount(Number(value));
}

function clampProgress(progress) {
  if (!Number.isFinite(progress)) return 0;
  if (progress < 0) return 0;
  if (progress > 1) return 1;
  return progress;
}

function getUpdateWindowSize(state) {
  return state?.notes ? RELEASE_NOTES_WINDOW_SIZE : COMPACT_UPDATE_WINDOW_SIZE;
}

function updateWindowButtonsForState(state) {
  const next = new Set();
  if (!state) return next;
  if (state.primaryAction) next.add(state.primaryAction);
  if (state.secondaryAction) next.add(state.secondaryAction);
  if (state.tertiaryAction) next.add(state.tertiaryAction);
  return next;
}

function resolvePendingUpdateAction(action) {
  if (!pendingUpdateActionResolver) return;
  const resolve = pendingUpdateActionResolver;
  pendingUpdateActionResolver = null;
  pendingUpdateActionButtons = new Set();
  resolve(action);
}

function resizeUpdateWindowForState(state) {
  if (!updateWindow || updateWindow.isDestroyed()) return;
  const size = getUpdateWindowSize(state);
  updateWindow.setContentSize(size.width, size.height);
}

function createUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) return updateWindow;

  const initialSize = getUpdateWindowSize(updateWindowState);
  const macWindowChrome = process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 12 } }
    : {};

  const win = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ececec",
    title: `Updating ${PRODUCT_NAME}`,
    ...macWindowChrome,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.once("ready-to-show", () => {
    resizeUpdateWindowForState(updateWindowState);
    if (!win.isDestroyed()) win.show();
  });

  win.webContents.on("did-finish-load", () => {
    resizeUpdateWindowForState(updateWindowState);
    if (updateWindowState && !win.isDestroyed()) {
      win.webContents.send(UPDATE_WINDOW_CHANNEL, updateWindowState);
    }
  });

  win.on("closed", () => {
    updateWindow = null;
    if (cancelActiveDownload) {
      const cancel = cancelActiveDownload;
      cancelActiveDownload = null;
      cancel();
    }
    resolvePendingUpdateAction("close");
  });

  win.loadFile(path.join(__dirname, "renderer", "update-window.html")).catch((error) => {
    console.error("Failed to load update window:", error);
  });

  updateWindow = win;
  return win;
}

function closeUpdateWindow() {
  if (!updateWindow || updateWindow.isDestroyed()) {
    updateWindow = null;
    resolvePendingUpdateAction("close");
    return;
  }
  updateWindow.close();
}

function pushUpdateWindowState(state) {
  updateWindowState = state;
  pendingUpdateActionButtons = updateWindowButtonsForState(state);
  const win = createUpdateWindow();
  resizeUpdateWindowForState(state);
  if (!win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send(UPDATE_WINDOW_CHANNEL, state);
  }
}

function createCheckingForUpdatesState() {
  return {
    title: "正在检查更新...",
    detail: "正在读取 GitHub Release 中的最新版本。",
    downloadedBytes: 0,
    totalBytes: 1,
    progress: 0,
    showProgress: false,
    badge: "检查中",
  };
}

function createDownloadingState(version, downloadedBytes, totalBytes) {
  const safeTotal = Math.max(
    normalizeByteCount(totalBytes),
    normalizeByteCount(downloadedBytes),
    1,
  );
  const safeDownloaded = Math.min(normalizeByteCount(downloadedBytes), safeTotal);

  return {
    title: "正在下载更新...",
    detail: `${PRODUCT_NAME} ${version}`,
    downloadedBytes: safeDownloaded,
    totalBytes: safeTotal,
    progress: clampProgress(safeDownloaded / safeTotal),
    showProgress: true,
    primaryAction: "cancel",
    primaryLabel: "取消",
  };
}

async function downloadAsset(url, dest, options) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    originalFs.unlinkSync(dest);
  } catch {
    // Ignore missing staged update.
  }

  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url });
    request.setHeader("User-Agent", `${PRODUCT_NAME}/${app.getVersion()}`);
    request.setHeader("Accept", "application/octet-stream");

    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      options.onCancelableChange(null);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const cancel = () => {
      if (settled) return;
      try {
        request.abort();
      } catch {
        // Ignore abort failures.
      }
      finish(new UpdateCancelledError());
    };

    options.onCancelableChange(cancel);

    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        finish(new Error(`下载失败，HTTP 状态码 ${response.statusCode}`));
        return;
      }

      const reportedTotalBytes = parseContentLength(response.headers["content-length"]);
      const fallbackTotalBytes = normalizeByteCount(options.expectedBytes);
      const totalBytes = reportedTotalBytes || fallbackTotalBytes;

      const chunks = [];
      let downloadedBytes = 0;
      options.onProgress(0, totalBytes);

      response.on("data", (chunk) => {
        if (settled) return;
        const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(nextChunk);
        downloadedBytes += nextChunk.length;
        options.onProgress(downloadedBytes, totalBytes);
      });

      response.on("aborted", () => {
        finish(new UpdateCancelledError());
      });

      response.on("error", (error) => {
        finish(error);
      });

      response.on("end", () => {
        if (settled) return;
        try {
          originalFs.writeFileSync(dest, Buffer.concat(chunks));
          const finalBytes = totalBytes || downloadedBytes;
          options.onProgress(finalBytes, finalBytes);
          finish();
        } catch (error) {
          finish(error);
        }
      });
    });

    request.on("error", (error) => {
      finish(error);
    });

    request.end();
  });
}

async function checkAndDownload(manual) {
  const release = await fetchLatestRelease();
  const remoteVersion = release.tag_name.replace(/^v/, "");
  const localVersion = app.getVersion();

  if (compareVersions(remoteVersion, localVersion) <= 0) {
    clearSkippedVersion();
    if (manual) {
      closeUpdateWindow();
      dialog.showMessageBox({
        type: "info",
        title: "没有可用更新",
        message: "你正在使用最新版本。",
      });
    }
    return;
  }

  const asarAsset = release.assets.find((asset) => asset.name === ASAR_ASSET_NAME);
  const updatePlan = resolveAvailableUpdatePlan({
    manual,
    skipped: isVersionSkipped(remoteVersion),
    hasHotUpdateAsset: Boolean(asarAsset),
    assetInfoIncomplete: Boolean(release.assetInfoIncomplete),
  });

  if (updatePlan.kind === "skip") return;

  if (updatePlan.kind === "prompt-open-release") {
    if (release.assetInfoIncomplete) {
      await handleManualUpdateWithUnknownAssets(release, remoteVersion);
      return;
    }

    await handleManualInstallerOnlyUpdate(release, remoteVersion);
    return;
  }

  const action = await confirmManualUpdateAvailable(release, remoteVersion);
  if (action === "skip-version") {
    skipVersion(remoteVersion);
    return;
  }
  if (action !== "download" || !asarAsset) return;

  clearSkippedVersion(remoteVersion);
  pushUpdateWindowState(createDownloadingState(remoteVersion, 0, asarAsset.size));

  try {
    await downloadAsset(asarAsset.browser_download_url, getStagedAsarPath(), {
      expectedBytes: asarAsset.size,
      onCancelableChange: (cancel) => {
        cancelActiveDownload = cancel;
      },
      onProgress: (downloadedBytes, totalBytes) => {
        pushUpdateWindowState(
          createDownloadingState(
            remoteVersion,
            downloadedBytes,
            totalBytes || asarAsset.size,
          ),
        );
      },
    });
  } catch (error) {
    if (error instanceof UpdateCancelledError) {
      closeUpdateWindow();
      return;
    }

    pushUpdateWindowState({
      title: "更新失败",
      detail: error instanceof Error ? error.message : "未知错误",
      downloadedBytes: 0,
      totalBytes: 1,
      progress: 0,
      showProgress: false,
      primaryAction: "close",
      primaryLabel: "关闭",
    });
    return;
  } finally {
    cancelActiveDownload = null;
  }

  pushUpdateWindowState({
    title: "更新已下载",
    detail: `版本 ${remoteVersion} 已下载完成。重启应用后生效。`,
    downloadedBytes: Math.max(asarAsset.size, 1),
    totalBytes: Math.max(asarAsset.size, 1),
    progress: 1,
    showProgress: true,
    primaryAction: "restart",
    primaryLabel: "现在重启",
    secondaryAction: "close",
    secondaryLabel: "稍后",
  });
}

function registerUpdaterIpcHandlers() {
  if (updaterIpcRegistered) return;
  updaterIpcRegistered = true;

  ipcMain.handle("proxy:update-cancel", () => {
    if (cancelActiveDownload) {
      const cancel = cancelActiveDownload;
      cancelActiveDownload = null;
      cancel();
    }
    closeUpdateWindow();
  });

  ipcMain.handle("proxy:update-restart", () => {
    try {
      restartToApplyUpdate();
    } catch (error) {
      showApplyUpdateError(error);
    }
  });

  ipcMain.handle("proxy:update-close-window", () => {
    closeUpdateWindow();
  });

  ipcMain.handle("proxy:update-run-action", (_event, rawAction) => {
    if (typeof rawAction !== "string") return;
    if (!pendingUpdateActionButtons.has(rawAction)) return;
    resolvePendingUpdateAction(rawAction);
    if (shouldCloseWindowForAction(rawAction)) {
      closeUpdateWindow();
    }
  });
}

function initAutoUpdater() {
  if (!app.isPackaged) return;

  registerUpdaterLifecycleHandlers();
  showPendingUpdateLaunchNoticeIfNeeded();

  setTimeout(() => {
    checkAndDownload(false).catch(() => {});
  }, 10_000);
}

function checkForUpdatesManual() {
  pushUpdateWindowState(createCheckingForUpdatesState());

  checkAndDownload(true).catch((error) => {
    closeUpdateWindow();
    dialog.showMessageBox({
      type: "error",
      title: "检查更新失败",
      message: "无法检查更新。",
      detail: error?.message || "未知错误",
    });
  });
}

module.exports = {
  applyPendingUpdate,
  checkForUpdatesManual,
  initAutoUpdater,
  registerUpdaterIpcHandlers,
};
