// Test bộ đo `dystopia bench`.
// Không gọi LLM, không gọi OCR thật: dùng repo git giả trong thư mục tạm và
// reviewer giả qua DYSTOPIA_BENCH_REVIEWER.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { requiredHits, runCase, scoreRun, validateCase } from '../lib/bench.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH = path.join(ROOT, 'lib', 'bench.mjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

async function makeRepo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-bench-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.invalid']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'src.txt'), 'one\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', 'one']);
  const base = await git(dir, ['rev-parse', 'HEAD']);
  await writeFile(path.join(dir, 'src.txt'), 'one\ntwo\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', 'two']);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  return { dir, base, head };
}

function caseFor(repo, overrides = {}) {
  return {
    id: 'case1',
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    expect_bugs: [{ id: 'bug1', file: 'src/file1.ts', line_from: 100, line_to: 105 }],
    ...overrides,
  };
}

function finding(overrides = {}) {
  const merged = {
    severity: 'nên sửa',
    file: 'src/file1.ts',
    line: 100,
    end_line: 100,
    rule: 'logic',
    claim: 'Finding giả',
    evidence: null,
    confidence: null,
    ...overrides,
  };
  if (overrides.end_line === undefined) merged.end_line = merged.line;
  return merged;
}

function reviewResult(findings, meta = {}) {
  return {
    meta: {
      tool: 'dystopia',
      version: 'fake',
      base: 'aaaa1111',
      head: 'bbbb2222',
      model: 'fake/model-bench',
      tokens_in: 10,
      tokens_out: 5,
      duration_ms: 1,
      ...meta,
    },
    findings,
  };
}

const FAKE_REVIEWER = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let output = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--output') {
    output = args[i + 1];
    i += 1;
  } else if (arg.startsWith('--output=')) {
    output = arg.slice('--output='.length);
  }
}
if (!output) {
  console.error('fake reviewer: thiếu --output');
  process.exit(2);
}
const counter = process.env.FAKE_REVIEW_COUNTER;
let index = 0;
if (counter) {
  if (existsSync(counter)) index = Number(readFileSync(counter, 'utf8')) || 0;
  writeFileSync(counter, String(index + 1));
}
const sequence = JSON.parse(process.env.FAKE_REVIEW_SEQUENCE || '[]');
const item = sequence.length > 0 ? sequence[Math.min(index, sequence.length - 1)] : { meta: {}, findings: [] };
if (item === 'error') {
  console.error('fake reviewer: lỗi cố ý');
  process.exit(5);
}
if (item === 'badjson') {
  writeFileSync(output, '{');
  process.exit(0);
}
writeFileSync(output, JSON.stringify(item));
`;

async function makeBench(t, cases, sequence) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-bench-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const casesDir = path.join(dir, 'cases');
  await mkdir(casesDir);
  for (const [name, value] of Object.entries(cases)) {
    await writeFile(path.join(casesDir, `${name}.json`), JSON.stringify(value, null, 2));
  }
  const reviewer = path.join(dir, 'fake-reviewer.mjs');
  await writeFile(reviewer, FAKE_REVIEWER);
  await chmod(reviewer, 0o755);
  const counter = path.join(dir, 'counter');
  return { dir, reviewer, counter, sequence, casesDir };
}

function benchEnv(bench, extra = {}) {
  return {
    ...process.env,
    DYSTOPIA_BENCH_DIR: bench.dir,
    DYSTOPIA_BENCH_REVIEWER: bench.reviewer,
    FAKE_REVIEW_COUNTER: bench.counter,
    FAKE_REVIEW_SEQUENCE: JSON.stringify(bench.sequence),
    ...extra,
  };
}

async function runBench(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [BENCH, ...args], {
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

function tableRow(stdout, id) {
  const line = stdout.split('\n').find((row) => row.startsWith(`${id} `));
  assert.ok(line, `không thấy dòng bảng cho ${id}: ${stdout}`);
  return line.split('|').map((cell) => cell.trim());
}

test('chấm lines: biên ±10 trúng, 11 trật', () => {
  const cfg = validateCase({
    id: 'c',
    repo: 'repo',
    base: 'abcdef0',
    head: 'abcdef1',
    expect_bugs: [{ id: 'b', file: 'src/file1.ts', line_from: 100, line_to: 105 }],
  });
  const hit = (line, endLine = line) =>
    scoreRun(cfg, { findings: [finding({ line, end_line: endLine })] }).bugs[0].hit;

  assert.equal(hit(90), true);
  assert.equal(hit(115), true);
  assert.equal(hit(89), false);
  assert.equal(hit(116), false);
  assert.equal(hit(80, 92), true);
  assert.equal(hit(80, 89), false);
});

test('chấm lines: sai file trật, rank > max_rank trật', () => {
  const cfg = validateCase({
    id: 'c',
    repo: 'repo',
    base: 'abcdef0',
    head: 'abcdef1',
    max_rank: 2,
    expect_bugs: [{ id: 'b', file: 'src/file1.ts', line_from: 100, line_to: 105 }],
  });

  assert.equal(
    scoreRun(cfg, { findings: [finding({ file: 'src/other.ts' })] }).bugs[0].hit,
    false,
  );
  assert.equal(scoreRun(cfg, { findings: [finding()] }).bugs[0].hit, true);
  assert.equal(
    scoreRun(cfg, {
      findings: [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 100 })],
    }).bugs[0].hit,
    false,
  );
});

test('chấm match file: chuỗi và mảng, không xét dòng', () => {
  const cfg = validateCase({
    id: 'c',
    repo: 'repo',
    base: 'abcdef0',
    head: 'abcdef1',
    expect_bugs: [
      { id: 'mot-file', match: 'file', file: 'src/file3.ts' },
      { id: 'nhieu-file', match: 'file', file: ['src/file1.ts', 'src/file2.ts'] },
    ],
  });
  const scored = scoreRun(cfg, {
    findings: [
      finding({ file: 'src/file3.ts', line: null, end_line: null }),
      finding({ file: 'src/file2.ts', line: 999 }),
    ],
  });
  assert.deepEqual(scored.bugs, [
    { id: 'mot-file', hit: true },
    { id: 'nhieu-file', hit: true },
  ]);

  const missed = scoreRun(cfg, { findings: [finding({ file: 'src/khac.ts' })] });
  assert.deepEqual(missed.bugs, [
    { id: 'mot-file', hit: false },
    { id: 'nhieu-file', hit: false },
  ]);
});

test('đếm finding cấm mọi rank và chỉ đếm nên sửa', () => {
  const cfg = validateCase({
    id: 'c',
    repo: 'repo',
    base: 'abcdef0',
    head: 'abcdef1',
    max_rank: 1,
    forbid_severity: ['chặn'],
    expect_bugs: [{ id: 'b', file: 'src/file1.ts', line_from: 100, line_to: 105 }],
  });
  const scored = scoreRun(cfg, {
    findings: [
      finding({ severity: 'nên sửa' }),
      finding({ severity: 'chặn', file: 'src/khac.ts' }),
      finding({ severity: 'nên sửa', file: 'src/khac.ts' }),
    ],
  });
  assert.equal(scored.forbidden, 1);
  assert.equal(scored.medium, 2);
});

test('fixture bench-basic: reviewer giả trúng biên và case pass', async (t) => {
  const repo = await makeRepo(t);
  const rawCase = await readFile(path.join(FIXTURES, 'bench-basic', 'case.json'), 'utf8');
  const rawReviewer = await readFile(path.join(FIXTURES, 'bench-basic', 'reviewer.json'), 'utf8');
  const fill = (text) =>
    JSON.parse(
      text
        .replaceAll('__REPO__', repo.dir)
        .replaceAll('__BASE__', repo.base)
        .replaceAll('__HEAD__', repo.head),
    );
  const bench = await makeBench(t, { basic: fill(rawCase) }, [fill(rawReviewer)]);

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 0);
  const row = tableRow(stdout, 'bench-basic');
  assert.equal(row[1], '1/1');
  assert.equal(row[7], 'pass');
});

test('sai file làm case fail, exit 1', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    { saiFile: caseFor(repo) },
    [reviewResult([finding({ file: 'src/other.ts' })])],
  );

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 1);
  assert.equal(tableRow(stdout, 'case1')[7], 'FAIL');
});

test('rank > max_rank làm case fail', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    { rankCao: caseFor(repo, { max_rank: 2 }) },
    [
      reviewResult([
        finding({ line: 1 }),
        finding({ line: 2 }),
        finding({ line: 100 }),
      ]),
    ],
  );

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 1);
  assert.equal(tableRow(stdout, 'case1')[7], 'FAIL');
});

test('match file với chuỗi và mảng đều pass, không xét dòng', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    {
      fileMatch: caseFor(repo, {
        expect_bugs: [
          { id: 'mot', match: 'file', file: 'src/file3.ts' },
          { id: 'nhieu', match: 'file', file: ['src/file1.ts', 'src/file2.ts'] },
        ],
      }),
    },
    [reviewResult([finding({ file: 'src/file3.ts', line: null }), finding({ file: 'src/file2.ts', line: 500 })])],
  );

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 0);
  const row = tableRow(stdout, 'case1');
  assert.equal(row[1], '2/2');
  assert.equal(row[7], 'pass');
});

test('finding cấm làm fail dù bug trúng', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    { coCam: caseFor(repo, { forbid_severity: ['chặn'] }) },
    [reviewResult([finding({ severity: 'chặn' })])],
  );

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 1);
  const row = tableRow(stdout, 'case1');
  assert.equal(row[3], '1');
  assert.equal(row[7], 'FAIL');
});

test('nên sửa chỉ đếm, không làm fail', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    { nenSua: caseFor(repo) },
    [reviewResult([finding({ severity: 'nên sửa' }), finding({ severity: 'nên sửa', line: 1 })])],
  );

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 0);
  const row = tableRow(stdout, 'case1');
  assert.equal(row[4], '2');
  assert.equal(row[7], 'pass');
});

test('--runs 3: hit 2/3 pass với min_hit_rate 0.67, fail với 1.0', async (t) => {
  const repo = await makeRepo(t);
  const sequence = [
    reviewResult([finding()]),
    reviewResult([finding()]),
    reviewResult([]),
  ];

  const benchPass = await makeBench(
    t,
    { hitRate: caseFor(repo, { min_hit_rate: 0.67 }) },
    sequence,
  );
  const pass = await runBench(['--runs', '3'], benchEnv(benchPass));
  assert.equal(pass.code, 0);
  const passRow = tableRow(pass.stdout, 'case1');
  assert.equal(passRow[1], '1/1');
  assert.match(passRow[2], /bug1=0\.67/);
  assert.equal(passRow[7], 'pass');

  const benchFail = await makeBench(
    t,
    { hitRate: caseFor(repo, { min_hit_rate: 1.0 }) },
    sequence,
  );
  const fail = await runBench(['--runs', '3'], benchEnv(benchFail));
  assert.equal(fail.code, 1);
  assert.equal(tableRow(fail.stdout, 'case1')[7], 'FAIL');
});

test('case disabled hiện skipped, không chạy reviewer, exit 0', async (t) => {
  const bench = await makeBench(t, { boQua: { id: 'boQua', disabled: true } }, [reviewResult([finding()])]);

  const { code, stdout } = await runBench([], benchEnv(bench));
  assert.equal(code, 0);
  const row = tableRow(stdout, 'boQua');
  assert.equal(row[7], 'skipped');
  await assert.rejects(readFile(bench.counter, 'utf8'));
});

test('thiếu base → exit 64, báo tên case và trường', async (t) => {
  const repo = await makeRepo(t);
  const broken = caseFor(repo);
  delete broken.base;
  const bench = await makeBench(t, { thieuBase: broken }, [reviewResult([finding()])]);

  const { code, stderr } = await runBench([], benchEnv(bench));
  assert.equal(code, 64);
  assert.match(stderr, /case1/);
  assert.match(stderr, /base/);
});

test('match lines có line null → exit 64; match file có line số → exit 64', async (t) => {
  const repo = await makeRepo(t);
  const linesNull = caseFor(repo, {
    expect_bugs: [{ id: 'b', file: 'src/file1.ts', line_from: null, line_to: 105 }],
  });
  const benchLines = await makeBench(t, { linesNull }, [reviewResult([finding()])]);
  const linesResult = await runBench([], benchEnv(benchLines));
  assert.equal(linesResult.code, 64);
  assert.match(linesResult.stderr, /line_from/);

  const fileWithLine = caseFor(repo, {
    expect_bugs: [{ id: 'b', match: 'file', file: 'src/file1.ts', line_from: 100 }],
  });
  const benchFile = await makeBench(t, { fileWithLine }, [reviewResult([finding()])]);
  const fileResult = await runBench([], benchEnv(benchFile));
  assert.equal(fileResult.code, 64);
  assert.match(fileResult.stderr, /line_from/);
});

test('requiredHits: min 0.67 × 3 → 2, min 0.7 × 3 → 3, min 1.0 × 1 → 1', () => {
  assert.equal(requiredHits(0.67, 3), 2);
  assert.equal(requiredHits(0.7, 3), 3);
  assert.equal(requiredHits(1.0, 1), 1);
  assert.equal(requiredHits(0.5, 2), 1);
  assert.equal(requiredHits(0.17, 6), 2);
  assert.equal(requiredHits(0.01, 1), 1);
  assert.equal(requiredHits(0, 3), 0);
});

test('--runs 3, min_hit_rate 0.7: 2 trúng vẫn FAIL', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    { hitRate: caseFor(repo, { min_hit_rate: 0.7 }) },
    [reviewResult([finding()]), reviewResult([finding()]), reviewResult([])],
  );
  const { code, stdout } = await runBench(['--runs', '3'], benchEnv(bench));
  assert.equal(code, 1);
  assert.equal(tableRow(stdout, 'case1')[7], 'FAIL');
});

test('--runs 6, min_hit_rate 0.17: 1 trúng (0.1667) KHÔNG đạt dù làm tròn 0.17', async (t) => {
  const repo = await makeRepo(t);
  const sequence = [reviewResult([finding()]), ...Array.from({ length: 5 }, () => reviewResult([]))];
  const bench = await makeBench(t, { hitRate: caseFor(repo, { min_hit_rate: 0.17 }) }, sequence);
  const { code, stdout } = await runBench(['--runs', '6'], benchEnv(bench));
  assert.equal(code, 1);
  assert.equal(tableRow(stdout, 'case1')[7], 'FAIL');
});

test('runCase truyền limits xuống engine (bench --engine native)', async (t) => {
  const repo = await makeRepo(t);
  const cfg = validateCase(caseFor(repo));
  let seen = null;
  const engine = {
    review: async (options) => {
      seen = options;
      return reviewResult([finding()]);
    },
  };
  const limits = { maxToolCalls: 7, maxTokens: 12345, phaseSplit: 0.6, concurrency: 3 };
  const caseRun = await runCase(cfg, 1, engine, limits);
  assert.equal(caseRun.results[0].error, null);
  assert.deepEqual(seen.limits, limits);
  assert.equal(seen.base, repo.base);
  assert.equal(seen.head, repo.head);
});

test('bench --runs không hợp lệ → exit 64', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(t, { c: caseFor(repo) }, [reviewResult([finding()])]);
  for (const value of ['0', '-1', 'abc', '1.5']) {
    const { code, stderr } = await runBench(['--runs', value], benchEnv(bench));
    assert.equal(code, 64, `--runs ${value}`);
    assert.match(stderr, /--runs/);
  }
});

test('results ghi ra results/, không đụng cases/, không ghi đè lần trước', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(t, { c: caseFor(repo) }, [reviewResult([finding()])]);
  const before = await readFile(path.join(bench.casesDir, 'c.json'), 'utf8');

  const first = await runBench([], benchEnv(bench));
  assert.equal(first.code, 0);
  const second = await runBench([], benchEnv(bench));
  assert.equal(second.code, 0);

  const files = (await readdir(path.join(bench.dir, 'results'))).sort();
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  assert.ok(files.some((file) => /-\d+\.json$/.test(file)), `thiếu hậu tố chống ghi đè: ${files}`);

  const document = JSON.parse(await readFile(path.join(bench.dir, 'results', files[0]), 'utf8'));
  assert.equal(document.runs, 1);
  assert.equal(typeof document.dystopia_head, 'string');
  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].status, 'pass');
  assert.equal(document.cases[0].runs.length, 1);
  assert.deepEqual(document.cases[0].runs[0].findings[0], {
    file: 'src/file1.ts',
    line: 100,
    severity: 'nên sửa',
    rank: 1,
  });
  assert.equal(document.cases[0].runs[0].tokens.in, 10);
  assert.equal(document.cases[0].runs[0].tokens.out, 5);

  assert.equal(await readFile(path.join(bench.casesDir, 'c.json'), 'utf8'), before);
  assert.deepEqual((await readdir(bench.casesDir)).sort(), ['c.json']);
});

test('worktree tạm bị xóa sau chạy thành công và sau khi reviewer lỗi', async (t) => {
  const repo = await makeRepo(t);
  const okId = `wt-ok-${process.pid}`;
  const errorId = `wt-error-${process.pid}`;

  const benchOk = await makeBench(t, { [okId]: caseFor(repo, { id: okId }) }, [reviewResult([finding()])]);
  const ok = await runBench([], benchEnv(benchOk));
  assert.equal(ok.code, 0);

  const benchError = await makeBench(t, { [errorId]: caseFor(repo, { id: errorId }) }, ['error']);
  const failed = await runBench([], benchEnv(benchError));
  assert.equal(failed.code, 1);
  assert.equal(tableRow(failed.stdout, errorId)[7], 'error');

  const leftovers = (await readdir(tmpdir())).filter(
    (entry) => entry.startsWith(`fm-fx-bench-${okId}-`) || entry.startsWith(`fm-fx-bench-${errorId}-`),
  );
  assert.deepEqual(leftovers, []);
});

test('wrapper `dystopia bench` gọi module bench mà không cần binary OCR', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(t, { c: caseFor(repo) }, [reviewResult([finding()])]);
  const envFile = path.join(bench.dir, 'empty.env');
  await writeFile(envFile, '');
  await chmod(envFile, 0o600);

  const { stdout } = await execFileAsync(path.join(ROOT, 'dystopia'), ['bench'], {
    env: benchEnv(bench, { DYSTOPIA_ENV_FILE: envFile }),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(tableRow(stdout, 'case1')[7], 'pass');
});

test('--case chỉ chạy case được chọn', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeBench(
    t,
    {
      mot: caseFor(repo, { id: 'mot' }),
      hai: caseFor(repo, { id: 'hai' }),
    },
    [reviewResult([finding()])],
  );

  const { code, stdout } = await runBench(['--case', 'hai'], benchEnv(bench));
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /^mot /m);
  assert.equal(tableRow(stdout, 'hai')[7], 'pass');
});

// OCR giả cho đường engine: chép fixture vào --output, không gọi mạng/LLM.
const FAKE_OCR = `#!/usr/bin/env bash
set -euo pipefail
out=""; prev=""
for a in "$@"; do
  case "$prev" in --output|-o) out="$a";; esac
  case "$a" in --output=*|-o=*) out="\${a#*=}";; esac
  prev="$a"
done
[ -n "$out" ] || { echo "fake-ocr: thiếu --output" >&2; exit 2; }
cp "$FAKE_OCR_FIXTURE" "$out"
`;

async function makeEngineBench(t, cases) {
  const bench = await makeBench(t, cases, []);
  const bin = path.join(bench.dir, 'fake-ocr');
  await writeFile(bin, FAKE_OCR);
  await chmod(bin, 0o755);
  return { ...bench, bin };
}

function engineEnv(bench, extra = {}) {
  const env = benchEnv(bench, {
    DYSTOPIA_OCR_BIN: bench.bin,
    FAKE_OCR_FIXTURE: path.join(FIXTURES, 'engine-basic.json'),
    ...extra,
  });
  delete env.DYSTOPIA_BENCH_REVIEWER;
  return env;
}

test('không có DYSTOPIA_BENCH_REVIEWER: bench gọi engine qua hợp đồng và ghi engine', async (t) => {
  const repo = await makeRepo(t);
  const bench = await makeEngineBench(t, { c: caseFor(repo) });

  const { code, stdout } = await runBench([], engineEnv(bench));
  assert.equal(code, 0);
  assert.equal(stdout.split('\n')[0], 'engine: ocr');
  assert.equal(tableRow(stdout, 'case1')[7], 'pass');

  const files = (await readdir(path.join(bench.dir, 'results'))).sort();
  const document = JSON.parse(await readFile(path.join(bench.dir, 'results', files[0]), 'utf8'));
  assert.equal(document.engine, 'ocr');
  assert.equal(document.cases[0].status, 'pass');
  assert.equal(document.cases[0].runs[0].findings[0].line, 100);
});

test('bench --engine native chạy được với MTH + driver giả (tự skip nếu thiếu sandbox)', async (t) => {
  const mthHome = process.env.MTH_HOME?.trim();
  if (!mthHome) {
    t.skip('thiếu MTH_HOME');
    return;
  }
  const sandbox = path.join(mthHome, 'lib', 'sandbox-exec.sh');
  if (!existsSync(sandbox)) {
    t.skip('thiếu $MTH_HOME/lib/sandbox-exec.sh');
    return;
  }
  const repo = await makeNativeRepo(t, { files: 1 });
  const probe = await execFileAsync(sandbox, ['true'], { env: { ...process.env, MTH_WORKDIR: repo.dir } }).then(
    () => true,
    () => false,
  );
  if (!probe) {
    t.skip('sandbox-exec không chạy được trong môi trường này');
    return;
  }

  const bench = await makeBench(
    t,
    {
      nativeCase: caseFor(repo, {
        id: 'nativeCase',
        base: repo.base,
        head: repo.head,
        expect_bugs: [{ id: 'dong2', file: 'src/file1.ts', line_from: 2, line_to: 2 }],
      }),
    },
    [],
  );
  const scenario = {
    model: 'fake/bench-native',
    steps: [
      {
        report: {
          file: 'src/file1.ts',
          line: 2,
          end_line: 2,
          severity: 'nên sửa',
          rule: 'logic',
          claim: 'Giá trị cũ',
          evidence: 'export const value1b = 2;',
          confidence: 0.8,
        },
      },
    ],
  };
  const env = benchEnv(bench, {
    MTH_HOME: mthHome,
    DYSTOPIA_NATIVE_DRIVER: path.join(ROOT, 'test', 'fixtures', 'native-driver', 'fake-driver.mjs'),
    DYSTOPIA_FAKE_SCENARIO: JSON.stringify(scenario),
  });
  delete env.DYSTOPIA_BENCH_REVIEWER;
  delete env.DYSTOPIA_MODEL;

  const { code, stdout } = await runBench(['--engine', 'native', '--max-tokens', '400000'], env);
  assert.equal(code, 0, stdout);
  assert.equal(stdout.split('\n')[0], 'engine: native');
  assert.equal(tableRow(stdout, 'nativeCase')[7], 'pass');
});

