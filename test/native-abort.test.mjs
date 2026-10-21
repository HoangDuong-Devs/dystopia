// Test hồi quy: khi chính engine cắt lượt (vượt ngân sách token hoặc chạm
// giới hạn tool call), Pi kết thúc message ở trạng thái aborted/error. Đó là
// truncated, không phải lỗi provider; riêng 401/429 vẫn phải nổi lên CLI.
//
// Dùng driver giả cho vòng lặp và SDK giả cho driver Pi + CLI thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { EngineError } from '../lib/engine/ocr.mjs';
import { review } from '../lib/engine/native/index.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DYSTOPIA = path.join(ROOT, 'dystopia');

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

function fakeDriverFactory(script) {
  const state = { aborted: 0 };
  const factory = async (options) => {
    let aborted = false;
    return {
      model: 'fake/driver-model',
      async prompt() {
        await script(options, { aborted: () => aborted });
      },
      async abort() {
        aborted = true;
        state.aborted += 1;
      },
      async dispose() {},
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

// SDK giả: message_end đầu tiên mang usage lớn (loop gọi abort), sau đó lượt
// kết thúc giống Pi thật (stopReason "aborted" + throw).
async function writeStubSdk(t, scenario) {
  const dir = await makeDir(t, 'dystopia-abort-sdk-');
  const file = path.join(dir, 'index.js');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    file,
    `const SCENARIO = ${JSON.stringify(scenario)};

export class ModelRuntime {
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

export async function createAgentSession() {
  const listeners = [];
  let last = null;
  let aborted = false;
  const emit = (message) => {
    last = message;
    for (const listener of listeners) listener({ type: 'message_end', message });
  };
  const session = {
    model: { provider: 'fake', id: 'fake-model' },
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    getLastAssistantText() {
      return last?.content?.[0]?.text ?? '';
    },
    async prompt() {
      if (SCENARIO.usage) {
        emit({
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'đang chạy' }],
          usage: { input: SCENARIO.usage.input, output: SCENARIO.usage.output },
        });
        const deadline = Date.now() + 2000;
        while (!aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      if (SCENARIO.aborted) {
        emit({ role: 'assistant', stopReason: 'aborted', content: [], usage: { input: 0, output: 0 } });
        throw new Error('This operation was aborted');
      }
      if (SCENARIO.errorStatus) {
        emit({
          role: 'assistant',
          stopReason: 'error',
          content: [{ type: 'text', text: SCENARIO.errorMessage ?? '' }],
          error: { status: SCENARIO.errorStatus, message: SCENARIO.errorMessage },
          usage: { input: 0, output: 0 },
        });
        const error = new Error(SCENARIO.errorMessage ?? 'provider error');
        error.status = SCENARIO.errorStatus;
        throw error;
      }
      emit({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'xong' }],
        usage: { input: 0, output: 0 },
      });
    },
    async abort() {
      aborted = true;
    },
    dispose() {},
  };
  return { session };
}
`,
  );
  return file;
}

async function makeCliEnv(t, scenario) {
  const home = await makeDir(t, 'dystopia-abort-home-');
  const agentDir = path.join(home, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          name: 'Fake',
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          apiKey: '[REDACTED]',
          models: [{ id: 'fake-model', name: 'Fake Model' }],
        },
      },
    }),
  );

  const mthHome = await makeDir(t, 'dystopia-abort-mth-');
  await mkdir(path.join(mthHome, 'lib'), { recursive: true });
  const sandbox = path.join(mthHome, 'lib', 'sandbox-exec.sh');
  await writeFile(
    sandbox,
    '#!/usr/bin/env bash\nset -euo pipefail\ncd "${MTH_WORKDIR:-$PWD}"\nexec bash -c "$1"\n',
  );
  await chmod(sandbox, 0o755);

  const sdkPath = await writeStubSdk(t, scenario);
  const env = {
    ...process.env,
    COMMANDCODE_API_KEY: 'fake-key-abort-7f21',
    DYSTOPIA_HOME: home,
    MTH_HOME: mthHome,
    DYSTOPIA_PI_SDK: sdkPath,
  };
  for (const name of ['DYSTOPIA_AGENT_DIR', 'DYSTOPIA_ENV_FILE', 'DYSTOPIA_MODEL', 'DYSTOPIA_NATIVE_DRIVER']) {
    delete env[name];
  }
  return { env, output: path.join(home, 'result.json') };
}

async function runCli(t, scenario, extraArgs = []) {
  const { env, output } = await makeCliEnv(t, scenario);
  const repo = await makeNativeRepo(t, { files: 1 });
  const args = [
    'review',
    '--engine',
    'native',
    '--dir',
    repo.dir,
    '--from',
    repo.base,
    '--to',
    repo.head,
    '--output',
    output,
    ...extraArgs,
  ];
  try {
    const executed = await execFileAsync(DYSTOPIA, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: executed.stdout, stderr: executed.stderr, output };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      output,
    };
  }
}

test('(a) vượt ngân sách token → abort → message aborted: review exit 0, meta.truncated', async (t) => {
  const result = await runCli(
    t,
    { usage: { input: 900, output: 200 }, aborted: true },
    ['--max-tokens', '1000'],
  );

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Pi báo lỗi provider|operation was aborted/);
  const body = JSON.parse(await readFile(result.output, 'utf8'));
  assert.deepEqual(body.meta.truncated, ['src/file1.ts']);
  assert.equal(body.meta.engine, 'native');
  assert.ok(Array.isArray(body.findings));
  assert.ok(body.meta.tokens_in >= 900);
});

test('(b) 401 vẫn exit 21 dù file đã truncated', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const { factory, state } = fakeDriverFactory(async (options) => {
    // Vượt ngân sách → loop markTruncated + abort; sau đó provider trả 401.
    options.onUsage({ tokens_in: 900, tokens_out: 200 });
    throw new EngineError('Pi báo lỗi xác thực provider (401)', { code: 'NATIVE_AUTH', exitCode: 21 });
  });

  await assert.rejects(
    () => review(optionsFor(repo, factory, { maxTokens: 1000 })),
    (error) => {
      assert.equal(error.code, 'NATIVE_AUTH');
      assert.equal(error.exitCode, 21);
      return true;
    },
  );
  assert.equal(state.aborted, 1);
});

test('(c) chạm giới hạn tool call → abort → NATIVE_ERROR của Pi vẫn là truncated', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const { factory, state } = fakeDriverFactory(async (options, ctx) => {
    await options.tools.read_file({ path: 'src/file1.ts', from: 1, to: 1 });
    try {
      await options.tools.read_file({ path: 'src/file1.ts', from: 2, to: 2 });
      assert.fail('phải chạm giới hạn tool call');
    } catch (error) {
      assert.equal(error.code, 'NATIVE_TRUNCATED');
    }
    assert.equal(ctx.aborted(), true);
    // Pi kết thúc lượt aborted sau khi engine gọi abort(); driver cũ ném lỗi này.
    throw new EngineError('Pi báo lỗi provider: This operation was aborted', {
      code: 'NATIVE_ERROR',
      exitCode: 20,
    });
  });

  const result = await review(optionsFor(repo, factory, { maxToolCalls: 1 }));
  assert.deepEqual(result.meta.truncated, ['src/file1.ts']);
  assert.equal(result.meta.phases.file.files[0].truncated, true);
  assert.equal(result.meta.tool_calls, 1);
  assert.equal(state.aborted, 1);
});
