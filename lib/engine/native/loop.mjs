// Vòng lặp pha file của engine native: mỗi file thay đổi một lượt agent, chạy
// song song có giới hạn. Chạm ngưỡng dự phòng report thì ngừng cho đọc thêm và
// dành một lượt cuối cho report_finding; chỉ cắt hẳn khi vượt trần cứng. Lỗi
// provider của một file được retry một lần với session mới, không làm mất file
// khác. Findings ghi vào output sau mỗi file (meta.partial=true).
//
// Lớp "driver" (createDriver/prompt/usage/abort) được tách khỏi vòng lặp để test
// dùng driver giả, không gọi LLM thật. Chỉ dùng module có sẵn của Node.

import { readFile, rename, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import process from 'node:process';

import { EngineError, readVersion } from '../ocr.mjs';
import { scrubSecrets } from './driver-pi.mjs';
import { REPORT_SPEC, rejectionReason, sortFindings } from './finding.mjs';
import { reportReserve, splitBudget } from './limits.mjs';

const PROMPT_URL = new URL('./prompts/file-review.md', import.meta.url);
const REJECTED_REASONS_LIMIT = 20;
const FINAL_TEXT_LIMIT = 500;

const FINAL_PROMPT = [
  'Ngân sách của file này đã chạm mức dự phòng cho việc báo cáo (hoặc sắp hết lượt tool).',
  'Dừng đọc thêm. Hãy gọi report_finding cho MỌI lỗi bạn đã tìm thấy trong file này, rồi kết thúc lượt.',
  'Không gọi read_file/grep/git_show/list_changed_files nữa.',
].join('\n');

export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.code = 'NATIVE_TRUNCATED';
  }
}

export async function loadSystemPrompt(options = {}) {
  if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim() !== '') return options.systemPrompt;
  if (typeof options.promptPath === 'string') return readFile(options.promptPath, 'utf8');
  return readFile(PROMPT_URL, 'utf8');
}

function tokenTotal(usage) {
  return (usage.tokens_in ?? 0) + (usage.tokens_out ?? 0);
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Bọc tool để đếm và chặn theo ngân sách của file. Tool report_finding luôn
// được chạy (kể cả khi đã chạm trần) vì finding đã có phải giữ; chỉ tool đọc bị
// chặn. Chạm ngưỡng mềm thì tool đọc trả chuỗi nhắc report thay vì ném lỗi.
export function wrapTools(baseTools, options) {
  const maxToolCalls = options.maxToolCalls;
  const reportTool = options.reportToolName ?? 'report_finding';
  const hardTokens = options.hardTokens ?? options.overTokens ?? (() => false);
  const softTokens = options.softTokens ?? (() => false);
  const softToolCalls = options.softToolCalls ?? 0;
  const markTruncated = options.markTruncated ?? (() => {});
  const usage = options.usage;
  const wrapped = {};

  const atHardCap = () => hardTokens() || usage.tool_calls >= maxToolCalls;
  const atSoftCap = () => softTokens() || (softToolCalls > 0 && usage.tool_calls >= softToolCalls);

  for (const [name, fn] of Object.entries(baseTools)) {
    if (typeof fn !== 'function') continue;
    const isReport = name === reportTool;
    wrapped[name] = async (...args) => {
      if (atHardCap()) {
        if (!isReport) {
          const reason = hardTokens()
            ? 'vượt ngân sách token của file'
            : `chạm giới hạn ${maxToolCalls} tool call của file`;
          markTruncated(reason);
          options.abort?.();
          throw new LimitError(`${reason}, dừng lượt`);
        }
      } else if (!isReport && atSoftCap()) {
        markTruncated('chạm ngân sách dự phòng report của file');
        return 'hết ngân sách, hãy report_finding ngay';
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
    truncated: item.truncated,
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
    }),
    { tokens_in: 0, tokens_out: 0, tool_calls: 0 },
  );
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
  const budget = splitBudget(limits.maxTokens, files.length, limits.phaseSplit);
  const { softTokens } = reportReserve(budget.perFile);
  const softToolCalls = limits.maxToolCalls - 2;
  const systemPrompt = options.systemPrompt;
  const started = process.hrtime.bigint();
  const toolDefs = [...(options.toolSpecs ?? []), REPORT_SPEC];
  const allowed = new Set(toolDefs.map((spec) => spec.name));
  const agentTools = Object.fromEntries(
    Object.entries(tools).filter(([name, fn]) => allowed.has(name) && typeof fn === 'function'),
  );
  const env = options.env ?? process.env;
  let reportedModel = null;

  const results = await pool(files, limits.concurrency, async (entry) => {
    const usage = { tokens_in: 0, tokens_out: 0, tool_calls: 0 };
    const state = {
      truncated: false,
      reason: null,
      rejectedCount: 0,
      rejectionReasons: [],
      finalText: null,
    };
    let lastError = null;

    const markTruncated = (reason) => {
      if (state.truncated) return;
      state.truncated = true;
      state.reason = reason;
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
    const overTokens = () => tokenTotal(usage) >= budget.perFile;
    const overSoftTokens = () => tokenTotal(usage) >= softTokens || (softToolCalls > 0 && usage.tool_calls >= softToolCalls);

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      let session = null;
      let aborted = false;
      let sawUsage = false;
      let failure = null;

      const onUsage = (delta = {}) => {
        sawUsage = true;
        usage.tokens_in += safeNumber(delta.tokens_in ?? delta.input);
        usage.tokens_out += safeNumber(delta.tokens_out ?? delta.output);
        if (overTokens()) {
          markTruncated(`vượt ngân sách ${budget.perFile} token của file`);
          session?.abort?.();
        } else if (overSoftTokens()) {
          markTruncated('chạm ngân sách dự phòng report của file');
        }
      };

      const fileTools = wrapTools(agentTools, {
        maxToolCalls: limits.maxToolCalls,
        usage,
        softTokens: () => tokenTotal(usage) >= softTokens,
        softToolCalls,
        markTruncated,
        abort: () => {
          aborted = true;
          session?.abort?.();
        },
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
        });
        if (session?.model && reportedModel === null) reportedModel = session.model;
        const prompt = filePrompt(entry, await options.diffFor(entry.file));
        noteText(await session.prompt(prompt));
        // Một lượt cuối để model báo mọi finding đã tìm được; chỉ bỏ khi đã bị
        // cắt vì trần cứng (abort) để không gọi vào session đã dừng.
        if (!aborted && !overTokens() && overSoftTokens()) {
          noteText(await session.prompt(FINAL_PROMPT));
        }
        if (reportedModel === null && session.model) reportedModel = session.model;
      } catch (error) {
        // Lỗi xác thực/giới hạn tốc độ luôn phải nổi lên CLI, kể cả khi file đã
        // chạm giới hạn.
        const fatal = error?.code === 'NATIVE_AUTH' || error?.code === 'NATIVE_RATE';
        const limit = error?.code === 'NATIVE_TRUNCATED';
        if (fatal) throw error;
        if (state.truncated || limit) {
          // Khi file đã bị chính engine cắt, Pi kết thúc lượt ở trạng thái
          // aborted/error: mọi lỗi còn lại là hệ quả của việc cắt lượt.
          markTruncated(state.reason ?? error?.message ?? String(error));
        } else {
          failure = scrubSecrets(error?.message ?? String(error), env);
        }
      } finally {
        try {
          if (!sawUsage && typeof session?.usage === 'function') {
            const reported = await session.usage();
            if (reported) {
              usage.tokens_in += safeNumber(reported.tokens_in ?? reported.input);
              usage.tokens_out += safeNumber(reported.tokens_out ?? reported.output);
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

      if (failure === null) {
        lastError = null;
        break;
      }
      lastError = failure;
    }

    if (overTokens()) markTruncated(`vượt ngân sách ${budget.perFile} token của file`);
    const finalText = state.finalText === null ? null : scrubSecrets(state.finalText, env).slice(0, FINAL_TEXT_LIMIT);
    const item = {
      file: entry.file,
      usage,
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
    budget,
    model: reportedModel,
    truncated: results.filter((item) => item.truncated).map((item) => item.file),
    errors,
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
        phase_split: options.limits.phaseSplit,
      },
      per_file: results.map(perFileRow),
      errors: metaErrors(results),
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
      phase_split: options.limits.phaseSplit,
    },
    per_file: phaseResult.phase.files,
    errors: phaseResult.errors,
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
