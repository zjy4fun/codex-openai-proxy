const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const UPSTREAM_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CCS_AUTH_PATH = path.join(os.homedir(), ".cc-switch", "codex_oauth_auth.json");
const SUPPORTED_MODELS = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"];

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function authStatus() {
  const codex = readJson(CODEX_AUTH_PATH);
  if (codex?.tokens?.refresh_token || codex?.tokens?.access_token) {
    return {
      ready: true,
      source: "Codex",
      path: CODEX_AUTH_PATH,
      accountId: codex.tokens?.account_id || null,
    };
  }

  const ccs = readJson(CCS_AUTH_PATH);
  const accounts = ccs?.accounts && typeof ccs.accounts === "object" ? Object.keys(ccs.accounts) : [];
  if (accounts.length) {
    const accountId = ccs.default_account_id || accounts[0];
    return {
      ready: true,
      source: "CC Switch",
      path: CCS_AUTH_PATH,
      accountId,
    };
  }

  return {
    ready: false,
    source: "none",
    path: null,
    accountId: null,
  };
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function expiresSoon(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return payload.exp * 1000 < Date.now() + 60_000;
}

function getRefreshFromCcSwitch() {
  const store = readJson(CCS_AUTH_PATH);
  if (!store?.accounts) return null;
  const accountId = store.default_account_id || Object.keys(store.accounts)[0];
  const account = accountId ? store.accounts[accountId] : null;
  if (!account?.refresh_token) return null;
  return { accountId: account.account_id || accountId, refreshToken: account.refresh_token };
}

async function refreshTokens(refreshToken) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: "openid profile email",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "cc-switch-codex-oauth",
    },
    body: form,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth refresh failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function getAccessToken({ forceRefresh = false } = {}) {
  let auth = readJson(CODEX_AUTH_PATH);
  let tokens = auth?.tokens || {};
  let accountId = tokens.account_id;
  let refreshToken = tokens.refresh_token;

  if (!forceRefresh && tokens.access_token && !expiresSoon(tokens.access_token)) {
    return { accessToken: tokens.access_token, accountId };
  }

  if (!refreshToken) {
    const fromCcSwitch = getRefreshFromCcSwitch();
    refreshToken = fromCcSwitch?.refreshToken;
    accountId = accountId || fromCcSwitch?.accountId;
  }
  if (!refreshToken) {
    throw new Error(`No Codex OAuth refresh token found in ${CODEX_AUTH_PATH} or ${CCS_AUTH_PATH}`);
  }

  const refreshed = await refreshTokens(refreshToken);
  const nextRefreshToken = refreshed.refresh_token || refreshToken;
  const nextAccountId = accountId || tokens.account_id;
  auth = {
    ...(auth || {}),
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: refreshed.id_token || tokens.id_token,
      access_token: refreshed.access_token,
      refresh_token: nextRefreshToken,
      account_id: nextAccountId,
    },
    last_refresh: new Date().toISOString(),
  };
  writeJsonAtomic(CODEX_AUTH_PATH, auth);

  const ccs = readJson(CCS_AUTH_PATH);
  if (ccs?.accounts && nextAccountId && ccs.accounts[nextAccountId]) {
    ccs.accounts[nextAccountId].refresh_token = nextRefreshToken;
    writeJsonAtomic(CCS_AUTH_PATH, ccs);
  }

  return { accessToken: refreshed.access_token, accountId: nextAccountId };
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        if (part?.type === "input_text" && part?.text) return part.text;
        if (part?.type === "text" && part?.text) return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function normalizeModel(model, defaultModel) {
  if (typeof model === "string" && /^gpt-5(\.|-|$)/.test(model)) return model;
  return defaultModel;
}

function buildResponsesPayload(chatBody, defaultModel) {
  const messages = Array.isArray(chatBody.messages) ? chatBody.messages : [];
  const instructions = [];
  const transcript = [];

  for (const message of messages) {
    const role = String(message?.role || "user");
    const text = contentToText(message?.content).trim();
    if (!text) continue;
    if (role === "system" || role === "developer") {
      instructions.push(text);
    } else {
      transcript.push(`${role}: ${text}`);
    }
  }

  const payload = {
    model: normalizeModel(chatBody.model, defaultModel),
    instructions:
      instructions.join("\n\n") ||
      "You are a concise translation assistant. Return only the requested translation or answer.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: transcript.join("\n\n") || contentToText(chatBody.prompt) || "" }],
      },
    ],
    store: false,
    stream: true,
    reasoning: { effort: "none" },
  };
  return payload;
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

async function* responseEvents(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (!block.trim()) continue;
      const parsed = parseSseBlock(block);
      if (!parsed.data || parsed.data === "[DONE]") continue;
      try {
        yield { event: parsed.event, data: JSON.parse(parsed.data) };
      } catch {
        yield { event: "parse_error", data: { raw: parsed.data } };
      }
    }
  }
}

function chatChunk(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageFromResponses(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

class CodexOpenAIProxy {
  constructor(options = {}) {
    this.host = options.host || "127.0.0.1";
    this.port = Number(options.port || 15721);
    this.defaultModel = options.defaultModel || "gpt-5.4-mini";
    this.server = null;
    this.lastError = "";
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}/v1`;
  }

  get chatCompletionsUrl() {
    return `${this.baseUrl}/chat/completions`;
  }

  get enabled() {
    return Boolean(this.server);
  }

  status() {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      chatCompletionsUrl: this.chatCompletionsUrl,
      proxyPort: this.port,
      defaultModel: this.defaultModel,
      supportedModels: SUPPORTED_MODELS,
      auth: authStatus(),
      lastError: this.lastError,
    };
  }

  async start() {
    if (this.server) return this.status();
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.route(req, res));
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        this.server = server;
        this.lastError = "";
        resolve();
      });
    });
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    return this.status();
  }

  async openUpstream(chatBody, forceRefresh = false) {
    const auth = await getAccessToken({ forceRefresh });
    const response = await fetch(UPSTREAM_RESPONSES_URL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        "user-agent": "codex_cli_rs/0.80.0 (codex-openai-proxy)",
      },
      body: JSON.stringify(buildResponsesPayload(chatBody, this.defaultModel)),
    });

    if (response.status === 401 && !forceRefresh) {
      return this.openUpstream(chatBody, true);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(response.status, text || response.statusText);
    }
    return response;
  }

  async handleChatCompletions(res, body) {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const requestedStream = body.stream === true;
    const upstream = await this.openUpstream(body);
    let text = "";
    let model = normalizeModel(body.model, this.defaultModel);
    let usage;

    if (requestedStream) {
      res.writeHead(200, {
        ...corsHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      this.writeSse(res, chatChunk(id, created, model, { role: "assistant" }));
    }

    for await (const event of responseEvents(upstream)) {
      const data = event.data;
      if (data?.response?.model) model = data.response.model;
      if (data?.response?.usage) usage = data.response.usage;
      if (data?.type === "response.output_text.delta" && typeof data.delta === "string") {
        text += data.delta;
        if (requestedStream) this.writeSse(res, chatChunk(id, created, model, { content: data.delta }));
      }
    }

    if (requestedStream) {
      this.writeSse(res, chatChunk(id, created, model, {}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    this.sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: usageFromResponses(usage),
    });
  }

  async route(req, res) {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || `${this.host}:${this.port}`}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        this.sendJson(res, 200, { ok: true, service: "codex-openai-proxy", baseUrl: this.baseUrl });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        this.sendJson(res, 200, {
          object: "list",
          data: SUPPORTED_MODELS.map((id) => ({
            id,
            object: "model",
            owned_by: "openai",
          })),
        });
        return;
      }

      if (req.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
        const raw = await readBody(req);
        await this.handleChatCompletions(res, raw ? JSON.parse(raw) : {});
        return;
      }

      this.sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      this.sendJson(res, status, {
        error: {
          message: error?.message || String(error),
          type: status >= 500 ? "server_error" : "invalid_request_error",
        },
      });
    }
  }

  sendJson(res, status, value) {
    res.writeHead(status, {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  }

  writeSse(res, value) {
    res.write(`data: ${JSON.stringify(value)}\n\n`);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = {
  CodexOpenAIProxy,
  authStatus,
  buildResponsesPayload,
  SUPPORTED_MODELS,
};
