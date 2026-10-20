// Giới hạn tài nguyên của engine native. Mặc định bám template review của
// Alibaba OpenCodeReview (OCR) @9867a3d; mỗi hằng ghi kèm vị trí nguồn OCR.
// Chỉ dùng module có sẵn của Node.

import { EngineError } from '../ocr.mjs';

export const DEFAULTS = Object.freeze({
  // OCR internal/config/template/task_template.json:38 (MAX_TOOL_REQUEST_TIMES)
  // và internal/llmloop/loop.go:388: 100 lượt tool mỗi file.
  maxToolCalls: 100,
  // OCR cmd/opencodereview/shared_flags.go:238 và :60: 0 = không giới hạn.
  maxTokens: 0,
  // OCR cmd/opencodereview/shared_flags.go:233: 8 file chạy song song.
  concurrency: 8,
});

// Số review round hiện tại. OCR internal/config/template/task_template.json:43
// đặt MAX_REVIEW_ROUNDS = 2; C2b sẽ nâng lên 2 cùng context ceiling/compression.
export const REVIEW_ROUNDS = 1;

// Giới hạn vòng lặp/thời gian. OCR internal/llmloop/loop.go:389 đặt
// maxConsecutiveEmptyRounds = 3; shared_flags.go:234 + :52 và agent.go:677 đặt
// timeout 15 phút/file (× số review round); shared_flags.go:52 đặt
// OCR_LLM_TIMEOUT mặc định 300 giây cho mỗi request LLM.
export const LOOP_LIMITS = Object.freeze({
  maxConsecutiveEmptyRounds: 3,
  fileTimeoutMs: 15 * 60 * 1000 * REVIEW_ROUNDS,
  requestTimeoutMs: 300 * 1000,
});

// Retry 429/rate error bằng wrapper riêng của Dystopia (không có hằng tương ứng
// trong OCR): tối đa 3 lần, backoff 1s rồi nhân đôi.
export const RETRY = Object.freeze({
  maxRateRetries: 3,
  rateRetryBaseMs: 1000,
});

// Trần output của tool. OCR internal/tool/file_read.go:12 đặt
// fileReadMaxLines = 500; internal/tool/code_search.go:18 đặt
// gitGrepMaxCount = 100.
export const LIMITS = Object.freeze({
  readLines: 500,
  grepLines: 100,
  // Trần ký tự chỉ có ở Dystopia (OCR không có): đủ rộng để không cắt oan.
  readChars: 60_000,
  grepChars: 60_000,
  // git_show giữ trần hiện tại; OCR không có tool tương đương.
  showLines: 200,
  showChars: 12_000,
});

// OCR internal/config/template/task_template.json:45 (MAX_COMPLETION_TOKENS).
export const MODEL_MAX_TOKENS = 16_384;

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

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0) {
    throw invalid(`${name} phải là số nguyên ≥ 0, nhận ${JSON.stringify(value)}`);
  }
  return number;
}

/**
 * Chuẩn hóa `limits` của hợp đồng. Chấp nhận cả tên camelCase dùng trong code
 * và tên cờ CLI (snake_case) để bench/CLI cùng truyền được.
 *
 * `--phase-split` vẫn được CLI chấp nhận nhưng bị bỏ qua (deprecated): OCR
 * không có khái niệm chia ngân sách theo pha.
 */
export function parseLimits(raw = {}) {
  const limits = raw && typeof raw === 'object' ? raw : {};
  return {
    maxToolCalls: positiveInteger(
      limits.maxToolCalls ?? limits.max_tool_calls,
      '--max-tool-calls',
      DEFAULTS.maxToolCalls,
    ),
    maxTokens: nonNegativeInteger(limits.maxTokens ?? limits.max_tokens, '--max-tokens', DEFAULTS.maxTokens),
    concurrency: positiveInteger(limits.concurrency, '--concurrency', DEFAULTS.concurrency),
    // Các giới hạn dưới đây chỉ dùng nội bộ/test, không phải cờ CLI.
    fileTimeoutMs: positiveInteger(limits.fileTimeoutMs, 'fileTimeoutMs', LOOP_LIMITS.fileTimeoutMs),
    requestTimeoutMs: positiveInteger(limits.requestTimeoutMs, 'requestTimeoutMs', LOOP_LIMITS.requestTimeoutMs),
    maxRateRetries: nonNegativeInteger(limits.maxRateRetries, 'maxRateRetries', RETRY.maxRateRetries),
    rateRetryBaseMs: nonNegativeInteger(limits.rateRetryBaseMs, 'rateRetryBaseMs', RETRY.rateRetryBaseMs),
  };
}
