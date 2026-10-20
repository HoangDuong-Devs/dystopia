// Vòng lặp pha file của engine native: mỗi file thay đổi một lượt agent, chạy
// song song có giới hạn. Chạm giới hạn tool call/token thì dừng lượt đó, giữ
// findings đã có và ghi file vào meta.truncated.
//
// Lớp "driver" (createDriver/prompt/usage/abort) được tách khỏi vòng lặp để test
// dùng driver giả, không gọi LLM thật. Chỉ dùng module có sẵn của Node.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { EngineError, readVersion } from '../ocr.mjs';
import { REPORT_SPEC, sortFindings } from './finding.mjs';
import { splitBudget } from './limits.mjs';

const PROMPT_URL = new URL('./prompts/placeholder.md', import.meta.url);

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

// Bọc tool để đếm và chặn theo ngân sách của file. Tool report_finding cũng
// tính một lượt gọi như các tool khác.
export function wrapTools(baseTools, options) {
  const maxToolCalls = options.maxToolCalls;
  const overTokens = options.overTokens ?? (() => false);
  const markTruncated = options.markTruncated;
  const wrapped = {};

  for (const [name, fn] of Object.entries(baseTools)) {
    if (typeof fn !== 'function') continue;
    wrapped[name] = async (...args) => {
      if (overTokens()) {
        markTruncated(`vượt ngân sách token của file`);
        options.abort?.();
        throw new LimitError('chạm giới hạn token của file, dừng lượt');
      }
      if (options.usage.tool_calls >= maxToolCalls) {
        markTruncated(`chạm giới hạn ${maxToolCalls} tool call của file`);
        options.abort?.();
        throw new LimitError(`chạm giới hạn ${maxToolCalls} tool call, dừng lượt`);
      }
      options.usage.tool_calls += 1;
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
 */
export async function runFilePhase(options) {
  const { files, limits, driverFactory, tools, collector } = options;
  const budget = splitBudget(limits.maxTokens, files.length, limits.phaseSplit);
  const systemPrompt = options.systemPrompt;
  const started = process.hrtime.bigint();
  const toolDefs = [...(options.toolSpecs ?? []), REPORT_SPEC];
  const allowed = new Set(toolDefs.map((spec) => spec.name));
  const agentTools = Object.fromEntries(
    Object.entries(tools).filter(([name, fn]) => allowed.has(name) && typeof fn === 'function'),
  );
  let reportedModel = null;

  const results = await pool(files, limits.concurrency, async (entry) => {
    const usage = { tokens_in: 0, tokens_out: 0, tool_calls: 0 };
    const state = { truncated: false, reason: null };
    let session = null;

    const markTruncated = (reason) => {
      if (state.truncated) return;
      state.truncated = true;
      state.reason = reason;
    };
    const overTokens = () => tokenTotal(usage) >= budget.perFile;
    let sawUsage = false;
    const onUsage = (delta = {}) => {
      sawUsage = true;
      usage.tokens_in += safeNumber(delta.tokens_in ?? delta.input);
      usage.tokens_out += safeNumber(delta.tokens_out ?? delta.output);
      if (overTokens()) {
        markTruncated(`vượt ngân sách ${budget.perFile} token của file`);
        session?.abort?.();
      }
    };

    const fileTools = wrapTools(agentTools, {
      maxToolCalls: limits.maxToolCalls,
      usage,
      overTokens,
      markTruncated,
      abort: () => session?.abort?.(),
    });
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
      await session.prompt(prompt);
      // Driver chỉ báo usage một lần ở cuối vẫn được tính; tránh cộng đôi khi
      // driver đã gọi onUsage trong lúc chạy.
      if (!sawUsage && typeof session.usage === 'function') {
        const reported = await session.usage();
        if (reported) {
          usage.tokens_in += safeNumber(reported.tokens_in ?? reported.input);
          usage.tokens_out += safeNumber(reported.tokens_out ?? reported.output);
        }
      }
      if (reportedModel === null && session.model) reportedModel = session.model;
    } catch (error) {
      if (error?.code !== 'NATIVE_TRUNCATED' && !state.truncated) throw error;
      markTruncated(state.reason ?? error.message);
    } finally {
      try {
        await session?.dispose?.();
      } catch {
        // lỗi dispose không được làm mất finding đã có
      }
    }

    if (overTokens()) markTruncated(`vượt ngân sách ${budget.perFile} token của file`);
    return { file: entry.file, usage, truncated: state.truncated, reason: state.reason };
  });

  const phase = {
    tokens_in: results.reduce((total, item) => total + item.usage.tokens_in, 0),
    tokens_out: results.reduce((total, item) => total + item.usage.tokens_out, 0),
    tool_calls: results.reduce((total, item) => total + item.usage.tool_calls, 0),
    duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    files: results.map((item) => ({
      file: item.file,
      tokens_in: item.usage.tokens_in,
      tokens_out: item.usage.tokens_out,
      tool_calls: item.usage.tool_calls,
      truncated: item.truncated,
    })),
  };

  return {
    phase,
    budget,
    model: reportedModel,
    truncated: results.filter((item) => item.truncated).map((item) => item.file),
    findings: sortFindings(collector.findings),
  };
}

/**
 * Chạy một lần review native (pha file). Pha tổng và khử trùng lặp là commit C.
 */
export async function reviewNative(options) {
  const started = process.hrtime.bigint();
  const version = options.version ?? process.env.DYSTOPIA_VERSION ?? readVersion();
  const files = await options.tools.reviewFiles();
  const collector = options.collector;
  const systemPrompt = await loadSystemPrompt(options);

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

  return { findings, meta };
}
