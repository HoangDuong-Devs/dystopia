// Cấu hình MTH (coder): tìm thư mục cài qua CODER_HOME, đọc bảng model và chọn
// model cho engine native.
//
// Không hardcode đường dẫn, không đọc auth.json/.env của MTH: chỉ chạy
// `$CODER_HOME/coder models` (Pi tự đọc auth qua agent dir của MTH). Chỉ dùng
// module có sẵn của Node.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError } from '../ocr.mjs';

export const DEFAULT_CODE_MODEL = 'deepseek-v4.1-flash-fast';
export const DEFAULT_MODEL_PRIORITY = Object.freeze(['deepseek/deepseek-v4.1-flash', 'Qwen/Qwen3.8-Omni-Flash']);

function coderError(message, code = 'CODER_CONFIG') {
  return new EngineError(message, { code, exitCode: 64 });
}

// CODER_HOME bắt buộc: không có giá trị mặc định nào để tránh trỏ nhầm máy khác.
export function resolveCoderHome(env = process.env) {
  const home = typeof env.CODER_HOME === 'string' ? env.CODER_HOME.trim() : '';
  if (home === '') {
    throw coderError('chưa đặt CODER_HOME: đặt CODER_HOME tới thư mục cài MTH', 'CODER_HOME_MISSING');
  }
  return path.resolve(home);
}

export function coderBinary(env = process.env) {
  const home = resolveCoderHome(env);
  const binary = path.join(home, 'coder');
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    throw coderError(
      `không tìm thấy "$CODER_HOME/coder" trong ${home}: đặt CODER_HOME tới thư mục cài MTH`,
      'CODER_HOME_INVALID',
    );
  }
  return binary;
}

// Bảng của `coder models` có dòng đầu là header:
// provider  model  context  max-out  thinking  images
// Tách theo vị trí cột của header để chịu được khoảng trắng thay đổi.
export function parseModelsTable(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /\bprovider\b/i.test(line) && /\bmodel\b/i.test(line));
  if (headerIndex === -1) {
    throw coderError('output `coder models` không có dòng header provider/model', 'CODER_MODELS_FORMAT');
  }

  const header = lines[headerIndex];
  const columns = [...header.matchAll(/\S+/g)].map((match) => ({
    title: match[0].toLowerCase(),
    start: match.index,
  }));
  const providerColumn = columns.findIndex((column) => column.title === 'provider');
  const modelColumn = columns.findIndex((column) => column.title === 'model');
  if (providerColumn === -1 || modelColumn === -1) {
    throw coderError('header `coder models` thiếu cột provider hoặc model', 'CODER_MODELS_FORMAT');
  }

  const models = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '' || /^[-\s|+]+$/.test(line)) continue;
    const cells = columns.map((column, index) => {
      const end = index + 1 < columns.length ? columns[index + 1].start : undefined;
      return line.slice(column.start, end).trim().replace(/^[|│]+|[|│]+$/g, '').trim();
    });
    // Dòng ngắn hơn header (bảng bị cắt) vẫn thử tách theo khoảng trắng.
    const fallback = line
      .trim()
      .replace(/^[|│]+|[|│]+$/g, '')
      .split(/\s{2,}|\s+/)
      .filter((cell) => cell !== '');
    const provider = cells[providerColumn] || fallback[providerColumn] || '';
    const model = cells[modelColumn] || fallback[modelColumn] || '';
    if (model === '') continue;
    const record = {
      provider,
      model,
      label: provider !== '' && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model,
    };
    for (const column of columns) {
      if (!Object.hasOwn(record, column.title)) record[column.title] = cells[columns.indexOf(column)] ?? '';
    }
    models.push(record);
  }

  if (models.length === 0) {
    throw coderError('`coder models` không liệt kê model nào', 'CODER_MODELS_EMPTY');
  }
  return models;
}

/**
 * Chạy `$CODER_HOME/coder models` và parse bảng.
 *
 * @param {{env?: NodeJS.ProcessEnv, binary?: string, spawn?: Function}} [options]
 */
export function listModels(options = {}) {
  const env = options.env ?? process.env;
  const binary = options.binary ?? coderBinary(env);
  const run = options.spawn ?? spawnSync;
  const result = run(binary, ['models'], {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result?.error) {
    throw coderError(`không chạy được "${binary} models": ${result.error.message}`, 'CODER_MODELS_FAILED');
  }
  if (typeof result?.status === 'number' && result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw coderError(
      `"${binary} models" thoát với mã ${result.status}${stderr ? `: ${stderr}` : ''}`,
      'CODER_MODELS_FAILED',
    );
  }
  return parseModelsTable(result?.stdout ?? '');
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
 * - `DYSTOPIA_MODEL` đặt → phải có trong bảng (khớp tên model, kèm provider/ nếu có).
 * - Không đặt → model đầu tiên trong danh sách ưu tiên có trong bảng và KHÁC model
 *   viết code; không có thì model đầu tiên khác model viết code.
 * - Không còn ứng viên → lỗi exit 64.
 */
export function resolveModel(models, options = {}) {
  const env = options.env ?? process.env;
  const codeModel = options.codeModel ?? (env.CODER_DEFAULT_MODEL?.trim() || DEFAULT_CODE_MODEL);
  const priority = options.priority ?? DEFAULT_MODEL_PRIORITY;
  const labels = models.map((model) => model.label).join(', ');

  const wanted = typeof env.DYSTOPIA_MODEL === 'string' ? env.DYSTOPIA_MODEL.trim() : '';
  if (wanted !== '') {
    const found = findModel(models, wanted);
    if (!found) {
      throw coderError(
        `DYSTOPIA_MODEL="${wanted}" không có trong danh sách của MTH (${labels})`,
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

  throw coderError(
    `không có model nào khác model viết code (${codeModel}) trong danh sách của MTH (${labels})`,
    'DYSTOPIA_MODEL_UNKNOWN',
  );
}

function usage() {
  return [
    'Dùng: dystopia models',
    '',
    'Liệt kê model engine native dùng được (đọc từ `$CODER_HOME/coder models`).',
    'Đánh dấu "*" model Dystopia đang chọn và "[code]" model viết code của MTH.',
    '',
    'Biến môi trường: CODER_HOME (bắt buộc), DYSTOPIA_MODEL (chọn model),',
    'CODER_DEFAULT_MODEL (model viết code, mặc định deepseek-v4.1-flash-fast).',
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
    const codeModel = env.CODER_DEFAULT_MODEL?.trim() || DEFAULT_CODE_MODEL;
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
