// Test khóa các hằng mặc định C2a theo Alibaba OpenCodeReview (OCR) @9867a3d:
// tool 100 lượt/file, token tổng 0 = không giới hạn, concurrency 8, timeout
// 15 phút/file + 300 giây/request, read_file 500 dòng, grep 100 dòng,
// maxTokens 16384 trong models.json. Cũng test grace round, ngân sách tổng,
// rounds/retries, timeout, không gửi tham số thinking/reasoning và report_finding
// đọc dòng theo head (Kosma).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { EngineError } from '../lib/engine/ocr.mjs';
import { loadPiSdk, createDriver } from '../lib/engine/native/driver-pi.mjs';
import { createFindingCollector } from '../lib/engine/native/finding.mjs';
import { review } from '../lib/engine/native/index.mjs';
import {
  DEFAULTS,
  LIMITS,
  LOOP_LIMITS,
  MODEL_MAX_TOKENS,
  REVIEW_ROUNDS,
  RETRY,
  parseLimits,
} from '../lib/engine/native/limits.mjs';
import { piSdkPath } from '../lib/engine/native/config.mjs';
import { createTools } from '../lib/engine/native/tools.mjs';
import { makeNativeRepo, git as gitCli } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODELS_FILE = path.join(ROOT, 'agent', 'models.json');
const FAKE_KEY = 'fake-key-C2A-7b3d';
const FINAL_MARKER = 'Đã hết lượt tool';

async function makeDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

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

function validFinding(file, overrides = {}) {
  return {
    file,
    line: 2,
    end_line: 2,
    severity: 'nên sửa',
    rule: 'logic',
    claim: `Giá trị sai trong ${file}`,
    evidence: 'export const value = 2;',
    confidence: 0.8,
    ...overrides,
  };
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
    env: { ...process.env, COMMANDCODE_API_KEY: FAKE_KEY },
  };
}

test('hằng mặc định khóa theo OCR @9867a3d (task_template 38-45, shared_flags 52/60/233-238, loop 388-389, file_read:12, code_search:18)', () => {
  assert.equal(DEFAULTS.maxToolCalls, 100);
  assert.equal(DEFAULTS.maxTokens, 0);
  assert.equal(DEFAULTS.concurrency, 8);
  assert.equal(REVIEW_ROUNDS, 1);
  assert.equal(LOOP_LIMITS.maxConsecutiveEmptyRounds, 3);
  assert.equal(LOOP_LIMITS.fileTimeoutMs, 15 * 60 * 1000);
  assert.equal(LOOP_LIMITS.requestTimeoutMs, 300 * 1000);
  assert.equal(LIMITS.readLines, 500);
  assert.equal(LIMITS.grepLines, 100);
  assert.equal(LIMITS.readChars, 60_000);
  assert.equal(LIMITS.grepChars, 60_000);
  assert.equal(LIMITS.showLines, 200);
  assert.equal(LIMITS.showChars, 12_000);
  assert.equal(MODEL_MAX_TOKENS, 16_384);
  assert.equal(RETRY.maxRateRetries, 3);
  assert.equal(RETRY.rateRetryBaseMs, 1000);
  assert.equal('phaseSplit' in DEFAULTS, false);
  assert.equal('reportReserveRatio' in LIMITS, false);

  const limits = parseLimits({});
  assert.equal(limits.maxToolCalls, 100);
  assert.equal(limits.maxTokens, 0);
  assert.equal(limits.concurrency, 8);
  assert.equal(limits.fileTimeoutMs, 15 * 60 * 1000);
  assert.equal(limits.requestTimeoutMs, 300 * 1000);
  // phase-split đã bỏ: chỉ còn được CLI chấp nhận rồi bỏ qua.
  assert.equal('phaseSplit' in limits, false);
  assert.deepEqual(parseLimits({ phase_split: 0.9 }), limits);
});

test('agent/models.json: mỗi model có maxTokens 16384 (OCR task_template.json:45)', async () => {
  const config = JSON.parse(await readFile(MODELS_FILE, 'utf8'));
  const models = Object.values(config.providers ?? {}).flatMap((provider) => provider.models ?? []);
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.maxTokens, 16_384, model.id);
    assert.notEqual(model.reasoning, true, `${model.id} không được bật reasoning`);
  }
});

test('maxTokens 0 = không giới hạn: usage lớn không truncate, không grace round', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let prompts = 0;
  const factory = async (options) => ({
    model: 'fake/no-budget',
    async prompt(text) {
      prompts += 1;
      assert.ok(!text.includes(FINAL_MARKER));
      options.onUsage({ tokens_in: 5_000_000, tokens_out: 1_000_000 });
      await options.tools.report_finding(validFinding('src/file1.ts'));
    },
    async abort() {},
    async dispose() {},
  });

  const result = await review(optionsFor(repo, factory));

  assert.equal(prompts, 1);
  assert.deepEqual(result.meta.truncated, []);
  assert.equal(result.meta.limits.max_tokens, 0);
  assert.equal(result.findings.length, 1);
});

test('ngân sách tổng: file đang chạy grace một lần, file sau không khởi động → skipped-budget', async (t) => {
  const repo = await makeNativeRepo(t, { files: 3 });
  const prompts = [];
  const factory = async (options) => ({
    model: 'fake/budget',
    async prompt(text) {
      prompts.push({ file: options.file, text });
      if (options.file === 'src/file1.ts' && text.includes(FINAL_MARKER)) {
        await options.tools.report_finding(validFinding('src/file1.ts'));
        return;
      }
      options.onUsage({ tokens_in: 5000, tokens_out: 0 });
      const blocked = await options.tools.read_file({ path: options.file, from: 1, to: 1 });
      assert.match(blocked, /vượt ngân sách token/);
    },
    async abort() {},
    async dispose() {},
  });

  const result = await review(optionsFor(repo, factory, { concurrency: 1, maxTokens: 1000 }));

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.meta.truncated.sort(), ['src/file1.ts', 'src/file2.ts', 'src/file3.ts']);
  assert.equal(result.meta.per_file[0].reason, 'budget');
  assert.deepEqual(
    result.meta.errors.map((entry) => [entry.file, entry.error]),
    [
      ['src/file2.ts', 'skipped-budget'],
      ['src/file3.ts', 'skipped-budget'],
    ],
  );
  assert.equal(result.meta.per_file[0].rounds, 2);
  assert.equal(result.meta.per_file[0].retries, 0);
  assert.equal(result.meta.retries_total, 0);
});

test('429/rate error được retry có backoff; meta.per_file.retries + meta.retries_total', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let attempts = 0;
  const factory = async (options) => ({
    model: 'fake/rate',
    async prompt() {
      attempts += 1;
      if (attempts <= 2) {
        throw new EngineError('429 rate_limit_exceeded', { code: 'NATIVE_RATE', exitCode: 23 });
      }
      await options.tools.report_finding(validFinding('src/file1.ts'));
    },
    async abort() {},
    async dispose() {},
  });

  const result = await review(
    optionsFor(repo, factory, { maxRateRetries: 2, rateRetryBaseMs: 1, concurrency: 1 }),
  );

  assert.equal(attempts, 3);
  assert.equal(result.meta.per_file[0].retries, 2);
  assert.equal(result.meta.retries_total, 2);
  assert.equal(result.meta.errors.length, 0);
  assert.equal(result.findings.length, 1);
});

test('429 sau khi hết retry vẫn là NATIVE_RATE exit 23', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  let attempts = 0;
  const factory = async () => ({
    model: 'fake/rate-fail',
    async prompt() {
      attempts += 1;
      throw new EngineError('429 rate_limit_exceeded', { code: 'NATIVE_RATE', exitCode: 23 });
    },
    async abort() {},
    async dispose() {},
  });

  await assert.rejects(
    () => review(optionsFor(repo, factory, { maxRateRetries: 2, rateRetryBaseMs: 1, concurrency: 1 })),
    (error) => error.code === 'NATIVE_RATE' && error.exitCode === 23,
  );
  assert.equal(attempts, 3);
});

test('timeout file: meta.errors {file, error:"timeout"}, file khác vẫn chạy tiếp', async (t) => {
  const repo = await makeNativeRepo(t, { files: 2 });
  const factory = async (options) => ({
    model: 'fake/timeout',
    async prompt() {
      if (options.file === 'src/file1.ts') return new Promise(() => {});
      await options.tools.report_finding(validFinding('src/file2.ts'));
    },
    async abort() {},
    async dispose() {},
  });

  const result = await review(
    optionsFor(repo, factory, { concurrency: 2, fileTimeoutMs: 200, requestTimeoutMs: 40 }),
  );

  assert.deepEqual(result.meta.errors, [{ file: 'src/file1.ts', error: 'timeout' }]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, 'src/file2.ts');
});

test('report_finding đọc số dòng theo head (Kosma): commit A 3 dòng, B 10 dòng, đĩa ở A, head=B', async (t) => {
  const root = await makeDir(t, 'dystopia-c2a-reloc-');
  const dir = path.join(root, 'repo');
  await mkdir(dir, { recursive: true });
  await gitCli(dir, ['init', '-q']);
  await gitCli(dir, ['config', 'user.email', 'test@example.invalid']);
  await gitCli(dir, ['config', 'user.name', 'Test']);

  await writeFile(path.join(dir, 'f.ts'), 'line1\nline2\nline3\n');
  await gitCli(dir, ['add', '.']);
  await gitCli(dir, ['commit', '-qm', 'A']);
  const commitA = await gitCli(dir, ['rev-parse', 'HEAD']);

  const ten = Array.from({ length: 10 }, (_value, index) => `line${index + 1}`).join('\n');
  await writeFile(path.join(dir, 'f.ts'), `${ten}\n`);
  await gitCli(dir, ['add', '.']);
  await gitCli(dir, ['commit', '-qm', 'B']);
  const commitB = await gitCli(dir, ['rev-parse', 'HEAD']);

  await gitCli(dir, ['checkout', '-q', commitA]);
  assert.equal(await readFile(path.join(dir, 'f.ts'), 'utf8'), 'line1\nline2\nline3\n');

  const tools = createTools({ repo: dir, base: commitA, head: commitB, runner: localRunner(dir) });
  const collector = createFindingCollector({ headTree: tools.headTree, changedFiles: ['f.ts'] });
  const evidence = 'line8';

  const accepted = await collector.report_finding(validFinding('f.ts', { line: 8, end_line: 8, evidence }));
  assert.match(accepted, /đã ghi nhận finding/);
  const rejected = await collector.report_finding(validFinding('f.ts', { line: 11, end_line: 11, evidence }));
  assert.match(rejected, /vượt quá 10 dòng/);
  assert.deepEqual(collector.findings.map((finding) => finding.line), [8]);
});

async function makeStubSdk(t) {
  const dir = await makeDir(t, 'dystopia-c2a-sdk-');
  const file = path.join(dir, 'index.js');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    file,
    `export class ModelRuntime {
  static async create() {
    return { getModel: (provider, id) => ({ provider: provider ?? 'fake', id: id ?? 'fake-model' }) };
  }
}

export class SettingsManager {
  static inMemory() {
    return {};
  }
}

export class SessionManager {
  static inMemory() {
    return {};
  }
}

export async function createAgentSession(options) {
  globalThis.__DYSTOPIA_CAPTURED_SESSION_OPTIONS = options;
  const listeners = [];
  const session = {
    model: { provider: 'fake', id: 'fake-model' },
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    getLastAssistantText() {
      return 'ok';
    },
    async prompt() {
      const message = {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 1, output: 1 },
      };
      for (const listener of listeners) listener({ type: 'message_end', message });
    },
    async abort() {},
    dispose() {},
  };
  return { session };
}
`,
  );
  return file;
}

async function makeAgentDir(t) {
  const dir = await makeDir(t, 'dystopia-c2a-agent-');
  await writeFile(
    path.join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          name: 'Fake',
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          apiKey: '$DYSTOPIA_FAKE_KEY',
          models: [{ id: 'fake-model', name: 'Fake Model', contextWindow: 8000, maxTokens: 16_384 }],
        },
      },
    }),
  );
  return dir;
}

test('driver: createAgentSession không nhận thinkingLevel, không có khóa reasoning/thinking', async (t) => {
  const agentDir = await makeAgentDir(t);
  const sdkPath = await makeStubSdk(t);
  const env = { ...process.env, DYSTOPIA_FAKE_KEY: FAKE_KEY };
  const driver = await createDriver({
    cwd: ROOT,
    model: { provider: 'fake', model: 'fake-model', label: 'fake/fake-model' },
    systemPrompt: 'test',
    tools: {},
    toolDefs: [],
    env,
    sdkPath,
    agentDir,
  });
  try {
    await driver.prompt('review');
  } finally {
    await driver.dispose();
  }

  const captured = globalThis.__DYSTOPIA_CAPTURED_SESSION_OPTIONS;
  delete globalThis.__DYSTOPIA_CAPTURED_SESSION_OPTIONS;
  assert.ok(captured, 'không bắt được options của createAgentSession');
  assert.equal(Object.hasOwn(captured, 'thinkingLevel'), false);
  const serializable = JSON.stringify(captured, (_key, value) => (typeof value === 'function' ? undefined : value));
  assert.doesNotMatch(serializable, /reasoning|thinking/i);
});

test('payload thật qua Pi SDK: request body không có reasoning/thinking/temperature', async (t) => {
  // Pi đọc apiKey từ process.env (không phải env truyền vào createDriver), nên
  // phải đặt biến này cho cả tiến trình trong suốt test rồi trả lại như cũ.
  const previousFakeKey = process.env.DYSTOPIA_FAKE_KEY;
  process.env.DYSTOPIA_FAKE_KEY = FAKE_KEY;
  t.after(() => {
    if (previousFakeKey === undefined) delete process.env.DYSTOPIA_FAKE_KEY;
    else process.env.DYSTOPIA_FAKE_KEY = previousFakeKey;
  });

  const env = { ...process.env, DYSTOPIA_FAKE_KEY: FAKE_KEY };
  const sdkPath = piSdkPath(env);
  if (!existsSync(sdkPath)) {
    t.skip(`không có Pi SDK tại đường dẫn mặc định (${sdkPath})`);
    return;
  }
  const sdk = await loadPiSdk({ env, sdkPath });
  assert.equal(typeof sdk.createAgentSession, 'function', 'Pi SDK thiếu export createAgentSession');
  assert.equal(typeof sdk.ModelRuntime, 'function', 'Pi SDK thiếu export ModelRuntime');

  const bodies = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      bodies.push(body);
      const base = {
        id: 'chatcmpl-c2a',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-model',
      };
      if (body.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const port = server.address().port;

  const agentDir = await makeDir(t, 'dystopia-c2a-payload-agent-');
  await writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          name: 'Fake',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: '$DYSTOPIA_FAKE_KEY',
          models: [{ id: 'fake-model', name: 'Fake Model', contextWindow: 8000, maxTokens: 16_384 }],
        },
      },
    }),
  );

  let driver = null;
  try {
    driver = await createDriver({
      cwd: ROOT,
      model: { provider: 'fake', model: 'fake-model', label: 'fake/fake-model' },
      systemPrompt: 'test',
      tools: {},
      toolDefs: [],
      env,
      sdkPath,
      agentDir,
    });
    await driver.prompt('review');
  } finally {
    await driver?.dispose?.();
  }

  assert.ok(bodies.length > 0, 'không bắt được request nào từ Pi SDK');
  for (const body of bodies) {
    const keys = new Set();
    const walk = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      }
    };
    walk(body);
    for (const key of keys) {
      assert.doesNotMatch(key, /reasoning|thinking/i, `payload có khóa ${key}`);
      assert.notEqual(key.toLowerCase(), 'temperature', `payload có temperature: ${key}`);
    }
  }
});
