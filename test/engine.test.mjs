// Test hợp đồng engine v0.3: registry, validateResult, adapter OCR và cờ --engine
// của CLI. Không gọi LLM, không gọi OCR thật: adapter dùng script giả qua
// DYSTOPIA_OCR_BIN, engine giả đăng ký ngay trong test.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  EngineError,
  getEngine,
  listEngines,
  readVersion,
  registerEngine,
  validateResult,
} from '../lib/engine/index.mjs';
import { review as ocrReview } from '../lib/engine/ocr.mjs';
import { review as nativeReview } from '../lib/engine/native/index.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DYSTOPIA = path.join(ROOT, 'dystopia');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const ENGINE_FIXTURE = path.join(FIXTURES, 'engine-basic.json');
const VERSION = '0.3.0-dev';

function finding(overrides = {}) {
  return {
    severity: 'nên sửa',
    file: 'src/file1.ts',
    line: 10,
    end_line: 12,
    rule: 'logic',
    claim: 'Finding giả',
    evidence: 'code();',
    confidence: null,
    ...overrides,
  };
}

function meta(overrides = {}) {
  return {
    tool: 'dystopia',
    version: VERSION,
    engine: 'fake',
    base: null,
    head: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    duration_ms: 1,
    ...overrides,
  };
}

// Script OCR giả: luôn ghi argv và cwd cạnh chính nó (để test gọi adapter trực
// tiếp cũng đọc được), rồi chép fixture vào --output.
const FAKE_OCR = `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$@" > "$here/args.txt"
pwd > "$here/cwd.txt"
if [ "\${FAKE_OCR_EXIT:-0}" != "0" ]; then exit "\${FAKE_OCR_EXIT}"; fi
out=""; prev=""
for a in "$@"; do
  case "$prev" in --output|-o) out="$a";; esac
  case "$a" in --output=*|-o=*) out="\${a#*=}";; esac
  prev="$a"
done
[ -n "$out" ] || { echo "fake-ocr: thiếu --output" >&2; exit 2; }
cp '__FIXTURE__' "$out"
`;

async function makeFakeOcr(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-ocr');
  await writeFile(bin, FAKE_OCR.replaceAll('__FIXTURE__', ENGINE_FIXTURE));
  await chmod(bin, 0o755);
  const envFile = path.join(dir, 'empty.env');
  await writeFile(envFile, '');
  await chmod(envFile, 0o600);
  return { dir, bin, envFile, argsFile: path.join(dir, 'args.txt'), cwdFile: path.join(dir, 'cwd.txt') };
}

function cliEnv(fake, extra = {}) {
  const env = {
    ...process.env,
    DYSTOPIA_OCR_BIN: fake.bin,
    DYSTOPIA_ENV_FILE: fake.envFile,
    ...extra,
  };
  delete env.DYSTOPIA_VERSION;
  delete env.DYSTOPIA_BENCH_REVIEWER;
  return env;
}

async function runCli(args, env, options = {}) {
  try {
    const result = await execFileAsync(DYSTOPIA, args, { env, maxBuffer: 16 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function readArgs(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

test('engine giả đăng ký trong test chạy đúng hợp đồng và qua validateResult', async () => {
  let seen = null;
  registerEngine('fake-engine', {
    review: async (options) => {
      seen = options;
      return { findings: [finding()], meta: meta({ engine: 'fake-engine' }) };
    },
  });

  const result = await getEngine('fake-engine').review({ repo: ROOT, base: 'a', head: 'b', rules: [], limits: {} });
  assert.equal(seen.repo, ROOT);
  assert.deepEqual(validateResult(result), []);
  assert.equal(result.meta.engine, 'fake-engine');
  assert.ok(listEngines().includes('ocr'));
});

test('adapter ocr trả { findings, meta } đúng schema, meta.engine = ocr', async (t) => {
  const fake = await makeFakeOcr(t);
  const result = await ocrReview({
    repo: fake.dir,
    base: 'base0001',
    head: 'head0002',
    bin: fake.bin,
    version: VERSION,
  });

  assert.deepEqual(validateResult(result), []);
  assert.equal(result.meta.engine, 'ocr');
  assert.equal(result.meta.tool, 'dystopia');
  assert.equal(result.meta.version, VERSION);
  assert.equal(result.meta.model, 'fake/model-engine');
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].file, 'src/file1.ts');
  assert.equal(result.findings[0].line, 100);
  assert.equal(result.findings[0].end_line, 101);

  const args = await readArgs(fake.argsFile);
  assert.deepEqual(args.slice(0, 5), ['review', '--format', 'json', '--output', args[4]]);
  assert.deepEqual(args.slice(-4), ['--from', 'base0001', '--to', 'head0002']);
});

test('hợp đồng chung chạy trên cả ocr (output giả) và native (driver giả)', async (t) => {
  const fake = await makeFakeOcr(t);
  const ocrResult = await ocrReview({ repo: fake.dir, bin: fake.bin, version: VERSION });
  assert.deepEqual(validateResult(ocrResult), []);
  assert.equal(ocrResult.meta.engine, 'ocr');

  const repo = await makeNativeRepo(t, { files: 1 });
  const runner = async (command) => {
    try {
      const result = await execFileAsync('bash', ['-c', command], {
        cwd: repo.dir,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, status: 0 };
    } catch (error) {
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        status: typeof error.code === 'number' ? error.code : 1,
      };
    }
  };
  const model = { provider: 'fake', model: 'model-contract', label: 'fake/model-contract' };
  const driver = async (options) => ({
    model: 'fake/model-contract',
    async prompt() {
      await options.tools.report_finding({
        file: 'src/file1.ts',
        line: 2,
        end_line: 2,
        severity: 'chặn',
        rule: 'logic',
        claim: 'Giá trị sai',
        evidence: 'export const value1b = 2;',
        confidence: 0.9,
      });
    },
    async abort() {},
    async dispose() {},
  });

  const nativeResult = await nativeReview({
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    models: [model],
    model,
    driver,
    runner,
    version: VERSION,
  });
  assert.deepEqual(validateResult(nativeResult), []);
  assert.equal(nativeResult.meta.engine, 'native');
  assert.equal(nativeResult.meta.model, 'fake/model-contract');
  assert.equal(nativeResult.findings.length, 1);
  assert.equal(nativeResult.findings[0].severity, 'chặn');
});

test('validateResult từ chối severity lạ, line sai, thiếu trường, key phán quyết', () => {
  const cases = [
    ['severity lạ', { findings: [finding({ severity: 'high' })] }, /severity/],
    ['line 0', { findings: [finding({ line: 0 })] }, /line/],
    ['line âm', { findings: [finding({ line: -3 })] }, /line/],
    ['line thập phân', { findings: [finding({ line: 1.5 })] }, /line/],
    ['end_line nhỏ hơn line', { findings: [finding({ line: 10, end_line: 9 })] }, /end_line/],
    ['thiếu evidence', { findings: [(({ evidence, ...rest }) => rest)(finding())] }, /evidence/],
    ['confidence chuỗi', { findings: [finding({ confidence: 'cao' })] }, /confidence/],
    ['file rỗng', { findings: [finding({ file: '' })] }, /file/],
    ['verdict', { findings: [finding()], verdict: 'approve' }, /phán quyết/],
    ['approved lồng trong meta', { findings: [finding()], meta: { approved: true } }, /phán quyết/],
  ];
  for (const [label, partial, pattern] of cases) {
    const errors = validateResult({ meta: {}, ...partial });
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `phải báo lỗi khớp ${pattern}: ${label} → ${JSON.stringify(errors)}`,
    );
  }
  assert.deepEqual(validateResult({ findings: [], meta: {} }), []);
  assert.notDeepEqual(validateResult(null), []);
  assert.notDeepEqual(validateResult({ meta: {} }), []);
  assert.notDeepEqual(validateResult({ findings: [], meta: null }), []);
});

test('getEngine: native đã đăng ký, tên lạ vẫn lỗi exit 64', () => {
  assert.throws(
    () => getEngine('bogus'),
    (error) => error instanceof EngineError && error.code === 'ENGINE_UNKNOWN' && error.exitCode === 64,
  );
  const native = getEngine('native');
  assert.equal(typeof native.review, 'function');
  assert.ok(listEngines().includes('native'));
  assert.equal(typeof getEngine('ocr').review, 'function');
});

test('CLI --engine lạ → exit 64 và báo tên engine', async (t) => {
  const fake = await makeFakeOcr(t);
  const { code, stderr } = await runCli(['review', '--engine', 'bogus'], cliEnv(fake));
  assert.equal(code, 64);
  assert.match(stderr, /engine lạ/);
  assert.match(stderr, /ocr/);
  assert.equal(await readArgs(fake.argsFile), null, 'không được gọi OCR');
});

test('CLI --engine native thiếu --from/--to hoặc dùng -c → exit 64, gợi ý dải', async (t) => {
  const fake = await makeFakeOcr(t);
  const missing = await runCli(['review', '--engine', 'native'], cliEnv(fake));
  assert.equal(missing.code, 64);
  assert.match(missing.stderr, /--from/);
  assert.match(missing.stderr, /--to/);

  const commit = await runCli(
    ['review', '--engine', 'native', '--from', 'base0001', '--to', 'head0002', '-c', 'abc123'],
    cliEnv(fake),
  );
  assert.equal(commit.code, 64);
  assert.match(commit.stderr, /không hỗ trợ -c/);
  assert.equal(await readArgs(fake.argsFile), null, 'không được gọi OCR');
});

test('dystopia --version in dystopia <VERSION> (<git short HEAD|nogit>)', async () => {
  const { code, stdout } = await runCli(['--version'], process.env);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^dystopia 0\.3\.0-dev \(\S+\)$/);
  assert.equal(await readVersion(), VERSION);
});

test('review mặc định chạy engine ocr, meta.engine và meta.version đúng', async (t) => {
  const fake = await makeFakeOcr(t);
  const outFile = path.join(fake.dir, 'result.json');
  const { code, stdout } = await runCli(['review', '--output', outFile], cliEnv(fake));
  assert.equal(code, 0);
  assert.equal(stdout, '');

  const result = JSON.parse(await readFile(outFile, 'utf8'));
  assert.equal(result.meta.engine, 'ocr');
  assert.equal(result.meta.version, VERSION);
  assert.deepEqual(validateResult(result), []);
  assert.equal(result.findings.length, 2);
});

test('--engine ocr chạy như mặc định và --text in findings', async (t) => {
  const fake = await makeFakeOcr(t);
  const plain = await runCli(['review', '--text'], cliEnv(fake));
  const explicit = await runCli(['review', '--engine', 'ocr', '--text'], cliEnv(fake));
  assert.equal(plain.code, 0);
  assert.equal(explicit.code, 0);
  assert.equal(explicit.stdout, plain.stdout);
  assert.match(plain.stdout, /^\[nên sửa\] src\/file1\.ts:100-101 logic — /m);
});

test('--dir đổi repo review (cwd của OCR) và truyền base/head qua hợp đồng', async (t) => {
  const fake = await makeFakeOcr(t);
  const outFile = path.join(fake.dir, 'dir.json');
  const { code } = await runCli(
    ['review', '--dir', fake.dir, '--from', 'base0001', '--to', 'head0002', '--output', outFile],
    cliEnv(fake),
  );
  assert.equal(code, 0);

  assert.equal(await realpath((await readFile(fake.cwdFile, 'utf8')).trim()), await realpath(fake.dir));
  const args = await readArgs(fake.argsFile);
  assert.ok(args.includes('--from') && args.includes('base0001'), `thiếu --from: ${args}`);
  assert.ok(args.includes('--to') && args.includes('head0002'), `thiếu --to: ${args}`);
  assert.equal(args.filter((arg) => arg === '--from').length, 1);
  assert.ok(!args.includes('--engine'), `không được chuyển --engine cho OCR: ${args}`);
  assert.ok(!args.includes('--dir'), `không được chuyển --dir cho OCR: ${args}`);

  const result = JSON.parse(await readFile(outFile, 'utf8'));
  assert.equal(result.meta.base, 'base0001');
  assert.equal(result.meta.head, 'head0002');
});

test('cờ -c vẫn chuyển tiếp nguyên văn khi không có --from/--to', async (t) => {
  const fake = await makeFakeOcr(t);
  const outFile = path.join(fake.dir, 'commit.json');
  const { code } = await runCli(['review', '-c', 'abc123', '--output', outFile], cliEnv(fake));
  assert.equal(code, 0);

  const args = await readArgs(fake.argsFile);
  const commitAt = args.indexOf('-c');
  assert.ok(commitAt !== -1 && args[commitAt + 1] === 'abc123', `thiếu -c abc123: ${args}`);
  assert.ok(!args.includes('--engine'));
  assert.ok(args.includes('--format') && args.includes('json'));
});

test('--raw --engine ocr vẫn trả nguyên JSON OCR, bỏ cờ của wrapper', async (t) => {
  const fake = await makeFakeOcr(t);
  const outFile = path.join(fake.dir, 'raw.json');
  const { code } = await runCli(
    ['review', '--raw', '--engine', 'ocr', '--dir', fake.dir, `--output=${outFile}`],
    cliEnv(fake),
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await readFile(outFile, 'utf8')), JSON.parse(await readFile(ENGINE_FIXTURE, 'utf8')));

  const args = await readArgs(fake.argsFile);
  assert.ok(!args.includes('--engine') && !args.includes('--dir'), `cờ wrapper lọt xuống OCR: ${args}`);
  assert.ok(!args.includes('--raw'));
  assert.ok(args.includes(`--output=${outFile}`), `mất --output: ${args}`);
  assert.equal(args.filter((arg) => arg === outFile).length, 0, `tách sai --output=: ${args}`);
});

test('rules-overlay/rule.json tự thêm --rule như wrapper cũ', async (t) => {
  const fake = await makeFakeOcr(t);
  const home = path.join(fake.dir, 'home');
  await mkdir(path.join(home, 'rules-overlay'), { recursive: true });
  const overlay = path.join(home, 'rules-overlay', 'rule.json');
  await writeFile(overlay, '{"rules":[]}\n');

  const saved = process.env.DYSTOPIA_HOME;
  process.env.DYSTOPIA_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.DYSTOPIA_HOME;
    else process.env.DYSTOPIA_HOME = saved;
  });

  await ocrReview({ repo: fake.dir, bin: fake.bin, version: VERSION });
  const args = await readArgs(fake.argsFile);
  const ruleAt = args.indexOf('--rule');
  assert.ok(ruleAt !== -1 && args[ruleAt + 1] === overlay, `thiếu --rule overlay: ${args}`);
});

test('người gọi tự truyền --rule thì không thêm overlay', async (t) => {
  const fake = await makeFakeOcr(t);
  const home = path.join(fake.dir, 'home');
  await mkdir(path.join(home, 'rules-overlay'), { recursive: true });
  await writeFile(path.join(home, 'rules-overlay', 'rule.json'), '{"rules":[]}\n');

  const saved = process.env.DYSTOPIA_HOME;
  process.env.DYSTOPIA_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.DYSTOPIA_HOME;
    else process.env.DYSTOPIA_HOME = saved;
  });

  await ocrReview({ repo: fake.dir, bin: fake.bin, version: VERSION, args: ['--rule', 'rieng.json'] });
  const args = await readArgs(fake.argsFile);
  assert.equal(args.filter((arg) => arg === '--rule').length, 1);
  assert.ok(args.includes('rieng.json'));
});

test('thiếu binary OCR → exit 127 với thông điệp cũ', async (t) => {
  const fake = await makeFakeOcr(t);
  const env = cliEnv(fake, { DYSTOPIA_OCR_BIN: path.join(fake.dir, 'khong-co') });
  const { code, stderr } = await runCli(['review'], env);
  assert.equal(code, 127);
  assert.match(stderr, /chưa build/);
  assert.match(stderr, /install\.sh/);
});

test('--engine ocr giữ nguyên exit code của OCR', async (t) => {
  const fake = await makeFakeOcr(t);
  const { code } = await runCli(['review', '--engine', 'ocr'], cliEnv(fake, { FAKE_OCR_EXIT: '7' }));
  assert.equal(code, 7);
});
