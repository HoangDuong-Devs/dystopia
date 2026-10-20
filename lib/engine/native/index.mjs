// Adapter engine native cho hợp đồng engine của Dystopia.
//
// Commit B chỉ có pha file: mỗi file thay đổi một lượt agent, tool chỉ đọc,
// report_finding kiểm schema ngay, giới hạn tool call/token và meta.truncated.
// Pha tổng, khử trùng lặp và prompt/rules thật là commit C. Chỉ dùng module có
// sẵn của Node.

import nodePath from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError, readVersion } from '../ocr.mjs';
import { listModels, resolveModel } from './coder.mjs';
import { createFindingCollector } from './finding.mjs';
import { parseLimits } from './limits.mjs';
import { reviewNative } from './loop.mjs';
import { createGitRunner, createSandboxRunner, createTools, resolveCommit } from './tools.mjs';

export const NAME = 'native';

function rangeError() {
  return new EngineError('engine native cần chỉ rõ dải review: dùng --from <base> --to <head>', {
    code: 'NATIVE_RANGE_REQUIRED',
    exitCode: 64,
  });
}

function badDriver(message) {
  return new EngineError(message, { code: 'NATIVE_DRIVER', exitCode: 64 });
}

export async function loadDriverFactory(options, env) {
  if (typeof options.driver === 'function') return options.driver;
  if (options.driver && typeof options.driver.createDriver === 'function') return options.driver.createDriver;
  const file = typeof env.DYSTOPIA_NATIVE_DRIVER === 'string' ? env.DYSTOPIA_NATIVE_DRIVER.trim() : '';
  if (file !== '') {
    const resolved = nodePath.resolve(file);
    const module = await import(pathToFileURL(resolved).href);
    const factory =
      module.createDriver ?? module.default?.createDriver ?? (typeof module.default === 'function' ? module.default : null);
    if (typeof factory !== 'function') {
      throw badDriver(`driver ${resolved} thiếu export createDriver()`);
    }
    return factory;
  }
  const module = await import('./driver-pi.mjs');
  return module.createDriver;
}

/**
 * Chạy engine native cho hợp đồng engine.
 *
 * Trường riêng dùng cho test/CLI:
 * - `env`: biến môi trường thay cho process.env.
 * - `driver`: factory driver thay cho Pi (test, không gọi LLM).
 * - `models`: bảng model đã có (bỏ qua agent/models.json).
 * - `model`: model đã chọn.
 * - `runner`: runner git thay cho sandbox-exec (test).
 * - `systemPrompt` / `promptPath`: prompt hệ thống.
 * - `output`: file JSON để ghi tăng dần sau mỗi file (meta.partial=true).
 *
 * @param {import('../index.mjs').ReviewOptions & Object} options
 * @returns {Promise<import('../index.mjs').ReviewResult>}
 */
export async function review(options = {}) {
  const env = options.env ?? process.env;
  const repo = typeof options.repo === 'string' && options.repo !== '' ? nodePath.resolve(options.repo) : process.cwd();
  const base = typeof options.base === 'string' ? options.base.trim() : '';
  const head = typeof options.head === 'string' ? options.head.trim() : '';
  if (base === '' || head === '') throw rangeError();

  const limits = parseLimits(options.limits ?? {});
  const models = options.models ?? listModels({ env });
  const model = options.model ?? resolveModel(models, { env });
  const driverFactory = await loadDriverFactory(options, env);

  const runner = options.runner ?? createSandboxRunner({ repo, env });
  const headSha = await resolveCommit(createGitRunner(runner), head);
  const tools = createTools({
    repo,
    base,
    head: headSha,
    env,
    runner,
    ignorePatterns: options.ignorePatterns,
  });
  const files = await tools.reviewFiles();
  const collector = createFindingCollector({ headTree: tools.headTree, changedFiles: files.map((entry) => entry.file) });
  const agentTools = { ...tools, report_finding: collector.report_finding };

  const result = await reviewNative({
    repo,
    base,
    head: headSha,
    tools: agentTools,
    collector,
    limits,
    model,
    driverFactory,
    env,
    outputPath: typeof options.output === 'string' && options.output !== '' ? options.output : null,
    systemPrompt: options.systemPrompt,
    promptPath: options.promptPath,
    version: options.version ?? env.DYSTOPIA_VERSION ?? readVersion(),
  });

  const { validateResult } = await import('../index.mjs');
  const errors = validateResult({ findings: result.findings, meta: result.meta });
  if (errors.length > 0) {
    throw new EngineError(`output engine native không đúng schema: ${errors.join('; ')}`, {
      code: 'ENGINE_BAD_RESULT',
      exitCode: 1,
    });
  }
  return { findings: result.findings, meta: result.meta };
}

export default { name: NAME, review };
