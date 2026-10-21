// Test driver Pi với SDK giả: assistant message stopReason "error" phải nổi
// lên EngineError đúng mã thoát, thông điệp có lỗi provider nhưng không lộ key.
// Cũng chạy CLI thật để chắc lỗi được propagate qua loop/index và không ghi
// output rỗng thành công.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createDriver } from '../lib/engine/native/driver-pi.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DYSTOPIA = path.join(ROOT, 'dystopia');
const FAKE_KEY = 'fake-key-DRIVER-401-5c2e';
const FAKE_OCR_TOKEN = 'fake-token-DRIVER-OCR-9a71';

async function makeDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeAgentDir(t) {
  const dir = await makeDir(t, 'dystopia-driver-agent-');
  await writeFile(
    path.join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          name: 'Fake',
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          apiKey: '$COMMANDCODE_API_KEY',
          models: [{ id: 'fake-model', name: 'Fake Model' }],
        },
      },
    }),
  );
  return dir;
}

async function makeStubSdk(t, scenario) {
  const dir = await makeDir(t, 'dystopia-driver-sdk-');
  const file = path.join(dir, 'index.js');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    file,
    `const SCENARIO = ${JSON.stringify(scenario)};

export class ModelRuntime {
  static async create() {
    return {
      getModel(provider, id) {
        return { provider: provider ?? 'fake', id: id ?? 'fake-model' };
      },
    };
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
      if (SCENARIO.throw) {
        const error = new Error(SCENARIO.throw);
        if (SCENARIO.throwStatus) error.status = SCENARIO.throwStatus;
        throw error;
      }
      const message = {
        role: 'assistant',
        stopReason: SCENARIO.stopReason ?? 'stop',
        content: [{ type: 'text', text: SCENARIO.text ?? '' }],
        usage: { input: SCENARIO.tokens_in ?? 0, output: SCENARIO.tokens_out ?? 0 },
      };
      if (SCENARIO.errorMessage) message.errorMessage = SCENARIO.errorMessage;
      if (SCENARIO.errorStatus) message.error = { status: SCENARIO.errorStatus, message: SCENARIO.errorMessage };
      last = message;
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

function driverEnv(extra = {}) {
  return {
    ...process.env,
    COMMANDCODE_API_KEY: FAKE_KEY,
    OCR_LLM_TOKEN: FAKE_OCR_TOKEN,
    ...extra,
  };
}

async function runDriverScenario(t, scenario) {
  const agentDir = await makeAgentDir(t);
  const sdkPath = await makeStubSdk(t, scenario);
  const env = driverEnv();
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
    return await driver.prompt('review');
  } finally {
    await driver.dispose();
  }
}

function assertScrubbed(error) {
  assert.ok(!error.message.includes(FAKE_KEY), 'rò COMMANDCODE_API_KEY trong lỗi driver');
  assert.ok(!error.message.includes(FAKE_OCR_TOKEN), 'rò OCR_LLM_TOKEN trong lỗi driver');
}

test('driver Pi: stopReason error 401 → NATIVE_AUTH exit 21, không lộ key', async (t) => {
  await assert.rejects(
    () =>
      runDriverScenario(t, {
        stopReason: 'error',
        errorStatus: 401,
        errorMessage: `401 authentication_error: key=${FAKE_KEY} token=${FAKE_OCR_TOKEN}`,
      }),
    (error) => {
      assert.equal(error.code, 'NATIVE_AUTH');
      assert.equal(error.exitCode, 21);
      assert.match(error.message, /xác thực|authentication_error|401/);
      assertScrubbed(error);
      return true;
    },
  );
});

test('driver Pi: stopReason error 429 → NATIVE_RATE exit 23', async (t) => {
  await assert.rejects(
    () =>
      runDriverScenario(t, {
        stopReason: 'error',
        errorStatus: 429,
        errorMessage: '429 rate_limit_exceeded: thử lại sau',
      }),
    (error) => {
      assert.equal(error.code, 'NATIVE_RATE');
      assert.equal(error.exitCode, 23);
      assert.match(error.message, /giới hạn tốc độ|rate_limit|429/);
      return true;
    },
  );
});

test('driver Pi: prompt throw lỗi khác → NATIVE_ERROR exit 20, không lộ key', async (t) => {
  await assert.rejects(
    () =>
      runDriverScenario(t, {
        throw: `provider hỏng: ${FAKE_KEY}`,
        throwStatus: 500,
      }),
    (error) => {
      assert.equal(error.code, 'NATIVE_ERROR');
      assert.equal(error.exitCode, 20);
      assert.match(error.message, /provider hỏng|500/);
      assertScrubbed(error);
      return true;
    },
  );
});

test('review native: lỗi 401 của driver làm CLI exit 21, không ghi output rỗng', async (t) => {
  const home = await makeDir(t, 'dystopia-driver-home-');
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
          apiKey: '$COMMANDCODE_API_KEY',
          models: [{ id: 'fake-model', name: 'Fake Model' }],
        },
      },
    }),
  );

  const mthHome = await makeDir(t, 'dystopia-driver-mth-');
  await mkdir(path.join(mthHome, 'lib'), { recursive: true });
  const sandbox = path.join(mthHome, 'lib', 'sandbox-exec.sh');
  await writeFile(
    sandbox,
    '#!/usr/bin/env bash\nset -euo pipefail\ncd "${MTH_WORKDIR:-$PWD}"\nexec bash -c "$1"\n',
  );
  await chmod(sandbox, 0o755);

  const sdkPath = await makeStubSdk(t, {
    stopReason: 'error',
    errorStatus: 401,
    errorMessage: `401 authentication_error: key=${FAKE_KEY}`,
  });
  const repo = await makeNativeRepo(t, { files: 1 });
  const output = path.join(home, 'result.json');

  const env = { ...driverEnv() };
  for (const name of [
    'DYSTOPIA_AGENT_DIR',
    'DYSTOPIA_ENV_FILE',
    'DYSTOPIA_MODEL',
    'DYSTOPIA_NATIVE_DRIVER',
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    DYSTOPIA_HOME: home,
    MTH_HOME: mthHome,
    DYSTOPIA_PI_SDK: sdkPath,
  });

  let result;
  try {
    const executed = await execFileAsync(
      DYSTOPIA,
      ['review', '--engine', 'native', '--dir', repo.dir, '--from', repo.base, '--to', repo.head, '--output', output],
      { env, maxBuffer: 16 * 1024 * 1024 },
    );
    result = { code: 0, stdout: executed.stdout, stderr: executed.stderr };
  } catch (error) {
    result = {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }

  assert.equal(result.code, 21, result.stderr);
  assert.match(result.stderr, /xác thực|authentication_error|401/);
  assert.ok(!result.stderr.includes(FAKE_KEY), 'rò key trong stderr CLI');
  assert.equal(existsSync(output), false, 'không được ghi output thành công khi provider lỗi');
  await assert.rejects(readFile(output, 'utf8'), (error) => error.code === 'ENOENT');
});
