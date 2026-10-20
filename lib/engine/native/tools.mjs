// Tool chỉ đọc của engine native: read_file, list_changed_files, grep, git_show.
//
// Mọi tool nhận `repo` = worktree đang ở revision head. read_file đọc bằng fs
// trong tiến trình (chặn path traversal, symlink, .git); các lệnh git chạy qua
// sandbox-exec của MTH (CODER_WORKDIR = repo). Không tool nào ghi file hay chạy
// lệnh ngoài git đọc. Chỉ dùng module có sẵn của Node.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EngineError } from '../ocr.mjs';
import { resolveCoderHome } from './coder.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MAX_READ_LINES = 400;
export const MAX_GREP_LINES = 200;
const MAX_OUTPUT = 16 * 1024 * 1024;

export const DEFAULT_IGNORE = Object.freeze([
  '*.lock',
  'package-lock.json',
  'bun.lockb',
  'dist/**',
  '*.min.js',
]);

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
    this.code = 'NATIVE_TOOL';
  }
}

function reject(message) {
  return new ToolError(message);
}

function within(parent, child) {
  const relative = nodePath.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

function checkRelative(raw, { allowEmpty = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    if (allowEmpty && (raw === undefined || raw === null || raw === '')) return '';
    throw reject('path phải là chuỗi khác rỗng');
  }
  if (raw.includes('\0')) throw reject('path chứa ký tự NUL');
  if (nodePath.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw reject(`từ chối đường dẫn tuyệt đối: ${raw}`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw reject(`từ chối path có "..": ${raw}`);
  }
  if (segments.some((segment) => segment === '.git')) {
    throw reject(`từ chối path trong .git: ${raw}`);
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

/**
 * Chặn path ra ngoài repo: đường dẫn tương đối, không `..`, không `.git/`, và
 * realpath (đã giải symlink) phải nằm trong realpath của repo.
 */
export async function resolveRepoPath(repo, raw, { mustExist = true } = {}) {
  const relative = checkRelative(raw);
  let repoReal;
  try {
    repoReal = await realpath(repo);
  } catch {
    throw reject(`repo không tồn tại: ${repo}`);
  }
  const absolute = nodePath.resolve(repoReal, relative);
  if (!within(repoReal, absolute)) throw reject(`path thoát khỏi repo: ${raw}`);
  if (!mustExist) return { absolute, real: absolute, relative };

  let real;
  try {
    real = await realpath(absolute);
  } catch {
    throw reject(`không tìm thấy file trong repo: ${raw}`);
  }
  if (!within(repoReal, real)) throw reject(`từ chối symlink trỏ ra ngoài repo: ${raw}`);
  const info = await stat(real);
  if (!info.isFile()) throw reject(`không phải file thường: ${raw}`);
  return { absolute, real, relative };
}

// Glob của git grep không tồn tại như một path thật, nhưng các đoạn tĩnh (trước
// ký tự glob đầu tiên) vẫn phải không phải symlink trỏ ra ngoài repo.
export async function assertGlobInside(repo, raw) {
  const relative = checkRelative(raw, { allowEmpty: true });
  if (relative === '') return;
  const repoReal = await realpath(repo);
  let current = repoReal;
  for (const segment of relative.split('/')) {
    if (/[*?[]/.test(segment)) break;
    current = nodePath.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      break;
    }
    if (info.isSymbolicLink()) {
      const real = await realpath(current);
      if (!within(repoReal, real)) throw reject(`từ chối symlink trỏ ra ngoài repo: ${raw}`);
    }
  }
}

export function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

export async function readFileAtHead(repo, raw) {
  const resolved = await resolveRepoPath(repo, raw);
  const text = await readFile(resolved.real, 'utf8');
  return { ...resolved, text, lines: countLines(text) };
}

function shellQuote(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function gitCommand(args) {
  return ['git', '--no-pager', ...args].map(shellQuote).join(' ');
}

// Chạy MỘT lệnh bash trong sandbox chỉ đọc của MTH. Không tự viết bwrap.
export function createSandboxRunner(options = {}) {
  const env = options.env ?? process.env;
  const coderHome = options.coderHome ?? resolveCoderHome(env);
  const script = options.script ?? nodePath.join(coderHome, 'lib', 'sandbox-exec.sh');
  const repo = nodePath.resolve(options.repo ?? process.cwd());

  return async function runInSandbox(command) {
    if (!existsSync(script)) {
      throw new EngineError(`không thấy sandbox-exec của MTH: ${script}`, {
        code: 'NATIVE_SANDBOX_MISSING',
        exitCode: 64,
      });
    }
    return new Promise((resolve) => {
      const child = spawn(script, [command], {
        cwd: repo,
        env: { ...env, CODER_WORKDIR: repo },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const collect = (chunk, which) => {
        if (which === 'out') stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > MAX_OUTPUT) child.kill('SIGKILL');
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => collect(chunk, 'out'));
      child.stderr.on('data', (chunk) => collect(chunk, 'err'));
      child.on('error', (error) => {
        resolve({ stdout, stderr: `${stderr}${error.message}`, status: 127 });
      });
      child.on('close', (status) => {
        resolve({ stdout, stderr, status: status ?? 1 });
      });
    });
  };
}

function globToRegExp(pattern) {
  const text = pattern.trim().replace(/^\.\//, '');
  const anchored = text.includes('/');
  let body = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '*') {
      if (text[index + 1] === '*') {
        body += '.*';
        index += 1;
      } else {
        body += '[^/]*';
      }
    } else if (char === '?') {
      body += '[^/]';
    } else {
      body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(anchored ? `^${body}$` : `(?:^|.*/)${body}$`);
}

// Đọc rules-overlay/ignore.txt (nếu có) cộng danh sách mặc định.
export function loadIgnorePatterns(options = {}) {
  const env = options.env ?? process.env;
  const home = env.DYSTOPIA_HOME && env.DYSTOPIA_HOME.trim() !== '' ? env.DYSTOPIA_HOME : ROOT;
  const file = nodePath.join(home, 'rules-overlay', 'ignore.txt');
  const patterns = [...DEFAULT_IGNORE];
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (value !== '' && !value.startsWith('#')) patterns.push(value);
    }
  }
  return patterns;
}

export function ignoredFile(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

export const TOOL_SPECS = Object.freeze([
  {
    name: 'read_file',
    description: 'Đọc tối đa 400 dòng của một file trong repo ở revision head. Trả về số dòng kèm nội dung.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'đường dẫn tương đối trong repo' },
        from: { type: 'integer', minimum: 1, description: 'dòng bắt đầu, mặc định 1' },
        to: { type: 'integer', minimum: 1, description: 'dòng kết thúc, tối đa from + 399' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_changed_files',
    description: 'Liệt kê file thay đổi giữa base và head, kèm trạng thái và số dòng +/-.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'grep',
    description: 'Tìm pattern (regex của git grep) trong repo ở head; trả tối đa 200 dòng khớp.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex cho git grep' },
        path_glob: { type: 'string', description: 'glob giới hạn file, ví dụ src/**/*.ts' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_show',
    description: 'Xem nội dung một file ở revision base hoặc head.',
    parameters: {
      type: 'object',
      properties: {
        rev: { type: 'string', description: 'chỉ nhận base hoặc head' },
        path: { type: 'string', description: 'đường dẫn tương đối trong repo' },
      },
      required: ['rev', 'path'],
    },
  },
]);

function parsePositive(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw reject(`${name} phải là số nguyên ≥ 1`);
  }
  return number;
}

/**
 * Tạo bộ tool cho một repo/revision.
 *
 * @param {Object} options
 * @param {string} options.repo worktree ở revision head
 * @param {string} options.base
 * @param {string} options.head
 * @param {(command: string) => Promise<{stdout: string, stderr: string, status: number}>} [options.runner]
 */
export function createTools(options) {
  const repo = nodePath.resolve(options.repo ?? process.cwd());
  const base = options.base;
  const head = options.head;
  if (typeof base !== 'string' || base === '' || typeof head !== 'string' || head === '') {
    throw new EngineError('engine native cần cả base và head', {
      code: 'NATIVE_RANGE_REQUIRED',
      exitCode: 64,
    });
  }
  const runner = options.runner ?? createSandboxRunner({ repo, env: options.env });
  const ignorePatterns = options.ignorePatterns ?? loadIgnorePatterns({ env: options.env });
  const maxReadLines = options.maxReadLines ?? MAX_READ_LINES;
  const maxGrepLines = options.maxGrepLines ?? MAX_GREP_LINES;

  async function runGit(args, { allowFailure = false } = {}) {
    const command = gitCommand(args);
    const result = await runner(command);
    if (!allowFailure && result.status !== 0) {
      const detail = String(result.stderr ?? '').trim() || `exit ${result.status}`;
      throw new ToolError(`git thất bại: ${detail}`);
    }
    return result;
  }

  // git diff --numstat: "-" ở cột +/- nghĩa là file binary.
  async function changedFiles() {
    const statusResult = await runGit(['diff', '--name-status', '--no-renames', `${base}..${head}`, '--']);
    const numstatResult = await runGit(['diff', '--numstat', '--no-renames', `${base}..${head}`, '--']);
    const counts = new Map();
    for (const line of String(numstatResult.stdout ?? '').split('\n')) {
      if (line.trim() === '') continue;
      const [added, deleted, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (file === '') continue;
      counts.set(file, {
        additions: added === '-' ? null : Number(added),
        deletions: deleted === '-' ? null : Number(deleted),
        binary: added === '-' || deleted === '-',
      });
    }

    const files = [];
    for (const line of String(statusResult.stdout ?? '').split('\n')) {
      if (line.trim() === '') continue;
      const [status, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (file === '') continue;
      const countsForFile = counts.get(file) ?? { additions: null, deletions: null, binary: false };
      if (ignoredFile(file, ignorePatterns) || countsForFile.binary) continue;
      files.push({ file, status: (status ?? '?')[0], ...countsForFile });
    }
    return files;
  }

  // File đã xoá ở head không thể có finding theo dòng head, nên bỏ khỏi danh sách review.
  async function reviewFiles() {
    return (await changedFiles()).filter((entry) => entry.status !== 'D');
  }

  async function diffFor(file) {
    const relative = checkRelative(file);
    const result = await runGit(['diff', '--no-color', '--unified=3', `${base}..${head}`, '--', relative]);
    return String(result.stdout ?? '');
  }

  async function read_file(input, from, to) {
    let params = input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      params = { path: input, from, to };
    }
    const wanted = params.path ?? params.file;
    const start = parsePositive(params.from, 'from', 1);
    const requested = parsePositive(params.to, 'to', start + maxReadLines - 1);
    if (requested < start) throw reject('to phải ≥ from');

    const document = await readFileAtHead(repo, wanted);
    if (document.lines === 0) throw reject(`file rỗng: ${document.relative}`);
    if (start > document.lines) {
      throw reject(`from ${start} vượt quá ${document.lines} dòng của ${document.relative}`);
    }
    const end = Math.min(requested, start + maxReadLines - 1, document.lines);
    const allLines = document.text.split('\n');
    const body = [];
    for (let line = start; line <= end; line += 1) {
      body.push(`${line}: ${allLines[line - 1] ?? ''}`);
    }
    const capped = requested > start + maxReadLines - 1 && document.lines > start + maxReadLines - 1;
    const note = capped ? `\n(đã cắt về tối đa ${maxReadLines} dòng mỗi lần)` : '';
    return `${document.relative} (dòng ${start}-${end}/${document.lines}):\n${body.join('\n')}${note}`;
  }

  async function list_changed_files() {
    const files = await changedFiles();
    if (files.length === 0) return 'không có file thay đổi (đã bỏ file lock/sinh tự động/binary)';
    return files
      .map((entry) => {
        const added = entry.additions === null ? '-' : `+${entry.additions}`;
        const deleted = entry.deletions === null ? '-' : `-${entry.deletions}`;
        return `${entry.status}\t${entry.file}\t${added}\t${deleted}`;
      })
      .join('\n');
  }

  async function grep(input, pathGlob) {
    let params = input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      params = { pattern: input, path_glob: pathGlob };
    }
    const pattern = params.pattern;
    if (typeof pattern !== 'string' || pattern === '') throw reject('pattern phải là chuỗi khác rỗng');
    const glob = checkRelative(params.path_glob ?? params.glob ?? '', { allowEmpty: true });
    await assertGlobInside(repo, glob);
    const args = ['grep', '-n', '-I', '--no-color', '-e', pattern, '--'];
    if (glob !== '') args.push(glob);
    const result = await runGit(args, { allowFailure: true });
    if (result.status === 1) return 'không có dòng nào khớp';
    if (result.status !== 0) {
      throw reject(`git grep thất bại: ${String(result.stderr ?? '').trim() || `exit ${result.status}`}`);
    }
    const lines = String(result.stdout ?? '').split('\n').filter((line) => line !== '');
    if (lines.length > maxGrepLines) {
      return `${lines.slice(0, maxGrepLines).join('\n')}\n(đã cắt về tối đa ${maxGrepLines} dòng khớp)`;
    }
    return lines.join('\n');
  }

  async function git_show(input, file) {
    let params = input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      params = { rev: input, path: file };
    }
    const rev = params.rev;
    if (rev !== base && rev !== head) {
      throw reject(`rev phải là base (${base}) hoặc head (${head}), nhận ${JSON.stringify(rev)}`);
    }
    const relative = checkRelative(params.path ?? params.file);
    // File có thể chỉ tồn tại ở base (đã xoá ở head), nên không bắt buộc có trên đĩa;
    // vẫn kiểm symlink của các đoạn đang tồn tại và để git tự giới hạn trong repo.
    await assertGlobInside(repo, relative);
    const result = await runGit(['show', `${rev}:${relative}`], { allowFailure: true });
    if (result.status !== 0) {
      throw reject(`git show ${rev}:${relative} thất bại: ${String(result.stderr ?? '').trim()}`);
    }
    return String(result.stdout ?? '');
  }

  return {
    repo,
    base,
    head,
    ignorePatterns,
    runner,
    runGit,
    changedFiles,
    reviewFiles,
    diffFor,
    read_file,
    list_changed_files,
    grep,
    git_show,
    specs: TOOL_SPECS,
  };
}
