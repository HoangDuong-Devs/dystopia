// Test cấu hình model riêng của Dystopia: đọc agent/models.json (không chạy
// `mth models`, không cần MTH_HOME), chọn model mặc định khác model viết
// code, DYSTOPIA_MODEL lạ → exit 64, `dystopia models`. Không đọc auth/.env thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  formatModels,
  listModels,
  parseModelsConfig,
  resolveModel,
} from '../lib/engine/native/mth.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MTH_MODULE = path.join(ROOT, 'lib', 'engine', 'native', 'mth.mjs');
const DYSTOPIA = path.join(ROOT, 'dystopia');
const MODELS_FILE = path.join(ROOT, 'agent', 'models.json');
const API_KEY_FIELD = 'api' + 'Key';
const API_KEY_ENV = 'COMMANDCODE' + '_API_KEY';

async function makeDystopiaHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dystopia-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agent = path.join(home, 'agent');
  await mkdir(agent, { recursive: true });
  await cp(MODELS_FILE, path.join(agent, 'models.json'));
  const envFile = path.join(home, 'empty.env');
  await writeFile(envFile, '');
  await chmod(envFile, 0o600);
  return { home, agent, envFile };
}

function bareEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of [
    'MTH_HOME',
    'MTH_DEFAULT_MODEL',
    'DYSTOPIA_HOME',
    'DYSTOPIA_AGENT_DIR',
    'DYSTOPIA_ENV_FILE',
    'DYSTOPIA_MODEL',
    'DYSTOPIA_NATIVE_DRIVER',
    'DYSTOPIA_PI_SDK',
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

async function runNode(script, args, env) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function runCli(args, env) {
  try {
    const result = await execFileAsync(DYSTOPIA, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('listModels đọc agent/models.json của Dystopia, không cần MTH_HOME', async (t) => {
  const home = await makeDystopiaHome(t);
  const models = listModels({ env: bareEnv({ DYSTOPIA_HOME: home.home }) });
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash-fast',
    label: 'commandcode/deepseek/deepseek-v4.1-flash-fast',
    name: 'DeepSeek V4.1 Flash Fast',
    contextWindow: 1000000,
  });
  assert.equal(models[1].model, 'deepseek/deepseek-v4.1-flash');

  const viaAgentDir = listModels({
    env: bareEnv({ DYSTOPIA_HOME: path.join(home.home, 'khong-co'), DYSTOPIA_AGENT_DIR: home.agent }),
  });
  assert.deepEqual(viaAgentDir, models);
});

test('agent/models.json of Dystopia: provider commandcode, apiKey chỉ là tên biến', async () => {
  const document = JSON.parse(await readFile(MODELS_FILE, 'utf8'));
  const provider = document.providers.commandcode;
  assert.equal(provider.name, 'CommandCode');
  assert.equal(provider.baseUrl, 'https://api.commandcode.ai/provider/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider[API_KEY_FIELD], `$${API_KEY_ENV}`);
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ['deepseek/deepseek-v4.1-flash-fast', 'deepseek/deepseek-v4.1-flash'],
  );
  assert.ok(provider.models.every((model) => model.contextWindow === 1000000));
});

test('agent/models.json: apiKey là env interpolation $NAME/${NAME}, không phải key literal', async () => {
  const document = JSON.parse(await readFile(MODELS_FILE, 'utf8'));
  const value = document.providers.commandcode[API_KEY_FIELD];
  assert.equal(value, `$${API_KEY_ENV}`);
  assert.match(value, /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/);
  assert.notEqual(value, API_KEY_ENV);
});

test('models.json thiếu/hỏng/không có model → exit 64, lỗi rõ', async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), 'dystopia-no-models-'));
  t.after(() => rm(empty, { recursive: true, force: true }));

  assert.throws(
    () => listModels({ env: bareEnv({ DYSTOPIA_HOME: empty }) }),
    (error) => error.exitCode === 64 && /models\.json/.test(error.message) && /DYSTOPIA_HOME/.test(error.message),
  );
  assert.throws(
    () => parseModelsConfig('{', { file: 'models.json' }),
    (error) => error.exitCode === 64 && /JSON/.test(error.message),
  );
  assert.throws(
    () => parseModelsConfig('{}'),
    (error) => error.exitCode === 64 && /providers/.test(error.message),
  );
  assert.throws(
    () => parseModelsConfig('{"providers":{"p":{"models":[]}}}'),
    (error) => error.exitCode === 64 && /không liệt kê/.test(error.message),
  );
});

test('model mặc định của Dystopia khác model viết code, theo thứ tự ưu tiên', async (t) => {
  const home = await makeDystopiaHome(t);
  const models = listModels({ env: bareEnv({ DYSTOPIA_HOME: home.home }) });
  const chosen = resolveModel(models, { env: bareEnv() });
  assert.equal(chosen.model, 'deepseek/deepseek-v4.1-flash');

  const otherCode = resolveModel(models, { env: bareEnv({ MTH_DEFAULT_MODEL: 'deepseek-v4.1-flash' }) });
  assert.equal(otherCode.model, 'deepseek/deepseek-v4.1-flash-fast');

  const fallbackModels = parseModelsConfig(
    JSON.stringify({
      providers: {
        p: { models: [{ id: 'code-model' }, { id: 'z-model' }] },
      },
    }),
  );
  const picked = resolveModel(fallbackModels, { env: bareEnv({ MTH_DEFAULT_MODEL: 'code-model' }) });
  assert.equal(picked.model, 'z-model');

  const only = parseModelsConfig(JSON.stringify({ providers: { p: { models: [{ id: 'code-model' }] } } }));
  assert.throws(
    () => resolveModel(only, { env: bareEnv({ MTH_DEFAULT_MODEL: 'code-model' }) }),
    (error) => error.exitCode === 64 && /khác model viết code/.test(error.message),
  );
});

test('DYSTOPIA_MODEL: khớp tên/provider, lạ → exit 64 kèm danh sách', async (t) => {
  const home = await makeDystopiaHome(t);
  const models = listModels({ env: bareEnv({ DYSTOPIA_HOME: home.home }) });

  assert.equal(
    resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'deepseek-v4.1-flash-fast' }) }).model,
    'deepseek/deepseek-v4.1-flash-fast',
  );
  assert.equal(
    resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'commandcode/deepseek/deepseek-v4.1-flash' }) }).model,
    'deepseek/deepseek-v4.1-flash',
  );
  assert.throws(
    () => resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'khong-co-model' }) }),
    (error) =>
      error.exitCode === 64 &&
      /DYSTOPIA_MODEL="khong-co-model"/.test(error.message) &&
      /deepseek-v4\.1-flash-fast/.test(error.message),
  );
});

test('formatModels đánh dấu model Dystopia và model viết code', async (t) => {
  const home = await makeDystopiaHome(t);
  const models = listModels({ env: bareEnv({ DYSTOPIA_HOME: home.home }) });
  const chosen = resolveModel(models, { env: bareEnv() });
  const text = formatModels(models, { chosen, codeModel: 'deepseek-v4.1-flash-fast' });
  assert.match(text, /^\* commandcode\/deepseek\/deepseek-v4\.1-flash {2}\[dystopia\]$/m);
  assert.match(text, /commandcode\/deepseek\/deepseek-v4\.1-flash-fast.*\[code\]/);
});

test('dystopia models in danh sách, không cần MTH_HOME', async (t) => {
  const home = await makeDystopiaHome(t);
  const env = bareEnv({ DYSTOPIA_HOME: home.home, DYSTOPIA_ENV_FILE: home.envFile });
  const { code, stdout } = await runCli(['models'], env);
  assert.equal(code, 0);
  assert.match(stdout, /Dystopia: commandcode\/deepseek\/deepseek-v4\.1-flash/);
  assert.match(stdout, /^\* commandcode\/deepseek\/deepseek-v4\.1-flash {2}\[dystopia\]$/m);
  assert.match(stdout, /Model viết code: deepseek-v4\.1-flash-fast/);
  assert.match(stdout, /\[code\]/);
});

test('dystopia models thiếu models.json → exit 64, lỗi rõ', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dystopia-no-agent-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const envFile = path.join(home, 'empty.env');
  await writeFile(envFile, '');
  await chmod(envFile, 0o600);
  const env = bareEnv({ DYSTOPIA_HOME: home, DYSTOPIA_ENV_FILE: envFile });
  const { code, stderr } = await runCli(['models'], env);
  assert.equal(code, 64);
  assert.match(stderr, /models\.json/);
  assert.match(stderr, /DYSTOPIA_HOME/);
});

test('review --engine native thiếu MTH_HOME → exit 64 (chỉ cần cho sandbox-exec)', async (t) => {
  const home = await makeDystopiaHome(t);
  const env = bareEnv({ DYSTOPIA_HOME: home.home, DYSTOPIA_ENV_FILE: home.envFile });
  const { code, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    env,
  );
  assert.equal(code, 64);
  assert.match(stderr, /MTH_HOME/);
  assert.match(stderr, /sandbox-exec\.sh/);
});

test('review --engine native chỉ có tên biến cũ (không có MTH_HOME) → exit 64, không fallback', async (t) => {
  const home = await makeDystopiaHome(t);
  const legacy = await mkdtemp(path.join(tmpdir(), 'dystopia-mth-legacy-'));
  t.after(() => rm(legacy, { recursive: true, force: true }));
  await mkdir(path.join(legacy, 'lib'), { recursive: true });
  const sandbox = path.join(legacy, 'lib', 'sandbox-exec.sh');
  await writeFile(sandbox, '#!/usr/bin/env bash\nexit 0\n');
  await chmod(sandbox, 0o755);

  const legacyHomeEnv = ['CODER', 'HOME'].join('_');
  const env = bareEnv({
    DYSTOPIA_HOME: home.home,
    DYSTOPIA_ENV_FILE: home.envFile,
  });
  env[legacyHomeEnv] = legacy;
  delete env.MTH_HOME;
  const { code, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    env,
  );
  assert.equal(code, 64);
  assert.match(stderr, /MTH_HOME/);
  assert.match(stderr, /sandbox-exec\.sh/);
  assert.doesNotMatch(stderr, new RegExp(legacyHomeEnv));
});

test('review --engine native với DYSTOPIA_MODEL lạ → exit 64 kèm danh sách', async (t) => {
  const home = await makeDystopiaHome(t);
  const env = bareEnv({
    DYSTOPIA_HOME: home.home,
    DYSTOPIA_MODEL: 'khong-co-model',
    DYSTOPIA_ENV_FILE: home.envFile,
  });
  const { code, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    env,
  );
  assert.equal(code, 64);
  assert.match(stderr, /DYSTOPIA_MODEL/);
  assert.match(stderr, /deepseek-v4\.1-flash/);
});

test('mth main: models không tham số, tham số lạ → 64', async (t) => {
  const home = await makeDystopiaHome(t);
  const env = bareEnv({ DYSTOPIA_HOME: home.home });
  const ok = await runNode(MTH_MODULE, ['models'], env);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /dystopia/);

  const bad = await runNode(MTH_MODULE, ['bogus'], env);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /tham số lạ/);
});
