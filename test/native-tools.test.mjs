// Test tool chỉ đọc của engine native: chặn path traversal/tuyệt đối/symlink/.git,
// cắt read_file 400 dòng, git_show chỉ base/head, lọc file lock/sinh tự
// động/binary. Không gọi LLM, không gọi OCR thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  createGitRunner,
  createSandboxRunner,
  createTools,
  loadIgnorePatterns,
  resolveCommit,
  sandboxEnv,
} from '../lib/engine/native/tools.mjs';
import { makeNativeRepo, git as gitCli } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);
const HOST_MTH_WORKDIR = '/somewhere-else';
const SANDBOX_LEAK_ENV = Object.freeze({
  CODER_WORKDIR: 'host-coder-workdir-b41e',
  CODER_HOME: 'host-coder-home-b41e',
  CODER_EXTRA_RW: 'host-coder-extra-rw-b41e',
  MTH_AGENT_DIR: 'host-mth-agent-dir-b41e',
  MTH_EXTRA_RW: 'host-mth-extra-rw-b41e',
  MTH_EXTRA_RO: 'host-mth-extra-ro-b41e',
  MTH_PASS_ENV: 'host-mth-pass-env-b41e',
  MTH_ENV_FILE: 'host-mth-env-file-b41e',
  MTH_SANDBOX_NET: 'host-mth-sandbox-net-b41e',
  MTH_SANDBOX_MODE: 'host-mth-sandbox-mode-b41e',
});
const GIT_LEAK_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'sandbox-test',
  GIT_DIR: 'host-git-dir-b41e',
  GIT_WORK_TREE: 'host-git-work-tree-b41e',
  GIT_CONFIG_GLOBAL: 'host-git-config-global-b41e',
  GIT_EXEC_PATH: 'host-git-exec-path-b41e',
  GIT_SSH_COMMAND: 'ssh -o sandbox-test-b41e',
});

function assertNoSandboxLeak(seen, hostEnv) {
  for (const [name, value] of Object.entries(hostEnv)) {
    assert.ok(!seen.includes(name), `lọt tên ${name} vào sandbox`);
    assert.ok(!seen.includes(value), `lọt giá trị ${name} vào sandbox`);
  }
}

// Runner thay cho sandbox-exec trong test thường; vẫn chạy git thật trên repo giả.
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

async function setup(t, options, toolOptions = {}) {
  const repo = await makeNativeRepo(t, options);
  const tools = createTools({
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    runner: localRunner(repo.dir),
    ...toolOptions,
  });
  return { repo, tools };
}

test('list_changed_files: có file thay đổi, bỏ lock/dist/binary, kèm +/-', async (t) => {
  const { tools } = await setup(t, { files: 2 });
  const text = await tools.list_changed_files();
  assert.match(text, /src\/file1\.ts/);
  assert.match(text, /src\/file2\.ts/);
  assert.doesNotMatch(text, /package-lock\.json/);
  assert.doesNotMatch(text, /dist\/bundle\.js/);
  assert.doesNotMatch(text, /data\.bin/);
  assert.match(text, /\+\d+\t-\d+/);

  const files = await tools.changedFiles();
  assert.deepEqual(files.map((entry) => entry.file).sort(), ['src/file1.ts', 'src/file2.ts']);
});

test('read_file: đọc file ở head, cắt tối đa 150 dòng/12000 ký tự và báo', async (t) => {
  const { tools } = await setup(t, { files: 1 });
  const head = await tools.read_file({ path: 'src/file1.ts', from: 1, to: 100 });
  assert.match(head, /src\/file1\.ts \(dòng 1-3\/3\)/);
  assert.match(head, /2: export const value1b = 2;/);
  assert.doesNotMatch(head, /\[đã cắt/);

  const capped = await tools.read_file({ path: 'src/big.ts', from: 1, to: 999 });
  assert.match(capped, /^.*\(dòng 1-150\/450\)/);
  assert.match(capped, /150: line 150/);
  assert.doesNotMatch(capped, /151: line 151/);
  assert.match(capped, /\[đã cắt: dòng 1-150; gọi lại với from\/to\] \(tổng 450 dòng\)/);

  const tail = await tools.read_file('src/big.ts', 401, 500);
  assert.match(tail, /\(dòng 401-450\/450\)/);
  assert.match(tail, /450: line 450/);
  assert.doesNotMatch(tail, /\[đã cắt/);
});

test('read_file mặc định: quanh hunk file thay đổi, 150 dòng đầu file không đổi', async (t) => {
  const { tools } = await setup(t, { files: 1, changeBig: true });
  const changedDefault = await tools.read_file({ path: 'src/file1.ts' });
  assert.match(changedDefault, /\(dòng 1-3\/3\)/);

  const bigDefault = await tools.read_file({ path: 'src/big.ts' });
  const window = /\(dòng (\d+)-(\d+)\/453\)/.exec(bigDefault);
  assert.ok(window, `thiếu cửa sổ dòng trong: ${bigDefault.slice(0, 80)}`);
  assert.ok(Number(window[1]) > 300, `cửa sổ phải quanh hunk cuối, nhận ${window[1]}`);
  assert.match(bigDefault, /appended 453/);

  const { tools: unchanged } = await setup(t, { files: 1 });
  const unchangedDefault = await unchanged.read_file({ path: 'src/big.ts' });
  assert.match(unchangedDefault, /\(dòng 1-150\/450\)/);
  assert.match(unchangedDefault, /\[đã cắt: dòng 1-150; gọi lại với from\/to\] \(tổng 450 dòng\)/);
});

test('read_file: trần ký tự mỗi lần gọi cũng cắt kèm ghi chú', async (t) => {
  const { tools } = await setup(t, { files: 1 }, { maxReadChars: 200 });
  const text = await tools.read_file({ path: 'src/big.ts', from: 1, to: 100 });
  assert.match(text, /\[đã cắt: dòng 1-\d+; gọi lại với from\/to\] \(tổng 450 dòng\)/);
  assert.ok(text.length < 400, `output phải bị cắt theo ký tự, nhận ${text.length}`);
});

test('read_file/grep/git_show chặn path traversal, tuyệt đối, symlink, .git', async (t) => {
  const { repo, tools } = await setup(t, { files: 1 });
  const attempts = [
    ['../outside/secret.txt', /\.\./],
    ['src/../../outside/secret.txt', /\.\./],
    ['/etc/passwd', /tuyệt đối/],
    ['src/link-out', /symlink/],
    ['.git/config', /\.git/],
  ];
  for (const [bad, pattern] of attempts) {
    await assert.rejects(() => tools.read_file({ path: bad }), pattern, `read_file ${bad}`);
    await assert.rejects(() => tools.grep({ pattern: 'root', path_glob: bad }), pattern, `grep ${bad}`);
    await assert.rejects(() => tools.git_show({ rev: repo.head, path: bad }), pattern, `git_show ${bad}`);
  }
});

test('không đọc được nội dung ngoài repo qua ../ (không chỉ dựa vào thông điệp lỗi)', async (t) => {
  const { repo, tools } = await setup(t, { files: 1 });
  const outside = path.relative(repo.dir, path.join(repo.outside, 'secret.txt'));
  await assert.rejects(() => tools.read_file({ path: outside }), `đọc được file ngoài repo: ${outside}`);
  await assert.rejects(() => tools.read_file({ path: 'src/link-out' }), 'đọc được symlink ra ngoài');
});

test('grep giới hạn 60 dòng khớp và lọc theo path_glob', async (t) => {
  const { tools } = await setup(t, { files: 2 });
  const result = await tools.grep({ pattern: 'value', path_glob: 'src/file2.ts' });
  assert.match(result, /src\/file2\.ts:2:/);
  assert.doesNotMatch(result, /src\/file1\.ts/);

  const many = await tools.grep({ pattern: 'line', path_glob: 'src/big.ts' });
  assert.equal(many.split('\n').filter((line) => /^src\/big\.ts:\d+:/.test(line)).length, 60);
  assert.match(many, /\[đã cắt: hiển thị 60\/450 dòng khớp/);
});

test('git_show: chỉ nhận base/head, rev lạ bị từ chối, cắt 200 dòng kèm ghi chú', async (t) => {
  const { repo, tools } = await setup(t, { files: 1 });
  const baseText = await tools.git_show({ rev: repo.base, path: 'src/file1.ts' });
  const headText = await tools.git_show({ rev: repo.head, path: 'src/file1.ts' });
  assert.match(baseText, /value1 = 1/);
  assert.doesNotMatch(baseText, /value1b/);
  assert.match(headText, /value1b/);

  const shown = await tools.git_show({ rev: repo.head, path: 'src/big.ts' });
  assert.match(shown, /^line 1\nline 2/m);
  assert.match(shown, /line 200/);
  assert.doesNotMatch(shown, /line 201/);
  assert.match(shown, /\[đã cắt: hiển thị 200\//);

  await assert.rejects(
    () => tools.git_show({ rev: 'bogus000', path: 'src/file1.ts' }),
    /rev phải là base .* hoặc head/,
  );
});

test('read_file/grep đọc commit head qua git, độc lập checkout ở đĩa', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dystopia-head-tree-'));
  const dir = path.join(root, 'repo');
  await mkdir(dir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await gitCli(dir, ['init', '-q']);
  await gitCli(dir, ['config', 'user.email', 'test@example.invalid']);
  await gitCli(dir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'x.ts'), 'old\n');
  await writeFile(path.join(dir, 'gone.ts'), 'gone\n');
  await gitCli(dir, ['add', '.']);
  await gitCli(dir, ['commit', '-qm', 'A']);
  const commitA = await gitCli(dir, ['rev-parse', 'HEAD']);

  await writeFile(path.join(dir, 'x.ts'), 'new\n');
  await rm(path.join(dir, 'gone.ts'));
  await writeFile(path.join(dir, 'new.ts'), 'brand new\n');
  await symlink(path.join('..', 'outside', 'secret.txt'), path.join(dir, 'link-out'));
  await gitCli(dir, ['add', '-A']);
  await gitCli(dir, ['commit', '-qm', 'B']);
  const commitB = await gitCli(dir, ['rev-parse', 'HEAD']);
  assert.equal(await resolveCommit(createGitRunner(localRunner(dir)), 'HEAD'), commitB);
  assert.throws(
    () => createTools({ repo: dir, base: commitA, head: 'HEAD', runner: localRunner(dir) }),
    /sha đầy đủ/,
  );

  // Đĩa cố tình ở commit A: x.ts cũ, gone.ts còn, new.ts/link-out chưa có.
  await gitCli(dir, ['checkout', '-q', commitA]);
  assert.equal(await readFile(path.join(dir, 'x.ts'), 'utf8'), 'old\n');
  assert.ok(existsSync(path.join(dir, 'gone.ts')));
  assert.ok(!existsSync(path.join(dir, 'new.ts')));

  const tools = createTools({ repo: dir, base: commitA, head: commitB, runner: localRunner(dir) });

  const x = await tools.read_file({ path: 'x.ts' });
  assert.match(x, /1: new/);
  assert.doesNotMatch(x, /old/);

  const added = await tools.read_file({ path: 'new.ts' });
  assert.match(added, /brand new/);

  await assert.rejects(() => tools.read_file({ path: 'gone.ts' }), /không tìm thấy file trong/);

  const found = await tools.grep({ pattern: 'new' });
  assert.match(found, /^x\.ts:1:new$/m);
  assert.doesNotMatch(found, /old/);

  const traversal = ['../outside/secret.txt', 'src/../../x.ts', '/etc/passwd', '.git/config'];
  for (const bad of traversal) {
    await assert.rejects(() => tools.read_file({ path: bad }), `read_file ${bad}`);
    await assert.rejects(() => tools.grep({ pattern: 'new', path_glob: bad }), `grep ${bad}`);
  }
  await assert.rejects(() => tools.read_file({ path: 'link-out' }), /symlink/);
  await assert.rejects(() => tools.grep({ pattern: 'new', path_glob: 'link-out/*' }), /symlink/);
});

test('sandboxEnv: allowlist cố định, MTH_WORKDIR luôn là repo, không lọt env host', () => {
  const repo = '/repo/dystopia-workdir-b41e';
  const fakeKey = 'fake-key-UNIT-4b1e';
  const fakeToken = 'fake-token-UNIT-9c2d';
  const hostEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp/sandbox-home-unit',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    MTH_WORKDIR: HOST_MTH_WORKDIR,
    ...SANDBOX_LEAK_ENV,
    ...GIT_LEAK_ENV,
    COMMANDCODE_API_KEY: fakeKey,
    OCR_LLM_TOKEN: fakeToken,
    DYSTOPIA_UNRELATED: 'host-dystopia-unrelated-b41e',
  };

  const env = sandboxEnv(hostEnv, repo);
  assert.equal(env.MTH_WORKDIR, repo);
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    assert.equal(env[name], hostEnv[name], `${name} phải giữ nguyên`);
  }

  const seen = Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  assertNoSandboxLeak(seen, SANDBOX_LEAK_ENV);
  assertNoSandboxLeak(seen, GIT_LEAK_ENV);
  assert.ok(!seen.includes(HOST_MTH_WORKDIR), 'MTH_WORKDIR của host không được thắng repo');
  assert.ok(!seen.includes(fakeKey), 'lọt giá trị COMMANDCODE_API_KEY vào env sandbox');
  assert.ok(!seen.includes(fakeToken), 'lọt giá trị OCR_LLM_TOKEN vào env sandbox');
  assert.ok(!seen.includes('DYSTOPIA_UNRELATED'), 'lọt biến ngoài allowlist vào env sandbox');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'MTH_WORKDIR', 'PATH', 'TERM', 'TMPDIR']);
});

test('sandbox-exec chỉ nhận env allowlist: không có key/token', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-sandbox-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'sandbox-exec.sh');
  await writeFile(
    script,
    '#!/usr/bin/env bash\nset -euo pipefail\nenv > "$(dirname "$0")/env.txt"\nexit 0\n',
  );
  await chmod(script, 0o755);

  const fakeKey = 'fake-key-SANDBOX-4b1e';
  const fakeToken = 'fake-token-SANDBOX-9c2d';
  const runner = createSandboxRunner({
    repo: dir,
    script,
    env: {
      ...process.env,
      ...SANDBOX_LEAK_ENV,
      ...GIT_LEAK_ENV,
      MTH_WORKDIR: HOST_MTH_WORKDIR,
      COMMANDCODE_API_KEY: fakeKey,
      OCR_LLM_TOKEN: fakeToken,
      DYSTOPIA_UNRELATED: 'bo',
    },
  });
  const result = await runner('true');
  assert.equal(result.status, 0, result.stderr);

  const seen = await readFile(path.join(dir, 'env.txt'), 'utf8');
  assert.ok(!seen.includes(fakeKey), 'lọt giá trị COMMANDCODE_API_KEY vào sandbox');
  assert.ok(!seen.includes(fakeToken), 'lọt giá trị OCR_LLM_TOKEN vào sandbox');
  assert.ok(!seen.includes('COMMANDCODE_API_KEY'), 'lọt tên COMMANDCODE_API_KEY vào sandbox');
  assert.ok(!seen.includes('OCR_LLM_TOKEN'), 'lọt tên OCR_LLM_TOKEN vào sandbox');
  assert.ok(!seen.includes('DYSTOPIA_UNRELATED'), 'lọt biến ngoài allowlist vào sandbox');
  assertNoSandboxLeak(seen, SANDBOX_LEAK_ENV);
  assertNoSandboxLeak(seen, GIT_LEAK_ENV);
  assert.ok(!seen.includes(HOST_MTH_WORKDIR), 'MTH_WORKDIR của host không được thắng repo');
  assert.match(seen, /^PATH=/m);
  assert.match(seen, /^HOME=/m);
  assert.doesNotMatch(seen, /^GIT_AUTHOR_NAME=/m, 'GIT_* không được truyền vào sandbox');
  assert.match(seen, new RegExp(`^MTH_WORKDIR=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('loadIgnorePatterns: mặc định + rules-overlay/ignore.txt', async (t) => {
  const patterns = loadIgnorePatterns({ env: { DYSTOPIA_HOME: '/khong/co' } });
  assert.ok(patterns.includes('*.lock'));
  assert.ok(patterns.includes('dist/**'));
});

test(
  'git tool chạy thật qua sandbox-exec của MTH (tự skip nếu thiếu)',
  { skip: (() => {
    const home = process.env.MTH_HOME?.trim();
    if (!home) return 'thiếu MTH_HOME';
    if (!existsSync(path.join(home, 'lib', 'sandbox-exec.sh'))) return 'thiếu $MTH_HOME/lib/sandbox-exec.sh';
    return false;
  })() },
  async (t) => {
    const repo = await makeNativeRepo(t, { files: 1 });
    const runner = createSandboxRunner({ repo: repo.dir });
    const probe = await runner('true');
    if (probe.status !== 0) {
      t.skip(`sandbox-exec không chạy được trong môi trường này: ${probe.stderr.trim() || probe.status}`);
      return;
    }
    const tools = createTools({ repo: repo.dir, base: repo.base, head: repo.head, runner });
    const text = await tools.list_changed_files();
    assert.match(text, /src\/file1\.ts/);
    const shown = await tools.git_show({ rev: repo.head, path: 'src/file1.ts' });
    assert.match(shown, /value1b/);
  },
);
