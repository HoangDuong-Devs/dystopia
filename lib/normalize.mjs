// Chuẩn hóa output OCR (OpenCodeReview) sang schema findings của Dystopia.
// Chỉ dùng module có sẵn của Node, không phụ thuộc gói ngoài.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// OCR chỉ có ba mức high/medium/low. Mức khác hạ xuống "gợi ý" và cảnh báo
// ra stderr để không làm hỏng JSON in ở stdout.
const SEVERITY_BY_OCR = { high: 'chặn', medium: 'nên sửa', low: 'gợi ý' };
const FALLBACK_SEVERITY = 'gợi ý';
const SEVERITY_RANK = { 'chặn': 0, 'nên sửa': 1, 'gợi ý': 2 };

// Định dạng elapsed của OCR: "15m49s", "9.5s", "1h2m3s"... Không khớp → null.
export function parseElapsed(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

// start_line/end_line của OCR đã là số dòng phía HEAD: dòng được trích trong
// existing_code chỉ tồn tại ở bản head, không có ở base. Đã kiểm tay trên output
// thật của một commit core: đối chiếu existing_code với file phía head (git show
// <head>:<path>) khớp đúng số dòng, còn bản base không có dòng đó. Vì vậy chỉ cần
// đi qua hàm này để chốt phía dòng, không chuyển đổi số.
function toHeadLine(comment) {
  const start = Number.isInteger(comment.start_line) ? comment.start_line : null;
  const end = Number.isInteger(comment.end_line) ? comment.end_line : start;
  return { line: start ?? end ?? null, end_line: end ?? start ?? null };
}

// Claim = câu đầu của content: cắt ở dấu chấm hoặc xuống dòng đầu tiên.
function firstSentence(content) {
  if (typeof content !== 'string') return '';
  const text = content.trim();
  if (!text) return '';
  let cut = text.length;
  const newline = text.indexOf('\n');
  if (newline !== -1) cut = Math.min(cut, newline);
  const dot = text.indexOf('.');
  if (dot !== -1) cut = Math.min(cut, dot);
  return text.slice(0, cut).trim();
}

function toSeverity(rawSeverity, file) {
  const key = typeof rawSeverity === 'string' ? rawSeverity.trim().toLowerCase() : '';
  if (Object.hasOwn(SEVERITY_BY_OCR, key)) return SEVERITY_BY_OCR[key];
  console.error(
    `normalize: severity lạ ${JSON.stringify(rawSeverity ?? null)} ở ${file ?? '?'}` +
      `, hạ xuống "${FALLBACK_SEVERITY}"`,
  );
  return FALLBACK_SEVERITY;
}

function toFinding(rawComment) {
  const comment = rawComment && typeof rawComment === 'object' ? rawComment : {};
  const severity = toSeverity(comment.severity, comment.path);
  const { line, end_line } = toHeadLine(comment);
  return {
    severity,
    file: typeof comment.path === 'string' ? comment.path : null,
    line,
    end_line,
    rule: typeof comment.category === 'string' ? comment.category : null,
    claim: firstSentence(comment.content),
    evidence: comment.existing_code ? comment.existing_code : null,
    confidence: Number.isFinite(comment.confidence) ? comment.confidence : null,
  };
}

// Sắp xếp ổn định: severity tăng dần (chặn → nên sửa → gợi ý), rồi confidence
// giảm dần; confidence null xếp sau mọi số; hoà thì giữ thứ tự gốc của OCR.
function sortFindings(entries) {
  return entries
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const ca = a.finding.confidence;
      const cb = b.finding.confidence;
      if (ca === null && cb === null) return a.index - b.index;
      if (ca === null) return 1;
      if (cb === null) return -1;
      if (ca !== cb) return cb - ca;
      return a.index - b.index;
    })
    .map((entry) => entry.finding);
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function normalize(ocrJson, options = {}) {
  const doc = ocrJson && typeof ocrJson === 'object' ? ocrJson : {};
  const manifestInput = doc.manifest && typeof doc.manifest.input === 'object' ? doc.manifest.input : {};
  const comments = Array.isArray(doc.comments) ? doc.comments : [];

  const findings = sortFindings(
    comments.map((rawComment, index) => {
      const finding = toFinding(rawComment);
      return { finding, rank: SEVERITY_RANK[finding.severity], index };
    }),
  );

  const summary = doc.summary && typeof doc.summary === 'object' ? doc.summary : {};
  const llm = doc.llm && typeof doc.llm === 'object' ? doc.llm : {};
  const durationMs = Number.isFinite(options.durationMs)
    ? Math.round(options.durationMs)
    : parseElapsed(summary.elapsed);

  const meta = {
    tool: 'dystopia',
    version: options.version ?? null,
    base: stringOrNull(manifestInput.resolved_base) ?? stringOrNull(options.base),
    head: stringOrNull(manifestInput.resolved_head) ?? stringOrNull(options.head),
    model: stringOrNull(llm.model),
    tokens_in: numberOrNull(summary.input_tokens),
    tokens_out: numberOrNull(summary.output_tokens),
    duration_ms: durationMs,
  };

  return { meta, findings };
}

export function toText(result) {
  const findings = result && Array.isArray(result.findings) ? result.findings : [];
  return findings
    .map((finding) => {
      const file = finding.file ?? '?';
      const line = finding.line ?? '?';
      const endLine = finding.end_line ?? line;
      const rule = finding.rule ?? '?';
      return `[${finding.severity}] ${file}:${line}-${endLine} ${rule} — ${finding.claim ?? ''}`;
    })
    .join('\n');
}

function usage() {
  return [
    'Dùng: node lib/normalize.mjs <ocr.json> [--text] [--base X] [--head Y] [--duration-ms N]',
    '',
    '  --text           in dạng text thay vì JSON',
    '  --base X         base dùng khi manifest.input.resolved_base trống',
    '  --head Y         head dùng khi manifest.input.resolved_head trống',
    '  --duration-ms N  thời gian chạy OCR (ms), ưu tiên hơn summary.elapsed',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { file: null, text: false, help: false, base: undefined, head: undefined, durationMs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--text') {
      parsed.text = true;
    } else if (arg === '--base' || arg === '--head' || arg === '--duration-ms') {
      if (i + 1 >= argv.length) throw new Error(`${arg} cần giá trị`);
      const value = argv[i + 1];
      i += 1;
      if (arg === '--base') parsed.base = value;
      else if (arg === '--head') parsed.head = value;
      else {
        const ms = Number(value);
        if (!Number.isFinite(ms)) throw new Error(`--duration-ms không phải số: ${value}`);
        parsed.durationMs = ms;
      }
    } else if (arg.startsWith('--base=')) {
      parsed.base = arg.slice('--base='.length);
    } else if (arg.startsWith('--head=')) {
      parsed.head = arg.slice('--head='.length);
    } else if (arg.startsWith('--duration-ms=')) {
      const ms = Number(arg.slice('--duration-ms='.length));
      if (!Number.isFinite(ms)) throw new Error(`--duration-ms không phải số: ${arg}`);
      parsed.durationMs = ms;
    } else if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`tham số lạ: ${arg}`);
    } else if (parsed.file === null) {
      parsed.file = arg;
    } else {
      throw new Error(`chỉ nhận một file OCR, thừa: ${arg}`);
    }
  }
  return parsed;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`normalize: ${error.message}\n\n${usage()}`);
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  if (!parsed.file) {
    console.error(`normalize: thiếu file OCR\n\n${usage()}`);
    return 2;
  }
  let ocrJson;
  try {
    ocrJson = JSON.parse(readFileSync(parsed.file, 'utf8'));
  } catch (error) {
    console.error(`normalize: không đọc/parse được ${parsed.file}: ${error.message}`);
    return 1;
  }
  const result = normalize(ocrJson, {
    base: parsed.base,
    head: parsed.head,
    durationMs: parsed.durationMs,
    version: process.env.DYSTOPIA_VERSION,
  });
  if (parsed.text) {
    const text = toText(result);
    if (text) console.log(text);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
