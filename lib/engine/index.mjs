// Hợp đồng engine review của Dystopia (v0.3).
//
// Mọi engine (ocr, native, engine giả trong test) cùng một chữ ký:
//   review({ repo, base, head, rules, limits }) -> Promise<{ findings, meta }>
// normalize, sắp xếp, --text và bench chỉ biết output của hợp đồng này, không
// biết engine nào ở bên dưới. Chỉ dùng module có sẵn của Node.

import * as ocr from './ocr.mjs';

const { EngineError } = ocr;

/**
 * @typedef {Object} Finding
 * @property {'chặn'|'nên sửa'|'gợi ý'} severity
 * @property {string|null} file đường dẫn tương đối trong repo
 * @property {number|null} line số dòng phía HEAD, một-based; null khi không có
 * @property {number|null} end_line
 * @property {string|null} rule
 * @property {string} claim câu mô tả ngắn
 * @property {string|null} evidence đoạn code/dẫn chứng
 * @property {number|null} confidence 0–1, null khi engine không báo
 */

/**
 * @typedef {Object} ReviewMeta
 * @property {string} tool luôn là "dystopia"
 * @property {string|null} version lấy từ VERSION (ghi đè bằng DYSTOPIA_VERSION)
 * @property {string} engine tên engine đã chạy
 * @property {string|null} base
 * @property {string|null} head
 * @property {string|null} model
 * @property {number|null} tokens_in
 * @property {number|null} tokens_out
 * @property {number|null} duration_ms
 */

/**
 * Tham số chung của hợp đồng. Engine được phép nhận thêm trường riêng
 * (ví dụ adapter ocr nhận `args` để chuyển tiếp cờ của OCR) nhưng KHÔNG được
 * đổi nghĩa các trường dưới đây.
 *
 * @typedef {Object} ReviewOptions
 * @property {string} repo thư mục repo cần review (cwd khi chạy engine)
 * @property {string|null} [base] revision đáy (không có → review thay đổi chưa commit)
 * @property {string|null} [head] revision đỉnh
 * @property {string[]} [rules] danh sách file rule; rỗng thì engine tự quyết
 * @property {Object} [limits] giới hạn tài nguyên của engine
 */

/**
 * @typedef {Object} ReviewResult
 * @property {Finding[]} findings đã sắp xếp sẵn, dòng theo phía head
 * @property {ReviewMeta} meta
 */

/**
 * @typedef {Object} Engine
 * @property {(options: ReviewOptions) => Promise<ReviewResult>} review
 */

export const SEVERITIES = Object.freeze(['chặn', 'nên sửa', 'gợi ý']);

// Key phán quyết không bao giờ được có trong output: Dystopia chỉ đưa ra finding.
const FORBIDDEN_KEYS = new Set(['verdict', 'approve', 'approved', 'reject', 'duyệt', 'trả lại']);

// Engine đã có tên trong giao diện CLI nhưng chưa làm xong: báo rõ thay vì
// "engine lạ", để người dùng biết đây là việc đang làm dở.
const NOT_READY = new Map([['native', 'engine native chưa có (v0.3 commit B)']]);

const registry = new Map();

export function registerEngine(name, adapter) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new EngineError('tên engine phải là chuỗi khác rỗng', { code: 'ENGINE_UNKNOWN', exitCode: 64 });
  }
  if (!adapter || typeof adapter.review !== 'function') {
    throw new EngineError(`engine "${name}" thiếu hàm review()`, { code: 'ENGINE_BAD_ADAPTER', exitCode: 64 });
  }
  registry.set(name.trim(), adapter);
  return adapter;
}

export function listEngines() {
  return [...registry.keys()].sort();
}

// Tên lạ → ENGINE_UNKNOWN, tên đã hứa nhưng chưa có → ENGINE_UNAVAILABLE.
// Cả hai exit 64 để CLI dùng chung một đường báo lỗi tham số.
export function getEngine(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (key === '') {
    throw new EngineError('thiếu tên engine', { code: 'ENGINE_UNKNOWN', exitCode: 64 });
  }
  const engine = registry.get(key);
  if (engine) return engine;
  if (NOT_READY.has(key)) {
    throw new EngineError(NOT_READY.get(key), { code: 'ENGINE_UNAVAILABLE', exitCode: 64 });
  }
  const available = listEngines().join(', ');
  throw new EngineError(`engine lạ: "${key}" (engine có: ${available})`, {
    code: 'ENGINE_UNKNOWN',
    exitCode: 64,
  });
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function isLine(value) {
  return value === null || (Number.isInteger(value) && value >= 1);
}

function checkFinding(finding, index, errors) {
  const where = `findings[${index}]`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    errors.push(`${where} phải là object`);
    return;
  }
  for (const key of ['severity', 'file', 'line', 'end_line', 'rule', 'claim', 'evidence', 'confidence']) {
    if (!Object.hasOwn(finding, key)) errors.push(`${where} thiếu trường "${key}"`);
  }
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`${where}.severity phải là một trong ${SEVERITIES.join('/')}, nhận ${JSON.stringify(finding.severity)}`);
  }
  const fileOk = finding.file === null || (typeof finding.file === 'string' && finding.file !== '');
  if (!fileOk) errors.push(`${where}.file phải là chuỗi khác rỗng hoặc null`);
  for (const key of ['line', 'end_line']) {
    if (!isLine(finding[key])) errors.push(`${where}.${key} phải là số nguyên ≥ 1 hoặc null`);
  }
  if (Number.isInteger(finding.line) && Number.isInteger(finding.end_line) && finding.end_line < finding.line) {
    errors.push(`${where}: end_line (${finding.end_line}) nhỏ hơn line (${finding.line})`);
  }
  if (typeof finding.claim !== 'string') errors.push(`${where}.claim phải là chuỗi`);
  if (!(finding.rule === null || typeof finding.rule === 'string')) {
    errors.push(`${where}.rule phải là chuỗi hoặc null`);
  }
  if (!(finding.evidence === null || typeof finding.evidence === 'string')) {
    errors.push(`${where}.evidence phải là chuỗi hoặc null`);
  }
  const confidenceOk = finding.confidence === null || Number.isFinite(finding.confidence);
  if (!confidenceOk) errors.push(`${where}.confidence phải là số hữu hạn hoặc null`);
}

// Kiểm output engine đúng schema v0.2. Trả mảng lỗi (rỗng = hợp lệ) để test
// hợp đồng đọc được từng lỗi, không ném ngay lỗi đầu tiên.
export function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return ['kết quả engine phải là object { findings, meta }'];
  }
  if (!Array.isArray(result.findings)) errors.push('findings phải là mảng');
  if (!result.meta || typeof result.meta !== 'object' || Array.isArray(result.meta)) {
    errors.push('meta phải là object');
  }
  if (Array.isArray(result.findings)) {
    result.findings.forEach((finding, index) => checkFinding(finding, index, errors));
  }
  for (const key of collectKeys(result)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) errors.push(`output chứa key phán quyết: "${key}"`);
  }
  return errors;
}

export function assertValidResult(result) {
  const errors = validateResult(result);
  if (errors.length > 0) {
    throw new EngineError(`output engine không đúng schema v0.2: ${errors.join('; ')}`, {
      code: 'ENGINE_BAD_RESULT',
      exitCode: 1,
    });
  }
  return result;
}

export { EngineError, readVersion } from './ocr.mjs';

registerEngine(ocr.NAME, { name: ocr.NAME, review: ocr.review });
