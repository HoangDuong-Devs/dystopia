// Vòng lặp pha file của engine native: mỗi file thay đổi một session agent,
// chạy song song có giới hạn. Mặc định bám template review của Alibaba
// OpenCodeReview (OCR) @9867a3d: 100 lượt tool/file, ngân sách token tổng 0 =
// không giới hạn, concurrency 8, timeout 15 phút/file và 300 giây/request.
// Chạm trần tool hoặc ngân sách thì chạy đúng MỘT grace round chỉ cho
// report_finding. Lỗi provider của một file được retry một lần với session mới;
// 429 được retry có backoff trước khi thành lỗi NATIVE_RATE. Findings ghi vào
// output sau mỗi file (meta.partial=true).
//
// Lớp "driver" (createDriver/prompt/usage/abort) được tách khỏi vòng lặp để test
// dùng driver giả, không gọi LLM thật. Chỉ dùng module có sẵn của Node.

import { readFile, rename, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { EngineError, readVersion } from '../ocr.mjs';
import { scrubSecrets } from './driver-pi.mjs';
import { REPORT_SPEC, rejectionReason, sortFindings } from './finding.mjs';
import { LOOP_LIMITS } from './limits.mjs';

const PROMPT_URL = new URL('./prompts/file-review.md', import.meta.url);
const REJECTED_REASONS_LIMIT = 20;
const FINAL_TEXT_LIMIT = 500;

// Lượt nhắc cuối (grace round): OCR internal/llmloop/loop.go:560-566
// runGraceRound cũng gửi một prompt riêng yêu cầu báo cáo rồi dừng.
const FINAL_PROMPT = [
  'Đã hết lượt tool hoặc ngân sách token của lần review.',
  'Dừng đọc thêm. Hãy gọi report_finding cho MỌI lỗi bạn đã tìm thấy trong file này, rồi kết thúc lượt.',
  'Không gọi read_file/grep/git_show/list_changed_files nữa.',
].join('\n');

export const GRACE_PROMPT = FINAL_PROMPT;

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'NATIVE_TIMEOUT';
  }
}

export async function loadSystemPrompt(options = {}) {
  if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim() !== '') return options.systemPrompt;
  if (typeof options.promptPath === 'string') return readFile(options.promptPath, 'utf8');
  return readFile(PROMPT_URL, 'utf8');
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageDelta(delta = {}) {
  return {
    tokens_in: safeNumber(delta.tokens_in ?? delta.input),
    tokens_out: safeNumber(delta.tokens_out ?? delta.output),
  };
}

// Bọc tool để đếm lượt và chặn theo trần tool/ngân sách. report_finding luôn
// chạy vì finding đã có phải giữ. Trong grace round chỉ report_finding được
// chạy; tool khác trả lỗi bảo model báo ngay (OCR loop.go:560-566).
export function wrapTools(baseTools, options) {
  const maxToolCalls = options.maxToolCalls;
  const reportTool = options.reportToolName ?? 'report_finding';
  const budgetExceeded = options.budgetExceeded ?? (() => false);
  const grace = options.grace ?? { active: false };
  const markTruncated = options.markTruncated ?? (() => {});
  const usage = options.usage;
  const wrapped = {};

  const capReason = () => (budgetExceeded() ? 'budget' : 'max-tool-calls');

  for (const [name, fn] of Object.entries(baseTools)) {
    if (typeof fn !== 'function') continue;
    const isReport = name === reportTool;
    wrapped[name] = async (...args) => {
      if (!isReport) {
        if (grace.active) {
          const reason = budgetExceeded() ? 'budget' : 'max-tool-calls';
          markTruncated(reason);
          return 'lỗi: chỉ được gọi report_finding trong lượt cuối, hãy report_finding ngay';
        }
        if (budgetExceeded() || usage.tool_calls >= maxToolCalls) {
          markTruncated(capReason());
          const detail = budgetExceeded()
            ? 'đã vượt ngân sách token của lần review'
            : `đã chạm giới hạn ${maxToolCalls} tool call của file`;
          return `lỗi: ${detail}, hãy report_finding ngay`;
        }
      }
      usage.tool_calls += 1;
      return fn(...args);
    };
  }
  return wrapped;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

function filePrompt(entry, diff) {
  const added = entry.additions === null ? '-' : `+${entry.additions}`;
  const deleted = entry.deletions === null ? '-' : `-${entry.deletions}`;
  return [
    `File: ${entry.file} (${entry.status}, ${added}/${deleted})`,
    'Diff base..head của riêng file này:',
    '```diff',
    diff.trim() === '' ? '(không có diff)' : diff.trim(),
    '```',
    'Dùng report_finding(file, line, end_line, severity, rule, claim, evidence, confidence) để báo.',
    'line/end_line tính theo phía head. Nếu report_finding trả lỗi, sửa tham số rồi gọi lại.',
  ].join('\n');
}

function perFileRow(item) {
  return {
    file: item.file,
    tokens_in: item.usage.tokens_in,
    tokens_out: item.usage.tokens_out,
    tool_calls: item.usage.tool_calls,
    rounds: item.rounds,
    retries: item.retries,
    truncated: item.truncated,
    reason: item.reason,
    rejected_reports: item.rejectedReports,
    final_text: item.finalText,
  };
}

function metaErrors(results) {
  return results.filter((item) => item.error).map((item) => ({ file: item.file, error: item.error }));
}

function sumUsage(results) {
  return results.reduce(
    (total, item) => ({
      tokens_in: total.tokens_in + item.usage.tokens_in,
      tokens_out: total.tokens_out + item.usage.tokens_out,
      tool_calls: total.tool_calls + item.usage.tool_calls,
      retries: total.retries + item.retries,
    }),
    { tokens_in: 0, tokens_out: 0, tool_calls: 0, retries: 0 },
  );
}

function isRateError(error) {
  if (error?.code === 'NATIVE_RATE') return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status ?? error?.cause?.statusCode);
  return status === 429 || /rate_limit|too_many_requests/i.test(String(error?.message ?? ''));
}

function isFatalError(error) {
  return error?.code === 'NATIVE_AUTH' || error?.code === 'NATIVE_RATE';
}

// Promise.race có timeout; khi hết giờ gọi abort để dừng request provider.
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // abort lỗi không đổi bản chất timeout
      }
      reject(new TimeoutError(`hết thời gian sau ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let tempCounter = 0;

// Ghi nguyên tử: file tạm cùng thư mục rồi rename, để crash không để lại JSON dở.
async function writeJsonAtomic(file, value) {
  tempCounter += 1;
  const temp = nodePath.join(
    nodePath.dirname(file),
    `.${nodePath.basename(file)}.${process.pid}.${tempCounter}.tmp`,
  );
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

/**
 * Chạy pha file.
 *
 * @param {Object} options
 * @param {string} options.repo
 * @param {string} options.base
 * @param {string} options.head
 * @param {Array<{file: string}>} options.files
 * @param {Object} options.limits kết quả parseLimits()
 * @param {Function} options.driverFactory
 * @param {Object} options.tools base tools + report_finding
 * @param {Object} options.collector createFindingCollector()
 * @param {(entry: Object) => Promise<string>} options.diffFor
 * @param {(item: Object) => Promise<void>} [options.onFileComplete]
 */
export async function runFilePhase(options) {
  const { files, limits, driverFactory, tools, collector } = options;
  const systemPrompt = options.systemPrompt;
  const started = process.hrtime.bigint();
  const toolDefs = [...(options.toolSpecs ?? []), REPORT_SPEC];
  const allowed = new Set(toolDefs.map((spec) => spec.name));
  const agentTools = Object.fromEntries(
    Object.entries(tools).filter(([name, fn]) => allowed.has(name) && typeof fn === 'function'),
  );
  const env = options.env ?? process.env;
  const fileTimeoutMs = limits.fileTimeoutMs ?? LOOP_LIMITS.fileTimeoutMs;
  const requestTimeoutMs = limits.requestTimeoutMs ?? LOOP_LIMITS.requestTimeoutMs;
  const maxRateRetries = limits.maxRateRetries ?? 0;
  const rateRetryBaseMs = limits.rateRetryBaseMs ?? 0;
  // Ngân sách token là tổng cho cả lần review; 0 = không giới hạn. OCR
  // cmd/opencodereview/shared_flags.go:238, :60.
  const reviewUsage = { tokens_in: 0, tokens_out: 0 };
  const overBudget = () =>
    limits.maxTokens > 0 && reviewUsage.tokens_in + reviewUsage.tokens_out >= limits.maxTokens;
  let reportedModel = null;

  const results = await pool(files, limits.concurrency, async (entry) => {
    const usage = { tokens_in: 0, tokens_out: 0, tool_calls: 0 };
    const state = {
      truncated: false,
      reason: null,
      rejectedCount: 0,
      rejectionReasons: [],
      finalText: null,
      rounds: 0,
      reportedRounds: 0,
      retries: 0,
      timedOut: false,
    };
    const grace = { active: false };
    const deadline = Date.now() + fileTimeoutMs;

    const markTruncated = (reason) => {
      if (state.truncated) return;
      state.truncated = true;
      state.reason = reason;
    };
    const recordUsage = (tokensIn, tokensOut) => {
      usage.tokens_in += tokensIn;
      usage.tokens_out += tokensOut;
      reviewUsage.tokens_in += tokensIn;
      reviewUsage.tokens_out += tokensOut;
    };
    const noteRejection = (result) => {
      const reason = rejectionReason(result);
      if (reason === null) return;
      state.rejectedCount += 1;
      if (state.rejectionReasons.length < REJECTED_REASONS_LIMIT) {
        state.rejectionReasons.push(scrubSecrets(reason, env));
      }
    };
    const noteText = (value) => {
      if (typeof value !== 'string' || value.trim() === '') return;
      state.finalText = value;
    };

    let lastError = null;
    if (overBudget()) {
      // Không khởi động file mới sau khi ngân sách tổng đã cạn.
      markTruncated('budget');
      lastError = 'skipped-budget';
    } else {
      let attempt = 0;
      while (attempt < 2) {
        attempt += 1;
        let session = null;
        let sawUsage = false;
        let failure = null;

        const onUsage = (delta = {}) => {
          sawUsage = true;
          const normalized = usageDelta(delta);
          recordUsage(normalized.tokens_in, normalized.tokens_out);
        };

        const fileTools = wrapTools(agentTools, {
          maxToolCalls: limits.maxToolCalls,
          usage,
          grace,
          budgetExceeded: overBudget,
          markTruncated,
        });
        const reportTool = fileTools.report_finding;
        if (typeof reportTool === 'function') {
          fileTools.report_finding = async (...args) => {
            const output = await reportTool(...args);
            noteRejection(output);
            return output;
          };
        }

        try {
          session = await driverFactory({
            model: options.model,
            systemPrompt,
            tools: fileTools,
            toolDefs,
            cwd: options.repo,
            repo: options.repo,
            base: options.base,
            head: options.head,
            file: entry.file,
            onUsage,
            onRound: () => {
              state.reportedRounds += 1;
            },
          });
          if (session?.model && reportedModel === null) reportedModel = session.model;
          const prompt = filePrompt(entry, await options.diffFor(entry.file));
          let nextPrompt = prompt;
          let graceUsed = false;
          let consecutiveEmpty = 0;
          grace.active = false;

          for (;;) {
            if (Date.now() >= deadline) throw new TimeoutError('hết thời gian của file');
            const gracePrompt = nextPrompt === FINAL_PROMPT;
            grace.active = gracePrompt;
            if (overBudget()) {
              markTruncated('budget');
              if (!gracePrompt) {
                graceUsed = true;
                nextPrompt = FINAL_PROMPT;
                continue;
              }
            } else if (usage.tool_calls >= limits.maxToolCalls) {
              markTruncated('max-tool-calls');
              if (!gracePrompt) {
                graceUsed = true;
                nextPrompt = FINAL_PROMPT;
                continue;
              }
            }

            const callsBefore = usage.tool_calls;
            const remaining = Math.max(1, deadline - Date.now());
            const round = async () =>
              withTimeout(session.prompt(nextPrompt), Math.min(requestTimeoutMs, remaining), () => {
                session?.abort?.();
              });

            let text;
            let rateAttempt = 0;
            for (;;) {
              try {
                text = await round();
                break;
              } catch (error) {
                if (error instanceof TimeoutError || !isRateError(error) || rateAttempt >= maxRateRetries) throw error;
                rateAttempt += 1;
                state.retries += 1;
                const delay = rateRetryBaseMs * 2 ** (rateAttempt - 1);
                if (delay > 0) await sleep(delay);
              }
            }
            noteText(text);
            if (state.reportedRounds > state.rounds) state.rounds = state.reportedRounds;
            else state.rounds += 1;
            if (usage.tool_calls > callsBefore) consecutiveEmpty = 0;
            else consecutiveEmpty += 1;
            if (consecutiveEmpty >= LOOP_LIMITS.maxConsecutiveEmptyRounds) {
              markTruncated(state.reason ?? 'empty-rounds');
              break;
            }

            const budgetNow = overBudget();
            const capNow = usage.tool_calls >= limits.maxToolCalls;
            if (budgetNow) markTruncated('budget');
            else if (capNow) markTruncated('max-tool-calls');
            if ((budgetNow || capNow) && !graceUsed) {
              graceUsed = true;
              nextPrompt = FINAL_PROMPT;
              continue;
            }
            // Model dừng gọi tool = file xong (không re-prompt vô ích).
            break;
          }
          if (reportedModel === null && session.model) reportedModel = session.model;
        } catch (error) {
          if (error instanceof TimeoutError) {
            // Timeout file/request: bỏ file này, file khác vẫn chạy.
            state.timedOut = true;
            lastError = 'timeout';
          } else if (isFatalError(error)) {
            // 401/429 sau khi đã retry xong vẫn phải nổi lên CLI (21/23).
            throw error;
          } else if (!state.truncated) {
            failure = scrubSecrets(error?.message ?? String(error), env);
          }
        } finally {
          try {
            if (!sawUsage && typeof session?.usage === 'function') {
              const reported = await session.usage();
              if (reported) {
                const normalized = usageDelta(reported);
                recordUsage(normalized.tokens_in, normalized.tokens_out);
              }
            }
          } catch {
            // lỗi đọc usage không được làm mất finding đã có
          }
          try {
            await session?.dispose?.();
          } catch {
            // lỗi dispose không được làm mất finding đã có
          }
        }

        if (state.timedOut) break;
        if (failure === null) {
          lastError = null;
          break;
        }
        lastError = failure;
      }
    }

    const finalText = state.finalText === null ? null : scrubSecrets(state.finalText, env).slice(0, FINAL_TEXT_LIMIT);
    const item = {
      file: entry.file,
      usage,
      rounds: state.rounds,
      retries: state.retries,
      truncated: state.truncated,
      reason: state.reason,
      error: lastError,
      rejectedReports: { count: state.rejectedCount, reasons: state.rejectionReasons },
      finalText,
    };
    await options.onFileComplete?.(item);
    return item;
  });

  const phase = {
    tokens_in: results.reduce((total, item) => total + item.usage.tokens_in, 0),
    tokens_out: results.reduce((total, item) => total + item.usage.tokens_out, 0),
    tool_calls: results.reduce((total, item) => total + item.usage.tool_calls, 0),
    duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    files: results.map(perFileRow),
  };

  const errors = metaErrors(results);
  return {
    phase,
    model: reportedModel,
    truncated: results.filter((item) => item.truncated).map((item) => item.file),
    errors,
    retries_total: results.reduce((total, item) => total + item.retries, 0),
    succeeded: results.length - errors.length,
    findings: sortFindings(collector.findings),
  };
}

/**
 * Chạy một lần review native (pha file). Pha tổng và khử trùng lặp là commit C.
 * Ghi output sau mỗi file với meta.partial=true; lần ghi cuối do CLI thực hiện
 * với meta.partial=false.
 */
export async function reviewNative(options) {
  const started = process.hrtime.bigint();
  const env = options.env ?? process.env;
  const version = options.version ?? env.DYSTOPIA_VERSION ?? readVersion();
  const files = await options.tools.reviewFiles();
  const collector = options.collector;
  const systemPrompt = await loadSystemPrompt(options);
  const outputPath =
    typeof options.outputPath === 'string' && options.outputPath !== '' ? nodePath.resolve(options.outputPath) : null;

  const buildMeta = (results, partial, model) => {
    const usage = sumUsage(results);
    return {
      tool: 'dystopia',
      version,
      engine: 'native',
      base: options.base,
      head: options.head,
      model,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      tool_calls: usage.tool_calls,
      truncated: results.filter((item) => item.truncated).map((item) => item.file),
      concurrency: options.limits.concurrency,
      limits: {
        max_tool_calls: options.limits.maxToolCalls,
        max_tokens: options.limits.maxTokens,
      },
      per_file: results.map(perFileRow),
      errors: metaErrors(results),
      retries_total: usage.retries,
      partial,
      phases: {
        file: {
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          tool_calls: usage.tool_calls,
          duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          files: results.map(perFileRow),
        },
      },
    };
  };

  const completed = [];
  let writeChain = Promise.resolve();
  const onFileComplete = outputPath
    ? (item) => {
        completed.push(item);
        const snapshot = completed.slice();
        writeChain = writeChain.then(() =>
          writeJsonAtomic(outputPath, {
            findings: sortFindings(collector.findings),
            meta: buildMeta(snapshot, true, options.model?.label ?? null),
          }),
        );
        return writeChain;
      }
    : undefined;

  const phaseResult = await runFilePhase({
    repo: options.repo,
    base: options.base,
    head: options.head,
    files,
    limits: options.limits,
    driverFactory: options.driverFactory,
    tools: options.tools,
    collector,
    diffFor: options.tools.diffFor,
    systemPrompt,
    toolSpecs: options.tools.specs,
    model: options.model,
    env,
    onFileComplete,
  });

  const duration = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  const model = phaseResult.model ?? options.model?.label ?? null;
  const findings = phaseResult.findings;
  const meta = {
    tool: 'dystopia',
    version,
    engine: 'native',
    base: options.base,
    head: options.head,
    model,
    tokens_in: phaseResult.phase.tokens_in,
    tokens_out: phaseResult.phase.tokens_out,
    duration_ms: duration,
    tool_calls: phaseResult.phase.tool_calls,
    truncated: phaseResult.truncated,
    concurrency: options.limits.concurrency,
    limits: {
      max_tool_calls: options.limits.maxToolCalls,
      max_tokens: options.limits.maxTokens,
    },
    per_file: phaseResult.phase.files,
    errors: phaseResult.errors,
    retries_total: phaseResult.retries_total,
    partial: false,
    phases: { file: phaseResult.phase },
  };

  const errors = [];
  // Phòng thủ: mọi finding đã qua report_finding, nhưng vẫn chặn output sai schema.
  if (!Array.isArray(findings)) errors.push('findings phải là mảng');
  if (errors.length > 0) {
    throw new EngineError(`engine native tạo output sai: ${errors.join('; ')}`, {
      code: 'ENGINE_BAD_RESULT',
      exitCode: 1,
    });
  }

  if (files.length > 0 && phaseResult.succeeded === 0) {
    const detail = phaseResult.errors.map((item) => `${item.file}: ${item.error}`).join('; ');
    throw new EngineError(`tất cả ${files.length} file đều lỗi provider, không có kết quả: ${detail}`, {
      code: 'NATIVE_ALL_FILES_FAILED',
      exitCode: 20,
    });
  }

  if (outputPath) {
    await writeChain;
    await writeJsonAtomic(outputPath, { findings, meta });
  }

  return { findings, meta };
}
