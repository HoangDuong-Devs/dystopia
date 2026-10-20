// Test vòng lặp pha file của engine native với driver giả: giới hạn tool call,
// ngân sách token/phase-split, concurrency, meta.model, truncated giữ findings.
// Không gọi LLM thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { review } from '../lib/engine/native/index.mjs';
import { parseLimits, splitBudget } from '../lib/engine/native/limits.mjs';
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
          await script(options, { aborted: () => aborted, text });
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

test('max-tool-calls: chạm giới hạn → truncated, findings trước đó vẫn giữ', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let limitCode = null;
  const { factory, state } = fakeDriverFactory(async (options) => {
    await options.tools.report_finding(validFinding());
    await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
    try {
      await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
    } catch (error) {
      limitCode = error.code;
    }
  });

  const result = await review(optionsFor(repo, factory, { maxToolCalls: 2 }));

  assert.equal(limitCode, 'NATIVE_TRUNCATED');
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
  assert.equal(result.meta.tool_calls, 2);
  assert.equal(result.meta.phases.file.files[0].truncated, true);
  assert.equal(state.disposed, 1);
});

test('ngân sách dự phòng report: ngừng đọc, lượt cuối vẫn giữ finding', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let reserveMessage = null;
  let prompts = 0;
  let finalTurn = false;
  const { factory } = fakeDriverFactory(async (options, ctx) => {
    prompts += 1;
    if (ctx.text?.includes('dự phòng cho việc báo cáo')) {
      finalTurn = true;
      await options.tools.report_finding(validFinding());
      return;
    }
    options.onUsage({ tokens_in: 450, tokens_out: 0 });
    reserveMessage = await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
  });

  const result = await review(optionsFor(repo, factory, { maxTokens: 1000, phaseSplit: 0.5 }));

  assert.equal(reserveMessage, 'hết ngân sách, hãy report_finding ngay');
  assert.equal(prompts, 2);
  assert.equal(finalTurn, true);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.tokens_in, 450);
  assert.equal(result.meta.tokens_out, 0);
  assert.equal(result.meta.phases.file.tokens_in, 450);
});

test('chạm maxToolCalls-2: ngừng đọc, gửi lượt cuối để report', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let blocked = null;
  let finalTurn = false;
  const { factory } = fakeDriverFactory(async (options, ctx) => {
    if (ctx.text?.includes('dự phòng cho việc báo cáo')) {
      finalTurn = true;
      await options.tools.report_finding(validFinding());
      return;
    }
    for (let index = 0; index < 3; index += 1) {
      await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
    }
    blocked = await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
  });

  const result = await review(optionsFor(repo, factory, { maxToolCalls: 5, maxTokens: 10_000 }));

  assert.equal(blocked, 'hết ngân sách, hãy report_finding ngay');
  assert.equal(finalTurn, true);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.tool_calls, 4);
});

test('splitBudget: pha file 70%, phần còn lại để dành pha tổng, chia đều', () => {
  assert.deepEqual(splitBudget(1000, 1, 0.7), { fileBudget: 700, summaryBudget: 300, perFile: 700 });
  assert.deepEqual(splitBudget(1000, 2, 0.7), { fileBudget: 700, summaryBudget: 300, perFile: 350 });
  assert.deepEqual(splitBudget(10, 20, 0.7), { fileBudget: 7, summaryBudget: 3, perFile: 1 });
});

test('parseLimits: mặc định 40 tool call/file, 400000 token, 0.7, 2; giá trị sai exit 64', () => {
  const limits = parseLimits({});
  assert.equal(limits.maxToolCalls, 40);
  assert.equal(limits.maxTokens, 400_000);
  assert.equal(limits.phaseSplit, 0.7);
  assert.equal(limits.concurrency, 2);
  for (const bad of [{ maxToolCalls: 0 }, { maxTokens: -1 }, { phaseSplit: 1 }, { concurrency: 1.5 }]) {
    assert.throws(
      () => parseLimits(bad),
      (error) => error.exitCode === 64 && /phải là|phase-split/.test(error.message),
      JSON.stringify(bad),
    );
  }
});

test('concurrency mặc định 2: không có quá 2 lượt agent chạy đồng thời', async (t) => {
  const repo = await makeNativeRepo(t, { files: 4 });
  const { factory, state } = fakeDriverFactory(async () => {
    await sleep(40);
  });

  await review(optionsFor(repo, factory));

  assert.equal(state.sessions, 4);
  assert.equal(state.maxActive, 2);
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
  assert.equal(result.meta.concurrency, 2);
  assert.equal(typeof result.meta.duration_ms, 'number');
  assert.equal(result.meta.version, '0.3.0-dev');
  assert.deepEqual(result.meta.truncated, []);
});

test('native cần cả base và head → EngineError exit 64', async () => {
  await assert.rejects(
    () => review({ repo: '.', base: null, head: null, models: [], model: {} }),
    (error) => error.exitCode === 64 && /--from/.test(error.message),
  );
});
