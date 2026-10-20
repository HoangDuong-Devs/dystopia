// Test tool chỉ đọc của engine native: chặn path traversal/tuyệt đối/symlink/.git,
// cắt read_file 400 dòng, git_show chỉ base/head, lọc file lock/sinh tự
// động/binary. Không gọi LLM, không gọi OCR thật.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import { createSandboxRunner, createTools, loadIgnorePatterns } from '../lib/engine/native/tools.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);

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

async function setup(t, options) {
  const repo = await makeNativeRepo(t, options);
  const tools = createTools({ repo: repo.dir, base: repo.base, head: repo.head, runner: localRunner(repo.dir) });
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

test('read_file: đọc file ở head, cắt tối đa 400 dòng và báo', async (t) => {
  const { tools } = await setup(t, { files: 1 });
  const head = await tools.read_file({ path: 'src/file1.ts', from: 1, to: 100 });
  assert.match(head, /src\/file1\.ts \(dòng 1-3\/3\)/);
  assert.match(head, /2: export const value1b = 2;/);

  const capped = await tools.read_file({ path: 'src/big.ts', from: 1, to: 999 });
  assert.match(capped, /^.*\(dòng 1-400\/450\)/);
  assert.match(capped, /400: line 400/);
  assert.doesNotMatch(capped, /401: line 401/);
  assert.match(capped, /cắt về tối đa 400 dòng/);

  const tail = await tools.read_file('src/big.ts', 401, 500);
  assert.match(tail, /\(dòng 401-450\/450\)/);
  assert.match(tail, /450: line 450/);
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

test('grep giới hạn 200 dòng khớp và lọc theo path_glob', async (t) => {
  const { tools } = await setup(t, { files: 2 });
  const result = await tools.grep({ pattern: 'value', path_glob: 'src/file2.ts' });
  assert.match(result, /src\/file2\.ts:2:/);
  assert.doesNotMatch(result, /src\/file1\.ts/);

  const many = await tools.grep({ pattern: 'line', path_glob: 'src/big.ts' });
  assert.equal(many.split('\n').filter((line) => /^src\/big\.ts:\d+:/.test(line)).length, 200);
  assert.match(many, /cắt về tối đa 200 dòng/);
});

test('git_show: chỉ nhận base/head, rev lạ bị từ chối', async (t) => {
  const { repo, tools } = await setup(t, { files: 1 });
  const baseText = await tools.git_show({ rev: repo.base, path: 'src/file1.ts' });
  const headText = await tools.git_show({ rev: repo.head, path: 'src/file1.ts' });
  assert.match(baseText, /value1 = 1/);
  assert.doesNotMatch(baseText, /value1b/);
  assert.match(headText, /value1b/);

  await assert.rejects(
    () => tools.git_show({ rev: 'bogus000', path: 'src/file1.ts' }),
    /rev phải là base .* hoặc head/,
  );
});

test('loadIgnorePatterns: mặc định + rules-overlay/ignore.txt', async (t) => {
  const patterns = loadIgnorePatterns({ env: { DYSTOPIA_HOME: '/khong/co' } });
  assert.ok(patterns.includes('*.lock'));
  assert.ok(patterns.includes('dist/**'));
});

test(
  'git tool chạy thật qua sandbox-exec của MTH (tự skip nếu thiếu)',
  { skip: (() => {
    const home = process.env.CODER_HOME?.trim();
    if (!home) return 'thiếu CODER_HOME';
    if (!existsSync(path.join(home, 'lib', 'sandbox-exec.sh'))) return 'thiếu $CODER_HOME/lib/sandbox-exec.sh';
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
