// Test vòng lặp pha file của engine native với driver giả: giới hạn tool call,
// ngân sách token tổng, grace round, concurrency, meta.model, truncated giữ findings.
// Không gọi LLM thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { review } from '../lib/engine/native/index.mjs';
import { DEFAULTS, LOOP_LIMITS, parseLimits } from '../lib/engine/native/limits.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);

function localRunner(repo) {
  return async (command) => {
    try {
      const result = await execFileAsync('bash', ['-c', command], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr, status: 0 };
    } catch (error) {
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        status: typeof error.code === 'number' ? error.code : 1,
      };
    }
  };
}

function validFinding(overrides = {}) {
  return {
    file: 'src/file1.ts',
    line: 2,
    end_line: 2,
    severity: 'nên sửa',
    rule: 'logic',
    claim: 'Giá trị sai',
    evidence: 'export const value1b = 2;',
    confidence: 0.8,
    ...overrides,
  };
}

function fakeDriverFactory(script, stats = {}) {
  const state = { sessions: 0, active: 0, maxActive: 0, disposed: 0, ...stats };
  const factory = async (options) => {
    state.sessions += 1;
    let aborted = false;
    return {
      model: state.model ?? 'fake/driver-model',
      async prompt(text) {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          return await script(options, { aborted: () => aborted, text });
        } finally {
          state.active -= 1;
        }
      },
      async abort() {
        aborted = true;
      },
      async dispose() {
        state.disposed += 1;
      },
    };
  };
  return { factory, state };
}

function optionsFor(repo, factory, limits = {}) {
  const model = { provider: 'fake', model: 'model-resolved', label: 'fake/model-resolved' };
  return {
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    models: [model],
    model,
    driver: factory,
    runner: localRunner(repo.dir),
    limits,
    version: '0.3.0-dev',
  };
}

test('max-tool-calls: chạm giới hạn → grace round chỉ cho report_finding, findings vẫn giữ', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let blocked = null;
  let graceBlocked = null;
  let finalTurn = false;
  let prompts = 0;
  const { factory, state } = fakeDriverFactory(async (options, ctx) => {
    prompts += 1;
    if (ctx.text?.includes('Đã hết lượt tool')) {
      finalTurn = true;
      graceBlocked = await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
      await options.tools.report_finding(validFinding({ line: 2 }));
      return;
    }
    await options.tools.report_finding(validFinding({ line: 2 }));
    await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
    blocked = await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
  });

  const result = await review(optionsFor(repo, factory, { maxToolCalls: 2 }));

  assert.match(blocked, /report_finding ngay/);
  assert.match(graceBlocked, /chỉ được gọi report_finding/);
  assert.equal(finalTurn, true);
  assert.equal(prompts, 2);
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.per_file[0].reason, 'max-tool-calls');
  assert.equal(result.meta.per_file[0].rounds, 2);
  assert.equal(result.findings.length, 2);
  assert.equal(result.meta.tool_calls, 3);
  assert.equal(state.disposed, 1);
});

test('ngân sách token tổng: vượt → grace round chỉ report, ghi reason budget', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let budgetBlocked = null;
  let prompts = 0;
  let finalTurn = false;
  const { factory } = fakeDriverFactory(async (options, ctx) => {
    prompts += 1;
    if (ctx.text?.includes('Đã hết lượt tool')) {
      finalTurn = true;
      await options.tools.report_finding(validFinding());
      return;
    }
    options.onUsage({ tokens_in: 1200, tokens_out: 0 });
    budgetBlocked = await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
  });

  const result = await review(optionsFor(repo, factory, { maxTokens: 1000 }));

  assert.match(budgetBlocked, /vượt ngân sách token/);
  assert.equal(prompts, 2);
  assert.equal(finalTurn, true);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.per_file[0].reason, 'budget');
  assert.equal(result.meta.tokens_in, 1200);
  assert.equal(result.meta.tokens_out, 0);
  assert.equal(result.meta.phases.file.tokens_in, 1200);
  assert.equal(result.meta.limits.max_tokens, 1000);
});

test('chạm maxToolCalls: ngừng đọc, gửi grace round để report', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let blocked = null;
  let finalTurn = false;
  const { factory } = fakeDriverFactory(async (options, ctx) => {
    if (ctx.text?.includes('Đã hết lượt tool')) {
      finalTurn = true;
      await options.tools.report_finding(validFinding());
      return;
    }
    for (let index = 0; index < 4; index += 1) {
      await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
    }
    blocked = await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
  });

  const result = await review(optionsFor(repo, factory, { maxToolCalls: 4 }));

  assert.match(blocked, /report_finding ngay/);
  assert.equal(finalTurn, true);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.per_file[0].reason, 'max-tool-calls');
  assert.equal(result.meta.tool_calls, 5);
});

test('parseLimits: mặc định OCR 100 tool call/file, 0 token (không giới hạn), 8, timeout; phase-split bị bỏ qua', () => {
  // OCR @9867a3d: task_template.json:38, shared_flags.go:233-238, :52, agent.go:677.
  const limits = parseLimits({});
  assert.equal(limits.maxToolCalls, 100);
  assert.equal(limits.maxTokens, 0);
  assert.equal(limits.concurrency, 8);
  assert.equal(limits.fileTimeoutMs, 15 * 60 * 1000);
  assert.equal(limits.requestTimeoutMs, 300 * 1000);
  assert.equal(LOOP_LIMITS.maxConsecutiveEmptyRounds, 3);
  assert.equal(DEFAULTS.maxToolCalls, 100);
  assert.deepEqual(parseLimits({ phaseSplit: 0.3 }), limits);
  assert.equal(parseLimits({ maxTokens: 0 }).maxTokens, 0);
  for (const bad of [{ maxToolCalls: 0 }, { maxTokens: -1 }, { concurrency: 1.5 }]) {
    assert.throws(
      () => parseLimits(bad),
      (error) => error.exitCode === 64 && /phải là/.test(error.message),
      JSON.stringify(bad),
    );
  }
});

test('concurrency mặc định 8: không có quá 8 lượt agent chạy đồng thời', async (t) => {
  const repo = await makeNativeRepo(t, { files: 10 });
  const { factory, state } = fakeDriverFactory(async () => {
    await sleep(40);
  });

  await review(optionsFor(repo, factory));

  assert.equal(state.sessions, 10);
  assert.equal(state.maxActive, 8);
});

test('--concurrency 1 chạy tuần tự, 3 chạy song song tối đa 3', async (t) => {
  const repo = await makeNativeRepo(t, { files: 3 });
  const serial = fakeDriverFactory(async () => {
    await sleep(10);
  });
  await review(optionsFor(repo, serial.factory, { concurrency: 1 }));
  assert.equal(serial.state.maxActive, 1);

  const parallel = fakeDriverFactory(async () => {
    await sleep(30);
  });
  await review(optionsFor(repo, parallel.factory, { concurrency: 3 }));
  assert.equal(parallel.state.maxActive, 3);
});

test('meta.model = model driver báo, meta.engine native, tokens/tool_calls theo pha', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const { factory } = fakeDriverFactory(
    async (options) => {
      options.onUsage({ tokens_in: 10, tokens_out: 5 });
      await options.tools.report_finding(validFinding());
    },
    { model: 'fake/actual-model' },
  );

  const result = await review(optionsFor(repo, factory, { maxTokens: 10_000 }));

  assert.equal(result.meta.engine, 'native');
  assert.equal(result.meta.model, 'fake/actual-model');
  assert.equal(result.meta.tokens_in, 10);
  assert.equal(result.meta.tokens_out, 5);
  assert.equal(result.meta.tool_calls, 1);
  assert.equal(result.meta.phases.file.tool_calls, 1);
  assert.equal(result.meta.concurrency, 8);
  assert.equal(typeof result.meta.duration_ms, 'number');
  assert.equal(result.meta.version, '0.3.0-dev');
  assert.deepEqual(result.meta.truncated, []);
});

test('meta.per_file: rejected_reports (count/reasons, cap 20) + final_text (cắt 500, scrub key); prompt file-review', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const key = 'fake-key-PERFILE-c4d5';
  const seen = { systemPrompt: null };
  const longText = `xong ${key} ` + 'y'.repeat(600);
  const { factory } = fakeDriverFactory(async (options) => {
    seen.systemPrompt = options.systemPrompt;
    await options.tools.report_finding(validFinding({ severity: 'sai' }));
    await options.tools.report_finding(validFinding({ line: 99, end_line: 99 }));
    for (let index = 0; index < 20; index += 1) {
      await options.tools.report_finding(validFinding({ severity: 'sai' }));
    }
    await options.tools.report_finding(validFinding());
    return longText;
  });

  const result = await review({
    ...optionsFor(repo, factory, { maxTokens: 10_000 }),
    env: { ...process.env, COMMANDCODE_API_KEY: key },
  });

  const row = result.meta.per_file[0];
  assert.equal(row.rejected_reports.count, 22);
  assert.equal(row.rejected_reports.reasons.length, 20);
  assert.match(row.rejected_reports.reasons[0], /severity/);
  assert.match(row.rejected_reports.reasons[1], /vượt quá/);
  assert.ok(row.rejected_reports.reasons.every((reason) => !reason.includes(key)));
  assert.equal(row.final_text.length, 500);
  assert.match(row.final_text, /\[REDACTED\]/);
  assert.ok(!row.final_text.includes(key));
  assert.match(seen.systemPrompt, /You review ONE changed file/);
  assert.deepEqual(result.meta.phases.file.files[0], row);
  assert.equal(result.findings.length, 1);
});

test('native cần cả base và head → EngineError exit 64', async () => {
  await assert.rejects(
    () => review({ repo: '.', base: null, head: null, models: [], model: {} }),
    (error) => error.exitCode === 64 && /--from/.test(error.message),
  );
});
