// Adapter OCR (OpenCodeReview) cho hợp đồng engine của Dystopia.
//
// Chạy binary OCR với `review --format json --output <tmp> --from base --to head`
// (cộng `--rule` như wrapper cũ), cwd = repo, rồi chuyển output thô qua
// lib/normalize.mjs. Toàn bộ logic chạy OCR + chuẩn hóa của wrapper bash cũ nằm ở
// đây; wrapper chỉ còn gọi qua node.
//
// Chỉ dùng module có sẵn của Node, không phụ thuộc gói ngoài.

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { normalize } from '../normalize.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAX_BUFFER = 32 * 1024 * 1024;
const RULE_RE = /^--rule(?:=|$)/;

export const NAME = 'ocr';

// Lỗi của hợp đồng engine. Đặt ở đây để index.mjs re-export mà không tạo vòng
// import index → ocr → index.
export class EngineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = options.code ?? 'ENGINE_ERROR';
    this.exitCode = options.exitCode ?? 1;
  }
}

// DYSTOPIA_HOME do wrapper đặt; chạy trực tiếp từ node thì lấy gốc repo.
export function ocrHome() {
  const home = process.env.DYSTOPIA_HOME;
  return home && home.trim() !== '' ? home : ROOT;
}

export function defaultBin() {
  const bin = process.env.DYSTOPIA_OCR_BIN;
  return bin && bin.trim() !== '' ? bin : path.join(ROOT, 'bin', 'opencodereview');
}

export function missingBinMessage() {
  return `chưa build, chạy ${path.join(ocrHome(), 'install.sh')}`;
}

export function readVersion(root = ROOT) {
  try {
    const value = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export function hasRuleArg(args) {
  return args.some((arg) => RULE_RE.test(arg));
}

// Wrapper cũ tự thêm --rule overlay khi người gọi không truyền --rule nào.
export function overlayRulePaths(args = []) {
  if (hasRuleArg(args)) return [];
  const file = path.join(ocrHome(), 'rules-overlay', 'rule.json');
  return existsSync(file) ? [file] : [];
}

// rules của hợp đồng (danh sách file) thắng; rỗng thì dùng overlay như cũ.
export function ruleArgs(rules, args = []) {
  if (Array.isArray(rules) && rules.length > 0) return rules.map((rule) => String(rule));
  return overlayRulePaths(args);
}

export function rangeArgs(options = {}) {
  const base = typeof options.base === 'string' ? options.base : '';
  const head = typeof options.head === 'string' ? options.head : '';
  if (base === '' || head === '') return [];
  return ['--from', base, '--to', head];
}

// Đường --raw chạy thẳng binary: bỏ cờ --raw/--text của wrapper (cờ --engine,
// --dir đã bị CLI tách ra trước khi tới đây).
export function passthroughArgs(args, { raw = false } = {}) {
  if (!raw) return [...args];
  return args.filter((arg) => arg !== '--raw' && arg !== '--text');
}

function ensureBin(bin) {
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new EngineError(missingBinMessage(), { code: 'OCR_MISSING', exitCode: 127 });
  }
}

// Lỗi của OCR phải giữ nguyên exit code như wrapper cũ và không in thêm dòng
// nào: stderr của OCR đã được chuyển tiếp nguyên văn.
function ocrFailure(error) {
  const exitCode = typeof error?.code === 'number' ? error.code : 1;
  const quiet = typeof error?.code === 'number';
  const failure = new EngineError(quiet ? '' : `không chạy được OCR: ${error?.message ?? error}`, {
    code: 'OCR_FAILED',
    exitCode: quiet ? exitCode : 127,
  });
  failure.quiet = quiet;
  return failure;
}

/**
 * Chạy OCR cho hợp đồng engine.
 *
 * Ngoài các trường chung, adapter nhận thêm:
 * - `args`: cờ OCR chuyển tiếp nguyên văn (`-c`, `-p`, `--rule`, ...).
 * - `bin`: binary OCR (mặc định DYSTOPIA_OCR_BIN hoặc bin/opencodereview).
 * - `version`: giá trị meta.version (mặc định DYSTOPIA_VERSION rồi tới VERSION).
 *
 * @param {import('./index.mjs').ReviewOptions & {args?: string[], bin?: string, version?: string}} options
 * @returns {Promise<import('./index.mjs').ReviewResult>}
 */
export async function review(options = {}) {
  const repo = typeof options.repo === 'string' && options.repo !== '' ? path.resolve(options.repo) : process.cwd();
  const bin = typeof options.bin === 'string' && options.bin !== '' ? options.bin : defaultBin();
  const extraArgs = Array.isArray(options.args) ? options.args.map((arg) => String(arg)) : [];
  ensureBin(bin);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dystopia-'));
  const tmp = path.join(dir, 'ocr.json');
  const argv = [
    'review',
    '--format',
    'json',
    '--output',
    tmp,
    ...ruleArgs(options.rules, extraArgs).flatMap((rule) => ['--rule', rule]),
    ...rangeArgs(options),
    ...extraArgs,
  ];

  const started = process.hrtime.bigint();
  try {
    const { stdout } = await execFileAsync(bin, argv, { cwd: repo, env: process.env, maxBuffer: MAX_BUFFER });
    // Wrapper cũ chuyển stdout của OCR sang stderr để stdout chỉ còn JSON.
    if (stdout) process.stderr.write(stdout);
  } catch (error) {
    if (error?.stdout) process.stderr.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    await rm(dir, { recursive: true, force: true });
    throw ocrFailure(error);
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  let raw;
  try {
    raw = await readFile(tmp, 'utf8');
  } catch {
    raw = '';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (raw === '') {
    throw new EngineError(`OCR không ghi output vào ${tmp}`, { code: 'OCR_NO_OUTPUT', exitCode: 1 });
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new EngineError(`output OCR hỏng JSON: ${error.message}`, { code: 'OCR_BAD_JSON', exitCode: 1 });
  }

  const version = options.version ?? process.env.DYSTOPIA_VERSION ?? readVersion();
  const normalized = normalize(doc, { base: options.base, head: options.head, durationMs, version });
  return { findings: normalized.findings, meta: { ...normalized.meta, engine: NAME } };
}
