// Test cấu hình MTH cho engine native: CODER_HOME bắt buộc, parse `coder models`,
// chọn model mặc định khác model viết code, DYSTOPIA_MODEL lạ → exit 64,
// `dystopia models`. Dùng coder giả, không đọc auth/.env thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  coderBinary,
  formatModels,
  listModels,
  parseModelsTable,
  resolveCoderHome,
  resolveModel,
} from '../lib/engine/native/coder.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CODER_MODULE = path.join(ROOT, 'lib', 'engine', 'native', 'coder.mjs');
const DYSTOPIA = path.join(ROOT, 'dystopia');

const TABLE = [
  'provider     model                       context  max-out  thinking  images',
  'commandcode  deepseek-v4.1-flash-fast    128k     8k       yes       no',
  'commandcode  deepseek-v4.1-flash         128k     8k       yes       no',
  'openrouter   Qwen/Qwen3.8-Omni-Flash     128k     8k       no        yes',
  'vendor       other-model                 32k      4k       no        no',
].join('\n');

async function makeFakeCoder(t, table = TABLE) {
  const home = await mkdtemp(path.join(tmpdir(), 'dystopia-coder-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binary = path.join(home, 'coder');
  await writeFile(binary, `#!/usr/bin/env bash\nset -euo pipefail\ncat <<'BANG'\n${table}\nBANG\n`);
  await chmod(binary, 0o755);
  const envFile = path.join(home, 'empty.env');
  await writeFile(envFile, '');
  return { home, binary, envFile };
}

function bareEnv(extra = {}) {
  const env = { ...process.env };
  delete env.CODER_HOME;
  delete env.CODER_DEFAULT_MODEL;
  delete env.DYSTOPIA_MODEL;
  delete env.DYSTOPIA_NATIVE_DRIVER;
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

test('thiếu CODER_HOME → lỗi rõ, exit 64 (không có giá trị mặc định)', () => {
  assert.throws(
    () => resolveCoderHome({}),
    (error) => error.exitCode === 64 && /CODER_HOME/.test(error.message) && /đặt CODER_HOME/.test(error.message),
  );
  assert.throws(
    () => listModels({ env: {} }),
    (error) => error.exitCode === 64 && /CODER_HOME/.test(error.message),
  );
  assert.throws(
    () => coderBinary({ CODER_HOME: '/khong/co/that' }),
    (error) => error.exitCode === 64 && /CODER_HOME/.test(error.message),
  );
});

test('listModels/parseModelsTable đọc bảng coder models theo cột', async (t) => {
  const coder = await makeFakeCoder(t);
  const models = listModels({ env: bareEnv({ CODER_HOME: coder.home }) });
  assert.equal(models.length, 4);
  assert.deepEqual(models[0], {
    provider: 'commandcode',
    model: 'deepseek-v4.1-flash-fast',
    label: 'commandcode/deepseek-v4.1-flash-fast',
    context: '128k',
    'max-out': '8k',
    thinking: 'yes',
    images: 'no',
  });
  assert.equal(models[2].model, 'Qwen/Qwen3.8-Omni-Flash');
  assert.equal(models[2].label, 'openrouter/Qwen/Qwen3.8-Omni-Flash');

  const parsed = parseModelsTable(TABLE);
  assert.equal(parsed[1].model, 'deepseek-v4.1-flash');
  assert.throws(() => parseModelsTable('không có header'), /header/);
});

test('model mặc định của Dystopia khác model viết code, theo thứ tự ưu tiên', async (t) => {
  const coder = await makeFakeCoder(t);
  const models = listModels({ env: bareEnv({ CODER_HOME: coder.home }) });
  const chosen = resolveModel(models, { env: bareEnv() });
  assert.equal(chosen.model, 'deepseek-v4.1-flash');

  // CODER_DEFAULT_MODEL đổi → vẫn không chọn model viết code.
  const otherCode = resolveModel(models, { env: bareEnv({ CODER_DEFAULT_MODEL: 'deepseek-v4.1-flash' }) });
  assert.equal(otherCode.model, 'Qwen/Qwen3.8-Omni-Flash');

  // Không có model ưu tiên → model đầu tiên khác model viết code.
  const table = [
    'provider  model       context  max-out  thinking  images',
    'p         code-model  8k       1k       no        no',
    'p         z-model     8k       1k       no        no',
  ].join('\n');
  const fallback = await makeFakeCoder(t, table);
  const fallbackModels = listModels({ env: bareEnv({ CODER_HOME: fallback.home }) });
  const picked = resolveModel(fallbackModels, { env: bareEnv({ CODER_DEFAULT_MODEL: 'code-model' }) });
  assert.equal(picked.model, 'z-model');

  // Chỉ còn model viết code → exit 64.
  const only = await makeFakeCoder(t, [
    'provider  model       context  max-out  thinking  images',
    'p         code-model  8k       1k       no        no',
  ].join('\n'));
  const onlyModels = listModels({ env: bareEnv({ CODER_HOME: only.home }) });
  assert.throws(
    () => resolveModel(onlyModels, { env: bareEnv({ CODER_DEFAULT_MODEL: 'code-model' }) }),
    (error) => error.exitCode === 64 && /khác model viết code/.test(error.message),
  );
});

test('DYSTOPIA_MODEL: khớp tên/provider, lạ → exit 64 kèm danh sách', async (t) => {
  const coder = await makeFakeCoder(t);
  const models = listModels({ env: bareEnv({ CODER_HOME: coder.home }) });

  assert.equal(resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'other-model' }) }).model, 'other-model');
  assert.equal(
    resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'openrouter/Qwen/Qwen3.8-Omni-Flash' }) }).model,
    'Qwen/Qwen3.8-Omni-Flash',
  );
  assert.throws(
    () => resolveModel(models, { env: bareEnv({ DYSTOPIA_MODEL: 'khong-co-model' }) }),
    (error) =>
      error.exitCode === 64 &&
      /DYSTOPIA_MODEL="khong-co-model"/.test(error.message) &&
      /other-model/.test(error.message),
  );
});

test('formatModels đánh dấu model Dystopia và model viết code', async (t) => {
  const coder = await makeFakeCoder(t);
  const models = listModels({ env: bareEnv({ CODER_HOME: coder.home }) });
  const chosen = resolveModel(models, { env: bareEnv() });
  const text = formatModels(models, { chosen, codeModel: 'deepseek-v4.1-flash-fast' });
  assert.match(text, /^\* commandcode\/deepseek-v4\.1-flash {2}\[dystopia\]$/m);
  assert.match(text, /commandcode\/deepseek-v4\.1-flash-fast.*\[code\]/);
});

test('dystopia models in danh sách và đánh dấu (coder giả)', async (t) => {
  const coder = await makeFakeCoder(t);
  const env = bareEnv({ CODER_HOME: coder.home, DYSTOPIA_ENV_FILE: coder.envFile });
  const { code, stdout } = await runCli(['models'], env);
  assert.equal(code, 0);
  assert.match(stdout, /Dystopia: commandcode\/deepseek-v4\.1-flash/);
  assert.match(stdout, /^\* commandcode\/deepseek-v4\.1-flash {2}\[dystopia\]$/m);
  assert.match(stdout, /Model viết code: deepseek-v4\.1-flash-fast/);
  assert.match(stdout, /\[code\]/);
});

test('dystopia models thiếu CODER_HOME → exit 64, lỗi rõ', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-empty-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'empty.env');
  await writeFile(envFile, '');
  const env = bareEnv({ DYSTOPIA_ENV_FILE: envFile });
  const { code, stderr } = await runCli(['models'], env);
  assert.equal(code, 64);
  assert.match(stderr, /CODER_HOME/);
});

test('review --engine native thiếu CODER_HOME → exit 64', async (t) => {
  const coder = await makeFakeCoder(t);
  const env = bareEnv({ DYSTOPIA_ENV_FILE: coder.envFile });
  const { code, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    env,
  );
  assert.equal(code, 64);
  assert.match(stderr, /CODER_HOME/);
});

test('review --engine native với DYSTOPIA_MODEL lạ → exit 64 kèm danh sách', async (t) => {
  const coder = await makeFakeCoder(t);
  const env = bareEnv({
    CODER_HOME: coder.home,
    DYSTOPIA_MODEL: 'khong-co-model',
    DYSTOPIA_ENV_FILE: coder.envFile,
  });
  const { code, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    env,
  );
  assert.equal(code, 64);
  assert.match(stderr, /DYSTOPIA_MODEL/);
  assert.match(stderr, /other-model/);
});

test('coder main: models không tham số, tham số lạ → 64', async (t) => {
  const coder = await makeFakeCoder(t);
  const env = bareEnv({ CODER_HOME: coder.home });
  const ok = await runNode(CODER_MODULE, ['models'], env);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /dystopia/);

  const bad = await runNode(CODER_MODULE, ['bogus'], env);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /tham số lạ/);
});
