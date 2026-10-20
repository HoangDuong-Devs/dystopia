// Test cô lập lỗi theo file của engine native: một file lỗi provider/stream chỉ
// bị retry một lần với session mới, không làm mất finding của file khác; output
// được ghi tăng dần (meta.partial=true) và meta.errors nêu đúng file lỗi.
// Không gọi LLM thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { review } from '../lib/engine/native/index.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DYSTOPIA = path.join(ROOT, 'dystopia');
const FAKE_DRIVER = path.join(ROOT, 'test', 'fixtures', 'native-driver', 'fake-driver.mjs');
const MODELS_FILE = path.join(ROOT, 'agent', 'models.json');
const FAKE_KEY = 'fake-key-ISOLATION-3d8f';

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

function validFinding(file) {
  return {
    file,
    line: 2,
    end_line: 2,
    severity: 'nên sửa',
    rule: 'logic',
    claim: `Giá trị sai trong ${file}`,
    evidence: 'export const value = 2;',
    confidence: 0.8,
  };
}

function optionsFor(repo, factory, extra = {}) {
  const model = { provider: 'fake', model: 'model-resolved', label: 'fake/model-resolved' };
  return {
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    models: [model],
    model,
    driver: factory,
    runner: localRunner(repo.dir),
    limits: { concurrency: 1, ...extra },
    version: '0.3.0-dev',
    env: { ...process.env, COMMANDCODE_API_KEY: FAKE_KEY },
  };
}

// behaviour(file, attempt, text, tools) chạy trong prompt; ném lỗi = lỗi provider.
function driverFactoryFor(behaviour, sessions) {
  return async (options) => {
    const file = options.file;
    const attempt = (sessions.get(file) ?? 0) + 1;
    sessions.set(file, attempt);
    return {
      model: 'fake/isolation',
      async prompt(text) {
        await behaviour(file, attempt, text, options);
      },
      async abort() {},
      async dispose() {},
    };
  };
}

test('file lỗi stream 2 lần: file khác vẫn có finding, meta.errors đúng file, output tăng dần', async (t) => {
  const repo = await makeNativeRepo(t, { files: 3 });
  const outDir = await makeDir(t, 'dystopia-isolation-out-');
  const output = path.join(outDir, 'result.json');
  const sessions = new Map();
  let snapshot = null;

  const factory = driverFactoryFor(async (file, attempt, _text, options) => {
    if (file === 'src/file2.ts') {
      throw new Error(`Stream ended without finish_reason key=${FAKE_KEY}`);
    }
    if (file === 'src/file3.ts') {
      const body = JSON.parse(await readFile(output, 'utf8'));
      snapshot = { partial: body.meta.partial, findings: body.findings.length, errors: body.meta.errors };
    }
    await options.tools.report_finding(validFinding(file));
  }, sessions);

  const result = await review({ ...optionsFor(repo, factory), output });

  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((finding) => finding.file).sort(),
    ['src/file1.ts', 'src/file3.ts'],
  );
  assert.equal(result.meta.errors.length, 1);
  assert.equal(result.meta.errors[0].file, 'src/file2.ts');
  assert.match(result.meta.errors[0].error, /Stream ended without finish_reason/);
  assert.match(result.meta.errors[0].error, /\[REDACTED\]/);
  assert.ok(!result.meta.errors[0].error.includes(FAKE_KEY), 'meta.errors rò key');
  assert.equal(result.meta.partial, false);
  assert.deepEqual(result.meta.per_file.map((row) => row.file), ['src/file1.ts', 'src/file2.ts', 'src/file3.ts']);
  assert.equal(sessions.get('src/file2.ts'), 2, 'file lỗi phải được retry đúng một lần');

  assert.ok(snapshot, 'output phải tồn tại trước khi file thứ ba chạy');
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.findings, 1);
  assert.deepEqual(snapshot.errors.map((item) => item.file), ['src/file2.ts']);

  const written = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(written.meta.partial, false);
  assert.equal(written.findings.length, 2);
  assert.deepEqual(written.meta.errors.map((item) => item.file), ['src/file2.ts']);
});

test('file lỗi một lần rồi thành công: không có meta.errors, đủ finding', async (t) => {
  const repo = await makeNativeRepo(t, { files: 3 });
  const sessions = new Map();
  const factory = driverFactoryFor(async (file, attempt, _text, options) => {
    if (file === 'src/file2.ts' && attempt === 1) {
      throw new Error('Stream ended without finish_reason');
    }
    await options.tools.report_finding(validFinding(file));
  }, sessions);

  const result = await review(optionsFor(repo, factory));

  assert.deepEqual(result.meta.errors, []);
  assert.equal(result.findings.length, 3);
  assert.equal(sessions.get('src/file2.ts'), 2);
  assert.equal(result.meta.partial, false);
});

test('tất cả file đều lỗi: exit 20, không trả kết quả rỗng như thành công', async (t) => {
  const repo = await makeNativeRepo(t, { files: 2 });
  const factory = driverFactoryFor(async () => {
    throw new Error('Stream ended without finish_reason');
  }, new Map());

  await assert.rejects(
    () => review(optionsFor(repo, factory)),
    (error) => {
      assert.equal(error.exitCode, 20);
      assert.equal(error.code, 'NATIVE_ALL_FILES_FAILED');
      assert.match(error.message, /src\/file1\.ts/);
      return true;
    },
  );
});

test('CLI: một file lỗi hai lần → exit 0, meta.errors chỉ file đó', async (t) => {
  const home = await makeDir(t, 'dystopia-isolation-home-');
  const agentDir = path.join(home, 'agent');
  await mkdir(agentDir, { recursive: true });
  await cp(MODELS_FILE, path.join(agentDir, 'models.json'));

  const coderHome = await makeDir(t, 'dystopia-isolation-coder-');
  await mkdir(path.join(coderHome, 'lib'), { recursive: true });
  const sandbox = path.join(coderHome, 'lib', 'sandbox-exec.sh');
  await writeFile(
    sandbox,
    '#!/usr/bin/env bash\nset -euo pipefail\ncd "${CODER_WORKDIR:-$PWD}"\nexec bash -c "$1"\n',
  );
  await chmod(sandbox, 0o755);

  const repo = await makeNativeRepo(t, { files: 3 });
  const output = path.join(home, 'result.json');
  const scenario = {
    model: 'fake/isolation-cli',
    failFiles: ['src/file1.ts'],
    steps: [{ report: validFinding('src/file2.ts') }],
  };
  const env = { ...process.env };
  for (const name of ['DYSTOPIA_AGENT_DIR', 'DYSTOPIA_ENV_FILE', 'DYSTOPIA_MODEL']) delete env[name];
  Object.assign(env, {
    DYSTOPIA_HOME: home,
    CODER_HOME: coderHome,
    DYSTOPIA_NATIVE_DRIVER: FAKE_DRIVER,
    DYSTOPIA_FAKE_SCENARIO: JSON.stringify(scenario),
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

  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(body.meta.errors.map((item) => item.file), ['src/file1.ts']);
  assert.equal(body.findings.length, 2);
  assert.equal(body.meta.partial, false);
});
