// Cấu hình model của Dystopia: đọc agent/models.json của chính Dystopia (do
// launcher trỏ DYSTOPIA_HOME/DYSTOPIA_AGENT_DIR) rồi chọn model cho engine native.
//
// Không chạy `mth models`, không đọc agent dir/.env/auth.json của MTH, và không
// bao giờ in giá trị apiKey. Chỉ dùng module có sẵn của Node.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError } from '../ocr.mjs';
import { modelsPath } from './config.mjs';

export { resolveMthHome } from './config.mjs';

export const DEFAULT_CODE_MODEL = 'deepseek-v4.1-flash-fast';
export const DEFAULT_MODEL_PRIORITY = Object.freeze(['deepseek/deepseek-v4.1-flash', 'Qwen/Qwen3.8-Omni-Flash']);

function mthError(message, code = 'DYSTOPIA_CONFIG') {
  return new EngineError(message, { code, exitCode: 64 });
}

// models.json của Pi: { providers: { <tên>: { models: [{ id, name, contextWindow }] } } }.
// Chỉ lấy id/tên/bối cảnh; mọi trường key (apiKey, baseUrl, ...) bị bỏ qua.
export function parseModelsConfig(text, { file = '' } = {}) {
  const where = file === '' ? '' : ` (${file})`;
  let document;
  try {
    document = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw mthError(`models.json không phải JSON hợp lệ${where}: ${error.message}`, 'DYSTOPIA_MODELS_FORMAT');
  }

  const providers = document?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw mthError(`models.json thiếu object "providers"${where}`, 'DYSTOPIA_MODELS_FORMAT');
  }

  const models = [];
  for (const [provider, config] of Object.entries(providers)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const list = Array.isArray(config.models) ? config.models : [];
    for (const entry of list) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (id === '') continue;
      models.push({
        provider,
        model: id,
        label: id.startsWith(`${provider}/`) ? id : `${provider}/${id}`,
        name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name : id,
        contextWindow: Number.isFinite(entry.contextWindow) ? entry.contextWindow : null,
      });
    }
  }

  if (models.length === 0) {
    throw mthError(`models.json không liệt kê model nào${where}`, 'DYSTOPIA_MODELS_EMPTY');
  }
  return models;
}

/**
 * Đọc agent/models.json của Dystopia và trả danh sách model.
 *
 * @param {{env?: NodeJS.ProcessEnv, file?: string}} [options]
 */
export function listModels(options = {}) {
  const env = options.env ?? process.env;
  const file = options.file ?? modelsPath(env);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw mthError(
      `không đọc được ${file}: đặt DYSTOPIA_HOME (hoặc DYSTOPIA_AGENT_DIR) tới agent dir có models.json`,
      'DYSTOPIA_MODELS_MISSING',
    );
  }
  return parseModelsConfig(text, { file });
}

// Tên trần: bỏ tiền tố provider/vendor ("deepseek/", "Qwen/", ...).
export function bareModelName(name) {
  const text = String(name ?? '').trim().toLowerCase();
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

function sameModel(a, b) {
  return bareModelName(a) === bareModelName(b);
}

function findModel(models, wanted) {
  const text = wanted.trim();
  const exact = models.find(
    (model) => model.label === text || model.model === text || `${model.provider}/${model.model}` === text,
  );
  if (exact) return exact;
  const bare = bareModelName(text);
  return models.find((model) => bareModelName(model.model) === bare) ?? null;
}

/**
 * Chọn model cho Dystopia.
 *
 * - `DYSTOPIA_MODEL` đặt → phải có trong models.json (khớp tên model, kèm provider/ nếu có).
 * - Không đặt → model đầu tiên trong danh sách ưu tiên có trong config và KHÁC model
 *   viết code; không có thì model đầu tiên khác model viết code.
 * - Không còn ứng viên → lỗi exit 64.
 */
export function resolveModel(models, options = {}) {
  const env = options.env ?? process.env;
  const codeModel = options.codeModel ?? (env.MTH_DEFAULT_MODEL?.trim() || DEFAULT_CODE_MODEL);
  const priority = options.priority ?? DEFAULT_MODEL_PRIORITY;
  const labels = models.map((model) => model.label).join(', ');

  const wanted = typeof env.DYSTOPIA_MODEL === 'string' ? env.DYSTOPIA_MODEL.trim() : '';
  if (wanted !== '') {
    const found = findModel(models, wanted);
    if (!found) {
      throw mthError(
        `DYSTOPIA_MODEL="${wanted}" không có trong models.json của Dystopia (${labels})`,
        'DYSTOPIA_MODEL_UNKNOWN',
      );
    }
    return found;
  }

  for (const candidate of priority) {
    const found = findModel(models, candidate);
    if (found && !sameModel(found.model, codeModel)) return found;
  }

  const other = models.find((model) => !sameModel(model.model, codeModel));
  if (other) return other;

  throw mthError(
    `không có model nào khác model viết code (${codeModel}) trong models.json của Dystopia (${labels})`,
    'DYSTOPIA_MODEL_UNKNOWN',
  );
}

function usage() {
  return [
    'Dùng: dystopia models',
    '',
    'Liệt kê model engine native dùng được (đọc từ $DYSTOPIA_HOME/agent/models.json).',
    'Đánh dấu "*" model Dystopia đang chọn và "[code]" model viết code của Dystopia.',
    '',
    'Biến môi trường: DYSTOPIA_HOME, DYSTOPIA_AGENT_DIR (agent dir), DYSTOPIA_MODEL (chọn model),',
    'MTH_DEFAULT_MODEL (model viết code, mặc định deepseek-v4.1-flash-fast).',
  ].join('\n');
}

export function formatModels(models, { chosen, codeModel }) {
  const lines = [`Dystopia: ${chosen.label}`, `Model viết code: ${codeModel}`, ''];
  for (const model of models) {
    const marks = [];
    if (model === chosen) marks.push('dystopia');
    if (sameModel(model.model, codeModel)) marks.push('code');
    const mark = model === chosen ? '*' : ' ';
    const suffix = marks.length > 0 ? `  [${marks.join(', ')}]` : '';
    lines.push(`${mark} ${model.label}${suffix}`);
  }
  if (!models.some((model) => sameModel(model.model, codeModel))) {
    lines.push('', `(model viết code ${codeModel} không có trong danh sách)`);
  }
  return lines.join('\n');
}

export function main(argv, options = {}) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }
  if (command !== 'models' || rest.length > 0) {
    console.error(`dystopia models: tham số lạ${rest.length > 0 ? `: ${rest.join(' ')}` : ''}\n\n${usage()}`);
    return 64;
  }
  try {
    const env = options.env ?? process.env;
    const models = listModels({ env });
    const codeModel = env.MTH_DEFAULT_MODEL?.trim() || DEFAULT_CODE_MODEL;
    const chosen = resolveModel(models, { env, codeModel });
    console.log(formatModels(models, { chosen, codeModel }));
    return 0;
  } catch (error) {
    if (error instanceof EngineError) {
      console.error(`dystopia: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
