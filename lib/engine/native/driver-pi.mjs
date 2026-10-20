// Driver Pi cho engine native: bọc Pi SDK (cùng cách MTH dùng) thành giao diện
// nhỏ createDriver() -> { prompt, abort, usage, dispose }.
//
// Không tool có sẵn: noTools + customTools đúng 5 tool của native. Model chọn
// qua coder.mjs; Pi đọc auth/models qua agent dir của MTH
// (PI_CODING_AGENT_DIR = $CODER_HOME/agent). Chỉ dùng module có sẵn của Node.

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError } from '../ocr.mjs';
import { resolveCoderHome } from './coder.mjs';

function sdkError(message) {
  return new EngineError(message, { code: 'NATIVE_PI_SDK', exitCode: 64 });
}

export function piSdkPath(env = process.env, coderHome = resolveCoderHome(env)) {
  const override = typeof env.DYSTOPIA_PI_SDK === 'string' ? env.DYSTOPIA_PI_SDK.trim() : '';
  if (override !== '') {
    const resolved = path.resolve(override);
    return existsSync(resolved) && resolved.endsWith('.js') ? resolved : path.join(resolved, 'dist', 'index.js');
  }
  return path.resolve(coderHome, '..', 'pi', 'packages', 'coding-agent', 'dist', 'index.js');
}

export async function loadPiSdk(options = {}) {
  const env = options.env ?? process.env;
  const file = options.sdkPath ?? piSdkPath(env, options.coderHome);
  if (!existsSync(file)) {
    throw sdkError(
      `không tìm thấy Pi SDK tại ${file}: đặt DYSTOPIA_PI_SDK tới dist/index.js của @earendil-works/pi-coding-agent`,
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
  const coderHome = options.coderHome ?? resolveCoderHome(env);
  const sdk = await loadPiSdk({ env, coderHome, sdkPath: options.sdkPath });
  if (typeof sdk.createAgentSession !== 'function' || typeof sdk.ModelRuntime !== 'function') {
    throw sdkError('Pi SDK thiếu createAgentSession/ModelRuntime');
  }

  const agentDir = path.join(coderHome, 'agent');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtimeOptions = {};
  const authPath = path.join(agentDir, 'auth.json');
  const modelsPath = path.join(agentDir, 'models.json');
  if (existsSync(authPath)) runtimeOptions.authPath = authPath;
  if (existsSync(modelsPath)) runtimeOptions.modelsPath = modelsPath;

  let session = null;
  let unsubscribe = null;
  try {
    const modelRuntime = await sdk.ModelRuntime.create(runtimeOptions);
    const model = await pickPiModel(modelRuntime, options.model);
    if (!model) {
      throw new EngineError(
        `Pi không có model ${options.model?.label ?? options.model?.model ?? '?'} trong cấu hình MTH`,
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
  unsubscribe = session.subscribe((event) => {
    if (event?.type !== 'message_end') return;
    const message = event.message;
    if (message?.role && message.role !== 'assistant') return;
    const delta = usageDelta(message);
    usage = {
      tokens_in: usage.tokens_in + delta.tokens_in,
      tokens_out: usage.tokens_out + delta.tokens_out,
    };
    options.onUsage?.(delta);
  });

  const label = modelLabel(session.model, options.model?.label ?? null);
  let disposed = false;
  return {
    model: label,
    async prompt(text) {
      await session.prompt(text);
      return typeof session.getLastAssistantText === 'function' ? session.getLastAssistantText() : '';
    },
    async abort() {
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
