// Không rò key: chạy CLI thật (models, review native với driver giả) và các
// đường lỗi với một key giả trong .env, rồi khẳng định key không xuất hiện ở
// stdout/stderr/output JSON. Cũng kiểm tra .env 644 bị từ chối, 600 được nhận.
// Không đọc .env/auth.json thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DYSTOPIA = path.join(ROOT, 'dystopia');
const FAKE_DRIVER = path.join(ROOT, 'test', 'fixtures', 'native-driver', 'fake-driver.mjs');
const FAKE_KEY = 'fake-key-LEAKCHECK-7f3a9';

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dystopia-leak-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agent = path.join(home, 'agent');
  await mkdir(agent, { recursive: true });
  await cp(path.join(ROOT, 'agent', 'models.json'), path.join(agent, 'models.json'));
  return home;
}

async function writeEnv(home, mode) {
  const file = path.join(home, '.env');
  await writeFile(file, `COMMANDCODE_API_KEY=${FAKE_KEY}\nOCR_LLM_TOKEN=${FAKE_KEY}\n`);
  await chmod(file, mode);
  return file;
}

async function makeFakeMthHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dystopia-leak-mth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'lib'), { recursive: true });
  const script = path.join(home, 'lib', 'sandbox-exec.sh');
  await writeFile(
    script,
    '#!/usr/bin/env bash\nset -euo pipefail\ncd "${MTH_WORKDIR:-$PWD}"\nexec bash -c "$1"\n',
  );
  await chmod(script, 0o755);
  return home;
}

function cleanEnv(extra = {}) {
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
    'DYSTOPIA_FAKE_SCENARIO',
    'COMMANDCODE_API_KEY',
    'OCR_LLM_TOKEN',
    'OCR_LLM_URL',
    'OCR_LLM_PROTOCOL',
    'OCR_LLM_MODEL',
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
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

function assertNoKey(label, ...texts) {
  for (const text of texts) {
    assert.ok(!String(text ?? '').includes(FAKE_KEY), `${label}: rò key trong output`);
  }
}

test('dystopia models với .env 600: không in key', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o600);
  const { code, stdout, stderr } = await runCli(['models'], cleanEnv({ DYSTOPIA_HOME: home }));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /commandcode\/deepseek\/deepseek-v4\.1-flash/);
  assertNoKey('models', stdout, stderr);
});

test('review native (driver giả) với .env 600: output/meta không chứa key', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o600);
  const mthHome = await makeFakeMthHome(t);
  const repo = await makeNativeRepo(t, { files: 1 });
  const outFile = path.join(home, 'result.json');
  const scenario = {
    model: 'fake/leak-check',
    steps: [
      {
        report: {
          file: 'src/file1.ts',
          line: 2,
          end_line: 2,
          severity: 'nên sửa',
          rule: 'logic',
          claim: 'Giá trị sai',
          evidence: 'export const value1b = 2;',
          confidence: 0.8,
        },
      },
    ],
  };
  const env = cleanEnv({
    DYSTOPIA_HOME: home,
    MTH_HOME: mthHome,
    DYSTOPIA_NATIVE_DRIVER: FAKE_DRIVER,
    DYSTOPIA_FAKE_SCENARIO: JSON.stringify(scenario),
  });
  const { code, stdout, stderr } = await runCli(
    ['review', '--engine', 'native', '--dir', repo.dir, '--from', repo.base, '--to', repo.head, '--output', outFile],
    env,
  );
  assert.equal(code, 0, stderr);
  const output = await readFile(outFile, 'utf8');
  const parsed = JSON.parse(output);
  assert.equal(parsed.meta.engine, 'native');
  assert.equal(parsed.findings.length, 1);
  assertNoKey('review', stdout, stderr, output, JSON.stringify(parsed.meta));
});

test('review native thiếu MTH_HOME: exit 64, không lộ key', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o600);
  const { code, stdout, stderr } = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002'],
    cleanEnv({ DYSTOPIA_HOME: home }),
  );
  assert.equal(code, 64);
  assert.match(stderr, /MTH_HOME/);
  assertNoKey('missing MTH_HOME', stdout, stderr);
});

test('.env 644 bị từ chối exit 64, không in nội dung', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o644);
  const { code, stdout, stderr } = await runCli(['models'], cleanEnv({ DYSTOPIA_HOME: home }));
  assert.equal(code, 64);
  assert.match(stderr, /có quyền 644/);
  assert.match(stderr, /rộng hơn 600/);
  assert.match(stderr, /chmod 600/);
  assertNoKey('.env 644', stdout, stderr);
});

test('.env 600 được nhận (models exit 0), .env 640 cũng bị từ chối', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o600);
  const ok = await runCli(['models'], cleanEnv({ DYSTOPIA_HOME: home }));
  assert.equal(ok.code, 0, ok.stderr);

  await writeEnv(home, 0o640);
  const bad = await runCli(['models'], cleanEnv({ DYSTOPIA_HOME: home }));
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /có quyền 640/);
  assertNoKey('.env 640', bad.stdout, bad.stderr);
});

test('DYSTOPIA_MODEL lạ: exit 64, không lộ key', async (t) => {
  const home = await makeHome(t);
  await writeEnv(home, 0o600);
  const { code, stdout, stderr } = await runCli(
    ['models'],
    cleanEnv({ DYSTOPIA_HOME: home, DYSTOPIA_MODEL: 'khong-co-model' }),
  );
  assert.equal(code, 64);
  assert.match(stderr, /DYSTOPIA_MODEL/);
  assert.match(stderr, /deepseek-v4\.1-flash/);
  assertNoKey('unknown model', stdout, stderr);
});
