// Giới hạn tài nguyên của engine native: số tool call mỗi file, tổng token,
// tỉ lệ chia ngân sách theo pha và số lượt agent chạy song song.
// Chỉ dùng module có sẵn của Node.

import { EngineError } from '../ocr.mjs';

export const DEFAULTS = Object.freeze({
  maxToolCalls: 40,
  maxTokens: 400_000,
  phaseSplit: 0.7,
  concurrency: 2,
});

// Trần cắt output của tool và tỉ lệ ngân sách mỗi file để dành cho report_finding.
// Đọc/grep/git_show quá trần sẽ bị cắt kèm ghi chú để agent gọi lại đúng dải.
export const LIMITS = Object.freeze({
  reportReserveRatio: 0.2,
  readLines: 150,
  readChars: 12_000,
  grepLines: 60,
  grepChars: 8_000,
  showLines: 200,
  showChars: 12_000,
  diffContext: 40,
  unchangedLines: 150,
});

// Ngưỡng mềm: chạm mức này thì ngừng cho đọc thêm và dành một lượt cuối để report.
export function reportReserve(perFileBudget) {
  const reserve = Math.floor(Math.max(0, perFileBudget) * LIMITS.reportReserveRatio);
  return { reserve, softTokens: Math.max(1, perFileBudget - reserve) };
}

function invalid(message) {
  return new EngineError(message, { code: 'NATIVE_BAD_LIMIT', exitCode: 64 });
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) {
    throw invalid(`${name} phải là số nguyên ≥ 1, nhận ${JSON.stringify(value)}`);
  }
  return number;
}

/**
 * Chuẩn hóa `limits` của hợp đồng. Chấp nhận cả tên camelCase dùng trong code
 * và tên cờ CLI (snake_case) để bench/CLI cùng truyền được.
 */
export function parseLimits(raw = {}) {
  const limits = raw && typeof raw === 'object' ? raw : {};
  const maxToolCalls = positiveInteger(
    limits.maxToolCalls ?? limits.max_tool_calls,
    '--max-tool-calls',
    DEFAULTS.maxToolCalls,
  );
  const maxTokens = positiveInteger(limits.maxTokens ?? limits.max_tokens, '--max-tokens', DEFAULTS.maxTokens);
  const concurrency = positiveInteger(limits.concurrency, '--concurrency', DEFAULTS.concurrency);

  let phaseSplit = limits.phaseSplit ?? limits.phase_split ?? DEFAULTS.phaseSplit;
  if (typeof phaseSplit === 'string' && phaseSplit.trim() !== '') phaseSplit = Number(phaseSplit);
  if (typeof phaseSplit !== 'number' || !Number.isFinite(phaseSplit) || phaseSplit <= 0 || phaseSplit >= 1) {
    throw invalid(`--phase-split phải là số trong khoảng (0, 1), nhận ${JSON.stringify(limits.phaseSplit ?? limits.phase_split)}`);
  }

  return {
    maxToolCalls,
    maxTokens,
    phaseSplit,
    concurrency,
  };
}

/**
 * Chia ngân sách token: pha file lấy `phaseSplit`, phần còn lại để dành cho pha
 * tổng (commit C). Ngân sách pha file chia đều cho các file, mỗi file ít nhất 1.
 */
export function splitBudget(maxTokens, fileCount, phaseSplit = DEFAULTS.phaseSplit) {
  const fileBudget = Math.floor(maxTokens * phaseSplit);
  const summaryBudget = maxTokens - fileBudget;
  if (fileCount <= 0) return { fileBudget, summaryBudget, perFile: 0 };
  return { fileBudget, summaryBudget, perFile: Math.max(1, Math.floor(fileBudget / fileCount)) };
}
