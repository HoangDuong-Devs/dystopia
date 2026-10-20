// Điểm vào CLI `dystopia review`: chọn engine theo hợp đồng, gom cờ của Dystopia
// (--engine, --dir, --output, --text) rồi chuyển phần còn lại cho engine.
//
// Đường --raw và đường người gọi tự chọn --format vẫn exec thẳng binary OCR như
// hành vi cũ (không chuẩn hóa). Chỉ dùng module có sẵn của Node.

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { EngineError, assertValidResult, getEngine } from './engine/index.mjs';
import { defaultBin, missingBinMessage, overlayRulePaths, passthroughArgs } from './engine/ocr.mjs';
import { toText } from './normalize.mjs';

const DEFAULT_ENGINE = 'ocr';

const VALUE_FLAGS = new Map([
  ['--engine', 'engine'],
  ['--dir', 'dir'],
  ['--output', 'output'],
  ['-o', 'output'],
]);
const LIMIT_FLAGS = new Map([
  ['--max-tool-calls', 'maxToolCalls'],
  ['--max-tokens', 'maxTokens'],
  ['--phase-split', 'phaseSplit'],
  ['--concurrency', 'concurrency'],
]);
const RANGE_FLAGS = ['--from', '--to'];
const FORMAT_RE = /^(?:--format|-f)(?:=|$)/;

function usage() {
  return [
    'Dùng: dystopia review [--from <base> --to <head>] [--dir <repo>] [--engine ocr|native]',
    '                      [--output <file>] [--text] [--raw] [cờ của OCR...]',
    '',
    '  --engine <tên>  engine review (mặc định ocr)',
    '  --dir <repo>    repo cần review (mặc định thư mục hiện tại)',
    '  --output F      ghi kết quả đã chuẩn hóa vào F',
    '  --text          in findings dạng text',
    '  --raw           trả nguyên output OCR, không chuẩn hóa',
    '  engine native:  --max-tool-calls N  --max-tokens N  --phase-split F  --concurrency N',
    '                  (bắt buộc --from/--to; không hỗ trợ -c)',
  ].join('\n');
}

function fail(message) {
  console.error(`dystopia: ${message}\n\n${usage()}`);
  return 64;
}

// Lấy giá trị cuối cùng của một cờ dạng "--from X" hoặc "--from=X".
function flagValue(argv, names) {
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    for (const name of names) {
      if (arg === name) {
        if (index + 1 < argv.length) value = argv[index + 1];
      } else if (arg.startsWith(`${name}=`)) {
        value = arg.slice(name.length + 1);
      }
    }
  }
  return value;
}

// Bỏ "--from X"/"--to Y" khỏi danh sách chuyển tiếp khi đã dùng chúng làm
// base/head của hợp đồng.
function stripRange(args) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const matched = RANGE_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (!matched) {
      kept.push(arg);
      continue;
    }
    if (arg === matched) index += 1;
  }
  return kept;
}

function parseArgs(argv) {
  const parsed = {
    engine: null,
    dir: null,
    output: null,
    text: false,
    raw: false,
    format: false,
    limits: {},
    rest: [],
    contractRest: [],
    base: flagValue(argv, ['--from']),
    head: flagValue(argv, ['--to']),
    error: null,
  };
  const push = (arg, { contract = true, passthrough = true } = {}) => {
    if (passthrough) parsed.rest.push(arg);
    if (contract) parsed.contractRest.push(arg);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--text') {
      parsed.text = true;
      push(arg, { contract: false });
      continue;
    }
    if (arg === '--raw') {
      parsed.raw = true;
      push(arg);
      continue;
    }
    if (FORMAT_RE.test(arg)) {
      parsed.format = true;
      push(arg);
      continue;
    }

    let limitConsumed = false;
    for (const [flag, key] of LIMIT_FLAGS) {
      let value = null;
      if (arg === flag) {
        if (index + 1 >= argv.length) {
          parsed.error = `${flag} cần giá trị`;
          return parsed;
        }
        value = argv[index + 1];
        index += 1;
      } else if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1);
      } else {
        continue;
      }
      const number = Number(value);
      const valid =
        key === 'phaseSplit'
          ? Number.isFinite(number) && number > 0 && number < 1
          : Number.isInteger(number) && number >= 1;
      if (!valid) {
        parsed.error = `${flag} không hợp lệ: ${JSON.stringify(value)}`;
        return parsed;
      }
      parsed.limits[key] = number;
      limitConsumed = true;
      break;
    }
    if (limitConsumed) continue;

    let consumed = false;
    for (const [flag, key] of VALUE_FLAGS) {
      let value = null;
      let separate = false;
      if (arg === flag) {
        if (index + 1 >= argv.length) {
          parsed.error = `${flag} cần giá trị`;
          return parsed;
        }
        value = argv[index + 1];
        separate = true;
        index += 1;
      } else if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1);
      } else {
        continue;
      }
      parsed[key] = value;
      // --output/-o vẫn được chuyển tiếp cho đường --raw/--format như cũ.
      push(arg, { contract: false, passthrough: key === 'output' });
      if (key === 'output' && separate) push(value, { contract: false, passthrough: true });
      consumed = true;
      break;
    }
    if (consumed) continue;
    push(arg);
  }

  return parsed;
}

// Đường --raw / tự chọn --format: exec thẳng OCR như wrapper cũ.
function runOcrDirect(parsed) {
  const bin = defaultBin();
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    console.error(`dystopia: ${missingBinMessage()}`);
    return 127;
  }
  const args = passthroughArgs(parsed.rest, { raw: parsed.raw });
  const rules = overlayRulePaths(args).flatMap((rule) => ['--rule', rule]);
  const argv = parsed.raw
    ? ['review', ...(parsed.format ? [] : ['--format', 'json']), ...rules, ...args]
    : ['review', ...rules, ...args];
  const child = spawnSync(bin, argv, {
    cwd: parsed.dir ? path.resolve(parsed.dir) : process.cwd(),
    stdio: 'inherit',
  });
  if (child.error) {
    console.error(`dystopia: ${missingBinMessage()}`);
    return 127;
  }
  return child.status ?? 1;
}

async function writeResult(parsed, result) {
  const text = parsed.text ? toText(result) : JSON.stringify(result, null, 2);
  const body = text === '' ? '' : `${text}\n`;
  if (parsed.output) {
    await writeFile(parsed.output, body, 'utf8');
    return;
  }
  if (body !== '') process.stdout.write(body);
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);
  if (parsed.raw || parsed.format) {
    return runOcrDirect(parsed);
  }

  let engine;
  try {
    engine = getEngine(parsed.engine ?? DEFAULT_ENGINE);
  } catch (error) {
    if (error instanceof EngineError) return fail(error.message);
    throw error;
  }

  const repo = parsed.dir ? path.resolve(parsed.dir) : process.cwd();
  const hasRange = typeof parsed.base === 'string' && typeof parsed.head === 'string';
  const engineName = parsed.engine ?? DEFAULT_ENGINE;
  const commitFlag = parsed.contractRest.find((arg) => arg === '-c' || arg === '--commit' || arg.startsWith('--commit='));
  if (engineName === 'native' && (!hasRange || commitFlag)) {
    return fail(
      'engine native cần dải review: dùng --from <base> --to <head> (không hỗ trợ -c/--commit)',
    );
  }
  const options = {
    repo,
    base: hasRange ? parsed.base : null,
    head: hasRange ? parsed.head : null,
    rules: [],
    limits: parsed.limits,
    args: hasRange ? stripRange(parsed.contractRest) : parsed.contractRest,
  };

  let result;
  try {
    result = assertValidResult(await engine.review(options));
  } catch (error) {
    if (error instanceof EngineError) {
      if (error.message && !error.quiet) console.error(`dystopia: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }

  await writeResult(parsed, result);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`dystopia: ${error?.stack || error?.message || error}`);
      process.exitCode = 1;
    },
  );
}
