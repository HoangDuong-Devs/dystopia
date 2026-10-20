// Tool chỉ đọc của engine native: read_file, list_changed_files, grep, git_show.
//
// Mọi tool đọc nội dung của revision head qua git (không đọc đĩa), nên checkout
// của `--dir` có thể ở commit khác head. Đường dẫn được kiểm theo cây git của
// head (không `..`, không tuyệt đối, không `.git`, không symlink); các lệnh git
// chạy qua sandbox-exec của MTH (CODER_WORKDIR = repo). Không tool nào ghi file
// hay chạy lệnh ngoài git đọc. Chỉ dùng module có sẵn của Node.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EngineError } from '../ocr.mjs';
import { sandboxScriptPath } from './config.mjs';
import { LIMITS } from './limits.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MAX_READ_LINES = LIMITS.readLines;
export const MAX_GREP_LINES = LIMITS.grepLines;
const MAX_OUTPUT = 16 * 1024 * 1024;
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const SANDBOX_ENV_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODER_WORKDIR']);

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

const FULL_SHA_RE = /^[0-9a-f]{40,64}$/;

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

export function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Chuẩn hóa một revision (có thể là tên nhánh/tag) thành sha đầy đủ bằng git.
 */
export async function resolveCommit(runGit, rev) {
  if (typeof rev !== 'string' || rev.trim() === '' || rev.trim().startsWith('-')) {
    throw new EngineError(`revision không hợp lệ: ${JSON.stringify(rev)}`, {
      code: 'NATIVE_BAD_REV',
      exitCode: 64,
    });
  }
  const result = await runGit(['rev-parse', '--verify', `${rev.trim()}^{commit}`], { allowFailure: true });
  const sha = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !FULL_SHA_RE.test(sha)) {
    const detail = String(result.stderr ?? '').trim() || `exit ${result.status}`;
    throw new EngineError(`không xác định được revision ${JSON.stringify(rev)} trong repo: ${detail}`, {
      code: 'NATIVE_BAD_REV',
      exitCode: 64,
    });
  }
  return sha;
}

/**
 * Đọc cây của MỘT revision qua git, không đụng đĩa. Mọi đường dẫn được kiểm
 * theo entry trong cây đó: chặn `..`/tuyệt đối/`.git`, đòi đường dẫn là file
 * thường và từ chối symlink trong cây (không bao giờ đi theo symlink ra đĩa).
 */
export function createTreeReader({ rev, runGit }) {
  async function objectType(relative) {
    const result = await runGit(['cat-file', '-t', `${rev}:${relative}`], { allowFailure: true });
    if (result.status !== 0) return null;
    return String(result.stdout ?? '').trim();
  }

  async function treeEntry(relative) {
    const result = await runGit(['ls-tree', '-z', rev, '--', relative], { allowFailure: true });
    if (result.status !== 0) return null;
    for (const record of String(result.stdout ?? '').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0 || record.slice(tab + 1) !== relative) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      return { mode, type, oid };
    }
    return null;
  }

  function rejectSymlink(relative) {
    return reject(`từ chối symlink trong ${rev}: ${relative}`);
  }

  async function guardPath(raw, { mustExist = true } = {}) {
    const relative = checkRelative(raw);
    const parts = relative.split('/');
    let prefix = '';
    for (let index = 0; index < parts.length; index += 1) {
      prefix = prefix === '' ? parts[index] : `${prefix}/${parts[index]}`;
      const last = index === parts.length - 1;
      const type = await objectType(prefix);
      if (type === null) {
        if (mustExist) throw reject(`không tìm thấy file trong ${rev}: ${relative}`);
        return relative;
      }
      if (!last && type !== 'tree') {
        const item = type === 'blob' ? await treeEntry(prefix) : null;
        if (item?.mode === '120000') throw rejectSymlink(relative);
        throw reject(`không phải thư mục trong ${rev}: ${prefix}`);
      }
      if (last) {
        if (type === 'tree') throw reject(`không phải file thường trong ${rev}: ${relative}`);
        const item = await treeEntry(relative);
        if (!item || item.type !== 'blob') throw reject(`không phải file thường trong ${rev}: ${relative}`);
        if (item.mode === '120000') throw rejectSymlink(relative);
      }
    }
    return relative;
  }

  // Glob của git grep không tồn tại như một path thật; các đoạn tĩnh trước ký
  // tự glob đầu tiên vẫn phải trỏ tới entry không phải symlink trong cây.
  async function guardGlob(raw) {
    const relative = checkRelative(raw, { allowEmpty: true });
    if (relative === '') return '';
    const staticParts = [];
    for (const part of relative.split('/')) {
      if (/[*?[]/.test(part)) break;
      staticParts.push(part);
    }
    let prefix = '';
    for (let index = 0; index < staticParts.length; index += 1) {
      prefix = prefix === '' ? staticParts[index] : `${prefix}/${staticParts[index]}`;
      const last = index === staticParts.length - 1;
      const type = await objectType(prefix);
      if (type === null) return relative;
      if (!last && type !== 'tree') {
        const item = type === 'blob' ? await treeEntry(prefix) : null;
        if (item?.mode === '120000') throw rejectSymlink(relative);
        return relative;
      }
      if (last) {
        const item = await treeEntry(prefix);
        if (item?.mode === '120000') throw rejectSymlink(relative);
      }
    }
    return relative;
  }

  async function read(raw) {
    const relative = await guardPath(raw);
    const result = await runGit(['cat-file', '-p', `${rev}:${relative}`]);
    const text = String(result.stdout ?? '');
    return { relative, text, lines: countLines(text) };
  }

  return { rev, guardPath, guardGlob, read };
}

// Env cho sandbox-exec: chỉ biến cần thiết, không bao giờ chuyển key/token.
export function sandboxEnv(env, workdir) {
  const allowed = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null) continue;
    if (SECRET_ENV_NAME.test(name)) continue;
    if (SANDBOX_ENV_NAMES.has(name) || name.startsWith('GIT_') || name.startsWith('CODER_')) {
      allowed[name] = String(value);
    }
  }
  allowed.CODER_WORKDIR = workdir;
  return allowed;
}

function shellQuote(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function gitCommand(args) {
  return ['git', '--no-pager', ...args].map(shellQuote).join(' ');
}

// Bọc runner sandbox thành runGit: lệnh lỗi thì ném ToolError (trừ allowFailure).
export function createGitRunner(runner) {
  return async function runGit(args, { allowFailure = false } = {}) {
    const result = await runner(gitCommand(args));
    if (!allowFailure && result.status !== 0) {
      const detail = String(result.stderr ?? '').trim() || `exit ${result.status}`;
      throw new ToolError(`git thất bại: ${detail}`);
    }
    return result;
  };
}

// Chạy MỘT lệnh bash trong sandbox chỉ đọc của MTH. Không tự viết bwrap.
export function createSandboxRunner(options = {}) {
  const env = options.env ?? process.env;
  const script = options.script ?? sandboxScriptPath(env);
  const repo = nodePath.resolve(options.repo ?? process.cwd());

  return async function runInSandbox(command) {
    if (!existsSync(script)) {
      throw new EngineError(
        `không thấy sandbox-exec của MTH tại ${script}: CODER_HOME phải trỏ tới thư mục cài MTH có lib/sandbox-exec.sh`,
        {
          code: 'NATIVE_SANDBOX_MISSING',
          exitCode: 64,
        },
      );
    }
    return new Promise((resolve) => {
      const child = spawn(script, [command], {
        cwd: repo,
        env: sandboxEnv(env, repo),
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
    description:
      'Đọc một file trong repo ở revision head. Không truyền from/to thì mặc định đọc quanh các hunk ' +
      'của diff (mỗi hunk ±40 dòng) hoặc 150 dòng đầu với file không đổi. Mỗi lần tối đa 150 dòng và ~12000 ký tự.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'đường dẫn tương đối trong repo' },
        from: { type: 'integer', minimum: 1, description: 'dòng bắt đầu (1-based), mặc định theo cửa sổ diff' },
        to: { type: 'integer', minimum: 1, description: 'dòng kết thúc (1-based, bao gồm), tối đa from + 149' },
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
    description: 'Tìm pattern (regex của git grep) trong repo ở head; trả tối đa 60 dòng khớp và ~8000 ký tự.',
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
    description: 'Xem nội dung một file ở revision base hoặc head; tối đa 200 dòng và ~12000 ký tự.',
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
 * @param {string} options.repo worktree của `--dir` (nội dung luôn đọc theo head, không theo đĩa)
 * @param {string} options.base
 * @param {string} options.head sha đầy đủ của revision head
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
  if (!FULL_SHA_RE.test(head)) {
    throw new EngineError(`engine native cần head là sha đầy đủ, nhận ${JSON.stringify(head)}`, {
      code: 'NATIVE_BAD_REV',
      exitCode: 64,
    });
  }
  const runner = options.runner ?? createSandboxRunner({ repo, env: options.env });
  const runGit = createGitRunner(runner);
  const headTree = createTreeReader({ rev: head, runGit });
  const ignorePatterns = options.ignorePatterns ?? loadIgnorePatterns({ env: options.env });
  const maxReadLines = options.maxReadLines ?? MAX_READ_LINES;
  const maxReadChars = options.maxReadChars ?? LIMITS.readChars;
  const maxGrepLines = options.maxGrepLines ?? MAX_GREP_LINES;
  const maxGrepChars = options.maxGrepChars ?? LIMITS.grepChars;
  const maxShowLines = options.maxShowLines ?? LIMITS.showLines;
  const maxShowChars = options.maxShowChars ?? LIMITS.showChars;

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

  let changedSet = null;
  async function isChanged(file) {
    if (changedSet === null) {
      changedSet = changedFiles().then((entries) => new Set(entries.map((entry) => entry.file)));
    }
    return (await changedSet).has(file);
  }

  // Các hunk của diff, quy về dải dòng phía head rồi nới ±40 và gộp các dải chồng nhau.
  const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  function diffWindows(text) {
    const windows = [];
    for (const line of String(text).split('\n')) {
      const match = HUNK_RE.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      const from = Math.max(1, start - LIMITS.diffContext);
      const to = Math.max(from, start + Math.max(count, 1) - 1 + LIMITS.diffContext);
      const previous = windows[windows.length - 1];
      if (previous && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
      else windows.push({ from, to });
    }
    return windows;
  }

  const defaultWindows = new Map();
  async function defaultWindow(file, lines) {
    if (!(await isChanged(file))) {
      return { from: 1, to: Math.min(lines, LIMITS.unchangedLines) };
    }
    if (!defaultWindows.has(file)) {
      defaultWindows.set(
        file,
        diffFor(file).then((diff) => {
          const windows = diffWindows(diff);
          const first = windows[0];
          if (!first) return { from: 1, to: LIMITS.readLines };
          const last = windows[windows.length - 1];
          const span = last.to - first.from + 1;
          return {
            from: first.from,
            to: span <= LIMITS.readLines ? last.to : first.from + LIMITS.readLines - 1,
          };
        }),
      );
    }
    const window = await defaultWindows.get(file);
    return { from: Math.min(window.from, lines), to: Math.min(window.to, lines) };
  }

  async function read_file(input, from, to) {
    let params = input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      params = { path: input, from, to };
    }
    const wanted = params.path ?? params.file;
    const hasFrom = params.from !== undefined && params.from !== null && params.from !== '';
    const hasTo = params.to !== undefined && params.to !== null && params.to !== '';
    const explicitRange = hasFrom || hasTo;

    const document = await headTree.read(wanted);
    if (document.lines === 0) throw reject(`file rỗng: ${document.relative}`);

    let start;
    let requested;
    if (!hasFrom && !hasTo) {
      const window = await defaultWindow(document.relative, document.lines);
      start = window.from;
      requested = window.to;
    } else {
      start = parsePositive(params.from, 'from', 1);
      requested = parsePositive(params.to, 'to', start + maxReadLines - 1);
      if (requested < start) throw reject('to phải ≥ from');
    }
    if (start > document.lines) {
      throw reject(`from ${start} vượt quá ${document.lines} dòng của ${document.relative}`);
    }

    const wantedEnd = Math.min(requested, document.lines);
    const lastAllowed = Math.min(wantedEnd, start + maxReadLines - 1);
    const allLines = document.text.split('\n');
    const body = [];
    let chars = 0;
    let end = start - 1;
    for (let line = start; line <= lastAllowed; line += 1) {
      const content = `${line}: ${allLines[line - 1] ?? ''}`;
      if (chars + content.length + (body.length > 0 ? 1 : 0) > maxReadChars) {
        if (body.length === 0) {
          body.push(content.slice(0, maxReadChars));
          end = line;
        }
        break;
      }
      body.push(content);
      chars += content.length + 1;
      end = line;
    }
    const cut = end < wantedEnd || (!explicitRange && end < document.lines);
    const note = cut
      ? `\n[đã cắt: dòng ${start}-${end}; gọi lại với from/to] (tổng ${document.lines} dòng)`
      : '';
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
    const glob = await headTree.guardGlob(params.path_glob ?? params.glob ?? '');
    const args = ['grep', '-n', '-I', '--no-color', '-e', pattern, head, '--'];
    if (glob !== '') args.push(glob);
    const result = await runGit(args, { allowFailure: true });
    if (result.status === 1) return 'không có dòng nào khớp';
    if (result.status !== 0) {
      throw reject(`git grep thất bại: ${String(result.stderr ?? '').trim() || `exit ${result.status}`}`);
    }
    // git grep trên tree-ish in "<rev>:<path>:<line>:<content>"; bỏ tiền tố head.
    const prefix = `${head}:`;
    const lines = String(result.stdout ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
    const shown = [];
    let chars = 0;
    for (const line of lines) {
      if (shown.length >= maxGrepLines || chars + line.length + (shown.length > 0 ? 1 : 0) > maxGrepChars) break;
      shown.push(line);
      chars += line.length + 1;
    }
    if (shown.length < lines.length) {
      return `${shown.join('\n')}\n[đã cắt: hiển thị ${shown.length}/${lines.length} dòng khớp; thu hẹp pattern/path_glob]`;
    }
    return shown.join('\n');
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
    const reader = rev === head ? headTree : createTreeReader({ rev, runGit });
    const relative = await reader.guardPath(params.path ?? params.file, { mustExist: false });
    const result = await runGit(['show', `${rev}:${relative}`], { allowFailure: true });
    if (result.status !== 0) {
      throw reject(`git show ${rev}:${relative} thất bại: ${String(result.stderr ?? '').trim()}`);
    }
    const lines = String(result.stdout ?? '').split('\n');
    const shown = [];
    let chars = 0;
    for (const line of lines) {
      if (shown.length >= maxShowLines || chars + line.length + (shown.length > 0 ? 1 : 0) > maxShowChars) break;
      shown.push(line);
      chars += line.length + 1;
    }
    const body = shown.join('\n');
    if (shown.length < lines.length) {
      return `${body}\n[đã cắt: hiển thị ${shown.length}/${lines.length} dòng; dùng read_file với from/to để xem tiếp]`;
    }
    return body;
  }

  return {
    repo,
    base,
    head,
    headTree,
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
