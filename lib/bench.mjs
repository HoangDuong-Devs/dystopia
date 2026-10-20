// Bộ đo `dystopia bench`: chạy reviewer trên từng case (base..head), chấm finding
// theo bug mong đợi, in bảng và ghi kết quả ra ngoài repo.
// Chỉ dùng module có sẵn của Node, không phụ thuộc gói ngoài.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { assertValidResult, getEngine } from './engine/index.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const DEFAULT_MAX_RANK = 5;
const DEFAULT_MIN_HIT_RATE = 1.0;
const SEVERITY_MEDIUM = 'nên sửa';

export class ConfigError extends Error {
  constructor(caseName, field, detail) {
    super(`case "${caseName}": trường "${field}" ${detail}`);
    this.name = 'ConfigError';
    this.caseName = caseName;
    this.field = field;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

// Chuẩn hóa một case và kiểm cấu hình. Case disabled được bỏ qua hoàn toàn
// (không cần kiểm các trường còn lại).
export function validateCase(raw, label = '?') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(label, 'case', 'phải là một object JSON');
  }
  if (raw.disabled === true) {
    const id = nonEmptyString(raw.id) ? raw.id : label;
    return { id, disabled: true };
  }

  const name = nonEmptyString(raw.id) ? raw.id : label;
  if (!nonEmptyString(raw.id)) throw new ConfigError(name, 'id', 'bắt buộc và phải là chuỗi khác rỗng');
  if (!nonEmptyString(raw.repo)) throw new ConfigError(name, 'repo', 'bắt buộc và phải là chuỗi khác rỗng');
  if (!nonEmptyString(raw.head)) throw new ConfigError(name, 'head', 'bắt buộc và phải là chuỗi khác rỗng');
  if (!nonEmptyString(raw.base)) {
    throw new ConfigError(name, 'base', 'bắt buộc, phải là SHA hex 7–40 ký tự (không tự lấy commit cha)');
  }
  if (!SHA_RE.test(raw.base)) {
    throw new ConfigError(name, 'base', `phải là SHA hex 7–40 ký tự, nhận được ${JSON.stringify(raw.base)}`);
  }
  if (!Array.isArray(raw.expect_bugs)) {
    throw new ConfigError(name, 'expect_bugs', 'phải là mảng');
  }

  const maxRank = raw.max_rank ?? DEFAULT_MAX_RANK;
  if (!Number.isInteger(maxRank) || maxRank < 1) {
    throw new ConfigError(name, 'max_rank', 'phải là số nguyên ≥ 1');
  }
  const minHitRate = raw.min_hit_rate ?? DEFAULT_MIN_HIT_RATE;
  if (typeof minHitRate !== 'number' || !Number.isFinite(minHitRate) || minHitRate < 0 || minHitRate > 1) {
    throw new ConfigError(name, 'min_hit_rate', 'phải là số trong khoảng 0–1');
  }
  const forbidSeverity = raw.forbid_severity ?? [];
  if (!Array.isArray(forbidSeverity) || forbidSeverity.some((item) => typeof item !== 'string')) {
    throw new ConfigError(name, 'forbid_severity', 'phải là mảng chuỗi');
  }

  const expectBugs = raw.expect_bugs.map((bug, index) => {
    const field = `expect_bugs[${index}]`;
    if (!bug || typeof bug !== 'object' || Array.isArray(bug)) {
      throw new ConfigError(name, field, 'phải là một object');
    }
    const match = bug.match ?? 'lines';
    if (match !== 'lines' && match !== 'file') {
      throw new ConfigError(name, `${field}.match`, `chỉ nhận "lines" hoặc "file", nhận được ${JSON.stringify(match)}`);
    }

    const id = nonEmptyString(bug.id) ? bug.id : `bug-${index + 1}`;
    let file;
    if (match === 'lines') {
      if (!nonEmptyString(bug.file) || Array.isArray(bug.file)) {
        throw new ConfigError(name, `${field}.file`, 'với match "lines" phải là chuỗi khác rỗng');
      }
      file = bug.file;
      if (!Number.isInteger(bug.line_from)) {
        throw new ConfigError(name, `${field}.line_from`, 'với match "lines" phải là số nguyên');
      }
      if (!Number.isInteger(bug.line_to)) {
        throw new ConfigError(name, `${field}.line_to`, 'với match "lines" phải là số nguyên');
      }
    } else {
      const files = Array.isArray(bug.file) ? bug.file : [bug.file];
      if (files.length === 0 || files.some((item) => !nonEmptyString(item))) {
        throw new ConfigError(name, `${field}.file`, 'với match "file" phải là chuỗi hoặc mảng chuỗi khác rỗng');
      }
      file = bug.file;
      if (bug.line_from !== undefined && bug.line_from !== null) {
        throw new ConfigError(name, `${field}.line_from`, 'với match "file" phải là null hoặc vắng');
      }
      if (bug.line_to !== undefined && bug.line_to !== null) {
        throw new ConfigError(name, `${field}.line_to`, 'với match "file" phải là null hoặc vắng');
      }
    }

    return {
      id,
      file,
      files: match === 'file' ? (Array.isArray(file) ? [...file] : [file]) : [file],
      match,
      line_from: match === 'lines' ? bug.line_from : null,
      line_to: match === 'lines' ? bug.line_to : null,
      desc: typeof bug.desc === 'string' ? bug.desc : null,
    };
  });

  return {
    id: name,
    repo: raw.repo,
    base: raw.base,
    head: raw.head,
    expect_bugs: expectBugs,
    max_rank: maxRank,
    forbid_severity: [...forbidSeverity],
    min_hit_rate: minHitRate,
    disabled: false,
  };
}

// Chấm một lần chạy. Findings đã được normalize sắp xếp sẵn; rank là chỉ số 1-based.
// Dòng finding là phía HEAD (normalize đảm bảo).
export function scoreRun(caseCfg, result) {
  const findings = result && Array.isArray(result.findings) ? result.findings : [];
  const condensed = findings.map((finding, index) => ({
    file: typeof finding?.file === 'string' ? finding.file : null,
    line: integerOrNull(finding?.line),
    severity: typeof finding?.severity === 'string' ? finding.severity : null,
    rank: index + 1,
  }));

  const bugs = caseCfg.expect_bugs.map((bug) => {
    let hit = false;
    for (let index = 0; index < findings.length; index += 1) {
      const rank = index + 1;
      if (rank > caseCfg.max_rank) break;
      const finding = findings[index] ?? {};
      if (bug.match === 'file') {
        if (bug.files.includes(finding.file)) {
          hit = true;
          break;
        }
        continue;
      }
      if (finding.file !== bug.file) continue;
      const line = integerOrNull(finding.line);
      if (line === null) continue;
      const endLine = integerOrNull(finding.end_line) ?? line;
      const from = bug.line_from - 10;
      const to = bug.line_to + 10;
      if (line <= to && endLine >= from) {
        hit = true;
        break;
      }
    }
    return { id: bug.id, hit };
  });

  const forbidden = findings.filter((finding) => caseCfg.forbid_severity.includes(finding?.severity)).length;
  const medium = findings.filter((finding) => finding?.severity === SEVERITY_MEDIUM).length;

  return { findings: condensed, bugs, forbidden, medium };
}

export function resolveBenchDir() {
  return process.env.DYSTOPIA_BENCH_DIR || path.join(os.homedir(), 'firemoth', 'tools', 'dystopia-bench');
}

function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function tokensOf(result) {
  const meta = result && typeof result.meta === 'object' ? result.meta : {};
  const input = Number.isFinite(meta.tokens_in) ? meta.tokens_in : null;
  const output = Number.isFinite(meta.tokens_out) ? meta.tokens_out : null;
  return { in: input, out: output };
}

function errorMessage(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const code = error?.code !== undefined ? ` (exit ${error.code})` : '';
  const main = stderr || error?.message || String(error);
  return `${main}${code}`;
}

async function runReviewerOnce(caseCfg, worktree, runIndex) {
  const reviewer = process.env.DYSTOPIA_BENCH_REVIEWER || path.join(ROOT, 'dystopia');
  const outputFile = path.join(
    os.tmpdir(),
    `fm-fx-bench-${sanitizeId(caseCfg.id)}-${process.pid}-${runIndex}-${Date.now()}.json`,
  );
  const args = ['review', '--from', caseCfg.base, '--to', caseCfg.head, '--output', outputFile];
  const started = Date.now();
  try {
    await execFileAsync(reviewer, args, { cwd: worktree, maxBuffer: 16 * 1024 * 1024 });
    const duration = Date.now() - started;
    let result;
    try {
      result = JSON.parse(await readFile(outputFile, 'utf8'));
    } catch (error) {
      throw new Error(`output reviewer hỏng JSON: ${error.message}`);
    }
    if (!result || !Array.isArray(result.findings)) {
      throw new Error('output reviewer thiếu mảng findings');
    }
    const scored = scoreRun(caseCfg, result);
    return {
      findings: scored.findings,
      bugs: scored.bugs,
      forbidden: scored.forbidden,
      medium: scored.medium,
      tokens: tokensOf(result),
      duration_ms: duration,
      error: null,
    };
  } catch (error) {
    return failedRun(caseCfg, started, error);
  } finally {
    await rm(outputFile, { force: true }).catch(() => {});
  }
}

function failedRun(caseCfg, started, error) {
  return {
    findings: [],
    bugs: caseCfg.expect_bugs.map((bug) => ({ id: bug.id, hit: false })),
    forbidden: 0,
    medium: 0,
    tokens: { in: null, out: null },
    duration_ms: Date.now() - started,
    error: errorMessage(error),
  };
}

// Đường mặc định: gọi engine qua hợp đồng chung, không qua wrapper bash.
async function runEngineOnce(engine, caseCfg, worktree, limits = {}) {
  const started = Date.now();
  try {
    const result = assertValidResult(
      await engine.review({
        repo: worktree,
        base: caseCfg.base,
        head: caseCfg.head,
        rules: [],
        limits,
      }),
    );
    const duration = Number.isFinite(result.meta?.duration_ms) ? result.meta.duration_ms : Date.now() - started;
    const scored = scoreRun(caseCfg, result);
    return {
      findings: scored.findings,
      bugs: scored.bugs,
      forbidden: scored.forbidden,
      medium: scored.medium,
      tokens: tokensOf(result),
      duration_ms: duration,
      error: null,
    };
  } catch (error) {
    return failedRun(caseCfg, started, error);
  }
}

async function runOnce(caseCfg, worktree, runIndex, engine, limits = {}) {
  if (process.env.DYSTOPIA_BENCH_REVIEWER) {
    return runReviewerOnce(caseCfg, worktree, runIndex);
  }
  return runEngineOnce(engine, caseCfg, worktree, limits);
}

// Chạy một case N lần trong worktree detached; worktree luôn bị xóa ở finally.
export async function runCase(caseCfg, runs, engine = null, limits = {}) {
  const worktree = path.join(os.tmpdir(), `fm-fx-bench-${sanitizeId(caseCfg.id)}-${process.pid}`);
  const results = [];
  try {
    await execFileAsync('git', ['-C', caseCfg.repo, 'worktree', 'add', '--detach', worktree, caseCfg.head], {
      maxBuffer: 16 * 1024 * 1024,
    });
    for (let index = 0; index < runs; index += 1) {
      results.push(await runOnce(caseCfg, worktree, index, engine, limits));
    }
    return { worktree, results };
  } catch (error) {
    return { worktree, addError: errorMessage(error), results };
  } finally {
    await execFileAsync('git', ['-C', caseCfg.repo, 'worktree', 'remove', '--force', worktree], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => {});
  }
}

function formatRate(rate) {
  return String(Number(rate.toFixed(2)));
}

// Ngưỡng số lần trúng cho một bug. `min_hit_rate` cấu hình theo 2 chữ số thập
// phân (2/3 = 0.67), nên trừ một dung sai nhỏ trước khi ceil: 0.67 × 3 = 2.01 →
// cần 2 lần, còn 0.7 × 3 = 2.1 → cần 3 lần. Dung sai tối đa 0.01 và không vượt
// nửa ngưỡng để min_hit_rate dương luôn cần ít nhất 1 lần trúng. Tỉ lệ in ra vẫn
// là hits/runs.
export function requiredHits(minHitRate, runs) {
  if (!Number.isFinite(runs) || runs <= 0 || minHitRate <= 0) return 0;
  const tolerance = Math.min(0.01, (minHitRate * runs) / 2);
  return Math.max(1, Math.ceil(minHitRate * runs - tolerance - 1e-9));
}

function sumTokens(results) {
  let input = null;
  let output = null;
  for (const run of results) {
    if (Number.isFinite(run.tokens?.in)) input = (input ?? 0) + run.tokens.in;
    if (Number.isFinite(run.tokens?.out)) output = (output ?? 0) + run.tokens.out;
  }
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

export function summarize(caseCfg, runs, caseRun) {
  if (caseCfg.disabled) {
    return {
      id: caseCfg.id,
      status: 'skipped',
      runs: 0,
      results: [],
      bugs: [],
      bugsMet: 0,
      bugsTotal: 0,
      forbidden: 0,
      medium: 0,
      tokens: null,
      duration: 0,
      anyError: false,
    };
  }

  const results = caseRun?.results ?? [];
  const anyError = Boolean(caseRun?.addError) || results.some((run) => run.error);
  const bugs = caseCfg.expect_bugs.map((bug) => {
    const hits = results.filter((run) => run.bugs.some((item) => item.id === bug.id && item.hit)).length;
    const rate = runs > 0 ? Math.round((hits / runs) * 100) / 100 : 0;
    const met = runs > 0 && hits >= requiredHits(caseCfg.min_hit_rate, runs);
    return { id: bug.id, hits, rate, met };
  });
  const bugsMet = bugs.filter((bug) => bug.met).length;
  const forbidden = results.reduce((total, run) => total + (run.forbidden ?? 0), 0);
  const medium = results.reduce((total, run) => total + (run.medium ?? 0), 0);
  const allBugsMet = bugs.every((bug) => bug.met);
  const passed = !anyError && allBugsMet && forbidden === 0;

  let status = 'pass';
  if (anyError) status = 'error';
  else if (!passed) status = 'FAIL';

  return {
    id: caseCfg.id,
    status,
    runs,
    results,
    bugs,
    bugsMet,
    bugsTotal: bugs.length,
    forbidden,
    medium,
    tokens: sumTokens(results),
    duration: results.reduce((total, run) => total + (run.duration_ms ?? 0), 0),
    anyError,
  };
}

export function formatTable(summaries, engine = null) {
  const header = [
    'case',
    'bug trúng/tổng',
    'tỉ lệ từng bug',
    'finding cấm',
    'nên sửa',
    'tokens',
    'thời gian',
    'kết quả',
  ];
  const rows = summaries.map((summary) => {
    if (summary.status === 'skipped') {
      return [summary.id, '-', '-', '-', '-', '-', '-', 'skipped'];
    }
    const rates = summary.bugs.length
      ? summary.bugs.map((bug) => `${bug.id}=${formatRate(bug.rate)}`).join(', ')
      : '-';
    return [
      summary.id,
      `${summary.bugsMet}/${summary.bugsTotal}`,
      rates,
      String(summary.forbidden),
      String(summary.medium),
      summary.tokens === null ? 'null' : String(summary.tokens),
      `${summary.duration}ms`,
      summary.status,
    ];
  });

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => String(row[index]).length)),
  );
  const render = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join(' | ');
  const separator = widths.map((width) => '-'.repeat(width)).join('-+-');
  const table = [render(header), separator, ...rows.map(render)].join('\n');
  return engine ? `engine: ${engine}\n${table}` : table;
}

async function loadCases(benchDir) {
  const casesDir = path.join(benchDir, 'cases');
  if (!existsSync(casesDir)) {
    throw new ConfigError(casesDir, 'cases', 'không tồn tại (đặt case JSON vào <DYSTOPIA_BENCH_DIR>/cases)');
  }
  const entries = (await readdir(casesDir)).filter((entry) => entry.endsWith('.json')).sort();
  const cases = [];
  for (const entry of entries) {
    const label = entry.replace(/\.json$/, '');
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(casesDir, entry), 'utf8'));
    } catch (error) {
      throw new ConfigError(label, 'file', `không đọc/parse được ${entry}: ${error.message}`);
    }
    cases.push(validateCase(raw, label));
  }
  return cases;
}

async function gitShortHead() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim() || 'nogit';
  } catch {
    return 'nogit';
  }
}

function localDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

async function writeResults(benchDir, document) {
  const resultsDir = path.join(benchDir, 'results');
  await mkdir(resultsDir, { recursive: true });
  const stem = `${localDate()}-${document.dystopia_head}`;
  for (let attempt = 1; ; attempt += 1) {
    const file = path.join(resultsDir, attempt === 1 ? `${stem}.json` : `${stem}-${attempt}.json`);
    try {
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function caseDocument(caseCfg, summary) {
  const config = caseCfg.disabled
    ? { id: caseCfg.id, disabled: true }
    : {
        id: caseCfg.id,
        repo: caseCfg.repo,
        base: caseCfg.base,
        head: caseCfg.head,
        expect_bugs: caseCfg.expect_bugs.map((bug) => ({
          id: bug.id,
          file: bug.file,
          match: bug.match,
          line_from: bug.line_from,
          line_to: bug.line_to,
          desc: bug.desc,
        })),
        max_rank: caseCfg.max_rank,
        forbid_severity: caseCfg.forbid_severity,
        min_hit_rate: caseCfg.min_hit_rate,
        disabled: false,
      };
  return {
    id: summary.id,
    status: summary.status,
    config,
    bugs: summary.bugs.map((bug) => ({ id: bug.id, hits: bug.hits, hit_rate: bug.rate, met: bug.met })),
    forbidden: summary.forbidden,
    medium: summary.medium,
    tokens: summary.tokens,
    duration_ms: summary.duration,
    runs: summary.results.map((run) => ({
      findings: run.findings,
      bugs: run.bugs,
      tokens: run.tokens,
      duration_ms: run.duration_ms,
      error: run.error,
    })),
  };
}

function parseArgs(argv) {
  const parsed = { runs: 1, cases: [], engine: 'ocr', limits: {}, help: false };
  const limitFlags = new Map([
    ['--max-tool-calls', 'maxToolCalls'],
    ['--max-tokens', 'maxTokens'],
    ['--phase-split', 'phaseSplit'],
    ['--concurrency', 'concurrency'],
  ]);

  const setLimit = (key, flag, value) => {
    const number = Number(value);
    const ok =
      key === 'phaseSplit'
        ? Number.isFinite(number) && number > 0 && number < 1
        : Number.isInteger(number) && number >= 1;
    if (!ok) throw new Error(`${flag} không hợp lệ: ${JSON.stringify(value)}`);
    parsed.limits[key] = number;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--runs' || arg === '--case' || arg === '--engine') {
      if (index + 1 >= argv.length) throw new Error(`${arg} cần giá trị`);
      const value = argv[index + 1];
      index += 1;
      if (arg === '--runs') {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          throw new Error(`--runs phải là số nguyên ≥ 1, nhận được ${JSON.stringify(value)}`);
        }
        parsed.runs = Number(value);
      } else if (arg === '--engine') {
        parsed.engine = value;
      } else {
        parsed.cases.push(value);
      }
    } else if (arg.startsWith('--runs=')) {
      const value = arg.slice('--runs='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error(`--runs phải là số nguyên ≥ 1, nhận được ${JSON.stringify(value)}`);
      }
      parsed.runs = Number(value);
    } else if (arg.startsWith('--engine=')) {
      parsed.engine = arg.slice('--engine='.length);
    } else if (arg.startsWith('--case=')) {
      parsed.cases.push(arg.slice('--case='.length));
    } else {
      let matched = null;
      for (const [flag, key] of limitFlags) {
        if (arg === flag) {
          if (index + 1 >= argv.length) throw new Error(`${flag} cần giá trị`);
          setLimit(key, flag, argv[index + 1]);
          index += 1;
          matched = flag;
          break;
        }
        if (arg.startsWith(`${flag}=`)) {
          setLimit(key, flag, arg.slice(flag.length + 1));
          matched = flag;
          break;
        }
      }
      if (matched === null) throw new Error(`tham số lạ: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  return [
    'Dùng: node lib/bench.mjs [--runs N] [--case <id>]... [--engine <tên>]',
    '                        [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]',
    '',
    '  --runs N       số lần chạy mỗi case (mặc định 1)',
    '  --case <id>    chỉ chạy case có id này (lặp lại được)',
    '  --engine <tên> engine review, mặc định ocr',
    '  --max-tool-calls, --max-tokens, --phase-split, --concurrency',
    '                 giới hạn chuyển cho engine native (các engine khác bỏ qua)',
    '',
    'Dữ liệu: $DYSTOPIA_BENCH_DIR (mặc định $HOME/firemoth/tools/dystopia-bench).',
    'Case: cases/*.json. Kết quả: results/<ngày>-<head dystopia>.json.',
  ].join('\n');
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`bench: ${error.message}\n\n${usage()}`);
    return 64;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  let engine;
  try {
    engine = getEngine(parsed.engine);
  } catch (error) {
    console.error(`bench: ${error.message}`);
    return 64;
  }

  const benchDir = resolveBenchDir();
  let cases;
  try {
    cases = await loadCases(benchDir);
    if (parsed.cases.length > 0) {
      const wanted = new Set(parsed.cases);
      const known = new Set(cases.map((item) => item.id));
      const missing = [...wanted].filter((id) => !known.has(id));
      if (missing.length > 0) throw new ConfigError(missing.join(', '), '--case', 'không có case nào mang id này');
      cases = cases.filter((item) => wanted.has(item.id));
    }
  } catch (error) {
    console.error(`bench: ${error.message}`);
    return 64;
  }

  const startedAt = new Date().toISOString();
  const summaries = [];
  for (const caseCfg of cases) {
    if (caseCfg.disabled) {
      summaries.push(summarize(caseCfg, parsed.runs, null));
      continue;
    }
    const caseRun = await runCase(caseCfg, parsed.runs, engine, parsed.limits);
    const summary = summarize(caseCfg, parsed.runs, caseRun);
    if (caseRun.addError) {
      console.error(`bench: case "${caseCfg.id}": ${caseRun.addError}`);
    }
    for (const [index, run] of summary.results.entries()) {
      if (run.error) console.error(`bench: case "${caseCfg.id}" lần ${index + 1}: ${run.error}`);
    }
    summaries.push(summary);
  }

  const document = {
    started_at: startedAt,
    engine: parsed.engine,
    dystopia_head: await gitShortHead(),
    runs: parsed.runs,
    cases: summaries.map((summary) => {
      const caseCfg = cases.find((item) => item.id === summary.id);
      return caseDocument(caseCfg, summary);
    }),
  };

  try {
    await writeResults(benchDir, document);
  } catch (error) {
    console.error(`bench: không ghi được kết quả vào ${path.join(benchDir, 'results')}: ${error.message}`);
    return 1;
  }

  console.log(formatTable(summaries, parsed.engine));
  return summaries.some((summary) => summary.status === 'FAIL' || summary.status === 'error') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`bench: ${error.stack || error.message}`);
      process.exitCode = 1;
    },
  );
}
