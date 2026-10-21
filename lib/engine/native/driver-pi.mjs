// Driver Pi cho engine native: bọc Pi SDK (cùng cách MTH dùng) thành giao diện
// nhỏ createDriver() -> { prompt, abort, usage, dispose }.
//
// Không tool có sẵn: noTools + customTools đúng 5 tool của native. Model chọn
// qua mth.mjs; Pi đọc models qua agent dir riêng của Dystopia
// (PI_CODING_AGENT_DIR = $DYSTOPIA_AGENT_DIR, mặc định $DYSTOPIA_HOME/agent).
// Key lấy từ biến COMMANDCODE_API_KEY (models.json ghi tên biến, không ghi giá trị).
// Chỉ dùng module có sẵn của Node.

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError } from '../ocr.mjs';
import { agentDir as dystopiaAgentDir, piSdkPath } from './config.mjs';

export { piSdkPath };

function sdkError(message) {
  return new EngineError(message, { code: 'NATIVE_PI_SDK', exitCode: 64 });
}

export async function loadPiSdk(options = {}) {
  const env = options.env ?? process.env;
  const file = options.sdkPath ?? piSdkPath(env);
  if (!existsSync(file)) {
    throw sdkError(
      `không tìm thấy Pi SDK tại ${file}: đặt DYSTOPIA_PI_SDK tới dist/index.js của @earendil-works/pi-coding-agent hoặc DYSTOPIA_HOME tới thư mục cài Dystopia`,
    );
  }
  return import(pathToFileURL(file).href);
}

// Chuyển tool của Dystopia sang ToolDefinition của Pi. Lỗi tool trả về nội dung
// để model đọc và sửa, không làm sập lượt.
export function toPiTools(tools, toolDefs) {
  return toolDefs.map((spec) => ({
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId, params = {}) => {
      try {
        const output = await tools[spec.name](params);
        return { content: [{ type: 'text', text: String(output ?? '') }], details: {} };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `lỗi ${spec.name}: ${error?.message ?? error}` }],
          details: { error: error?.message ?? String(error) },
          isError: true,
        };
      }
    },
  }));
}

function usageDelta(message) {
  const usage = message?.usage ?? message?.assistantMessage?.usage ?? {};
  const input = usage.input ?? usage.inputTokens ?? usage.promptTokens ?? 0;
  const output = usage.output ?? usage.outputTokens ?? usage.completionTokens ?? 0;
  return { tokens_in: Number(input) || 0, tokens_out: Number(output) || 0 };
}

function pushText(parts, value) {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (text !== '') parts.push(text);
}

function errorTextParts(message, error) {
  const parts = [];
  if (message && typeof message === 'object') {
    pushText(parts, message.errorMessage);
    pushText(parts, message.errorText);
    pushText(parts, message.error?.message);
    pushText(parts, message.error?.error?.message);
    pushText(parts, typeof message.error === 'string' ? message.error : '');
    pushText(parts, message.error?.type);
    pushText(parts, message.error?.code);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text') pushText(parts, block.text);
      }
    }
  }
  if (error && typeof error === 'object') {
    pushText(parts, error.message);
    pushText(parts, error.cause?.message);
    pushText(parts, error.error?.message);
    pushText(parts, typeof error.code === 'string' ? error.code : '');
  } else if (typeof error === 'string') {
    pushText(parts, error);
  }
  return [...new Set(parts)];
}

function errorStatus(message, error) {
  const candidates = [
    message?.error?.status,
    message?.error?.statusCode,
    message?.error?.code,
    message?.status,
    message?.statusCode,
    error?.status,
    error?.statusCode,
    error?.code,
    error?.cause?.status,
    error?.cause?.statusCode,
    error?.response?.status,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 400 && number <= 599) return number;
  }
  return null;
}

export function scrubSecrets(text, env = process.env) {
  let scrubbed = String(text ?? '');
  const secrets = [env?.COMMANDCODE_API_KEY, env?.OCR_LLM_TOKEN]
    .filter((value) => typeof value === 'string' && value !== '')
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join('[REDACTED]');
  return scrubbed;
}

function piRunError(message, error, env) {
  const parts = errorTextParts(message, error);
  const rawText = parts.join(': ') || 'không có thông điệp lỗi từ provider';
  const text = scrubSecrets(rawText, env);
  const status = errorStatus(message, error);
  const loginCodes = new Set([401, 403]);
  const loginError = loginCodes.has(status) || /authentication_error|unauthorized|invalid_api_key|forbidden/i.test(text);
  const rate = status === 429 || /rate_limit|too_many_requests/i.test(text);
  if (loginError) {
    return new EngineError(`Pi báo lỗi xác thực provider${status ? ` (${status})` : ''}: ${text}`, {
      code: 'NATIVE_AUTH',
      exitCode: 21,
    });
  }
  if (rate) {
    return new EngineError(`Pi báo lỗi giới hạn tốc độ provider${status ? ` (${status})` : ''}: ${text}`, {
      code: 'NATIVE_RATE',
      exitCode: 23,
    });
  }
  return new EngineError(`Pi báo lỗi provider${status ? ` (${status})` : ''}: ${text}`, {
    code: 'NATIVE_ERROR',
    exitCode: 20,
  });
}

function lastAssistantMessage(session, tracked) {
  if (tracked) return tracked;
  try {
    if (typeof session?.getLastAssistantMessage === 'function') {
      const message = session.getLastAssistantMessage();
      if (message && typeof message === 'object') return message;
    }
  } catch {
    // SDK cũ không có getter này; thử các nguồn khác bên dưới.
  }
  for (const messages of [session?.messages, session?.state?.messages, session?.agent?.state?.messages]) {
    if (!Array.isArray(messages)) continue;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return messages[index];
    }
  }
  return null;
}

function resourceLoaderFor(sdk, systemPrompt) {
  const runtime =
    typeof sdk.createExtensionRuntime === 'function'
      ? sdk.createExtensionRuntime()
      : { extensions: [], errors: [] };
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function pickPiModel(modelRuntime, record) {
  if (typeof modelRuntime.getModel === 'function' && record.provider) {
    const model = modelRuntime.getModel(record.provider, record.model);
    if (model) return model;
  }
  if (typeof modelRuntime.getModel === 'function' && !record.provider) {
    const model = modelRuntime.getModel(undefined, record.model);
    if (model) return model;
  }
  if (typeof modelRuntime.getAvailable === 'function') {
    const available = await modelRuntime.getAvailable();
    const match = available.find(
      (model) =>
        model.id === record.model &&
        (record.provider === '' || record.provider === undefined || model.provider === record.provider),
    );
    if (match) return match;
  }
  return null;
}

function modelLabel(model, fallback) {
  if (!model || typeof model !== 'object') return fallback;
  if (typeof model.provider === 'string' && typeof model.id === 'string') return `${model.provider}/${model.id}`;
  if (typeof model.id === 'string') return model.id;
  return fallback;
}

/**
 * Tạo driver Pi.
 *
 * @param {Object} options
 * @param {string} options.cwd repo review (worktree ở head)
 * @param {{provider: string, model: string, label: string}} options.model
 * @param {string} options.systemPrompt
 * @param {Object} options.tools map tên tool -> hàm
 * @param {Array} options.toolDefs
 * @param {(delta: {tokens_in: number, tokens_out: number}) => void} [options.onUsage]
 */
export async function createDriver(options) {
  const env = options.env ?? process.env;
  const sdk = await loadPiSdk({ env, sdkPath: options.sdkPath });
  if (typeof sdk.createAgentSession !== 'function' || typeof sdk.ModelRuntime !== 'function') {
    throw sdkError('Pi SDK thiếu createAgentSession/ModelRuntime');
  }

  const agentDir = options.agentDir ?? dystopiaAgentDir(env);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtimeOptions = {};
  const authPath = path.join(agentDir, 'auth.json');
  const modelsPath = path.join(agentDir, 'models.json');
  if (!existsSync(modelsPath)) {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    throw sdkError(
      `không tìm thấy ${modelsPath}: đặt DYSTOPIA_HOME (hoặc DYSTOPIA_AGENT_DIR) tới agent dir có models.json`,
    );
  }
  if (existsSync(authPath)) runtimeOptions.authPath = authPath;
  runtimeOptions.modelsPath = modelsPath;

  let session = null;
  let unsubscribe = null;
  try {
    const modelRuntime = await sdk.ModelRuntime.create(runtimeOptions);
    const model = await pickPiModel(modelRuntime, options.model);
    if (!model) {
      throw new EngineError(
        `Pi không có model ${options.model?.label ?? options.model?.model ?? '?'} trong models.json của Dystopia`,
        { code: 'NATIVE_MODEL_UNKNOWN', exitCode: 64 },
      );
    }

    const settingsManager =
      typeof sdk.SettingsManager?.inMemory === 'function'
        ? sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
        : undefined;
    const sessionManager =
      typeof sdk.SessionManager?.inMemory === 'function'
        ? sdk.SessionManager.inMemory(options.cwd)
        : undefined;

    const created = await sdk.createAgentSession({
      cwd: options.cwd,
      agentDir,
      model,
      thinkingLevel: 'off',
      modelRuntime,
      resourceLoader: resourceLoaderFor(sdk, options.systemPrompt),
      noTools: true,
      customTools: toPiTools(options.tools, options.toolDefs),
      sessionManager,
      settingsManager,
    });
    session = created.session;
  } catch (error) {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    throw error;
  }

  let usage = { tokens_in: 0, tokens_out: 0 };
  let lastMessage = null;
  unsubscribe = session.subscribe((event) => {
    if (event?.type !== 'message_end') return;
    const message = event.message ?? event.assistantMessage;
    if (message?.role && message.role !== 'assistant') return;
    lastMessage = message;
    const delta = usageDelta(message);
    usage = {
      tokens_in: usage.tokens_in + delta.tokens_in,
      tokens_out: usage.tokens_out + delta.tokens_out,
    };
    options.onUsage?.(delta);
  });

  const label = modelLabel(session.model, options.model?.label ?? null);
  let disposed = false;
  let aborted = false;
  return {
    model: label,
    async prompt(text) {
      lastMessage = null;
      let thrown = null;
      try {
        await session.prompt(text);
      } catch (error) {
        thrown = error;
      }
      const message = lastAssistantMessage(session, lastMessage);
      // abort() do chính engine gọi (chạm giới hạn token/tool call) làm Pi kết
      // thúc lượt ở trạng thái aborted/error. Đó là cắt lượt, không phải lỗi
      // provider, nên không được biến thành NATIVE_ERROR.
      if (aborted || message?.stopReason === 'aborted') {
        return typeof session.getLastAssistantText === 'function' ? session.getLastAssistantText() : '';
      }
      if (thrown || message?.stopReason === 'error') {
        throw piRunError(message, thrown, env);
      }
      return typeof session.getLastAssistantText === 'function' ? session.getLastAssistantText() : '';
    },
    async abort() {
      aborted = true;
      if (typeof session.abort === 'function') await session.abort();
    },
    usage() {
      return { ...usage };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        // bỏ qua
      }
      session.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}
