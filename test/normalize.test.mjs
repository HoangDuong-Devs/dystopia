// Test chuẩn hóa output OCR và wrapper `dystopia review`.
// Không gọi LLM, không gọi binary OCR thật: wrapper dùng script giả qua DYSTOPIA_OCR_BIN.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { normalize, parseElapsed, toText } from '../lib/normalize.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const BASIC = path.join(FIXTURES, 'ocr-basic.json');
const NULL_COMMENTS = path.join(FIXTURES, 'ocr-null-comments.json');
const PARTIAL = path.join(FIXTURES, 'ocr-partial.json');

async function loadFixture(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function comment(overrides) {
  return {
    path: 'src/file1.ts',
    start_line: 1,
    end_line: 2,
    severity: 'low',
    category: 'style',
    content: 'Mô tả.',
    existing_code: 'code();',
    ...overrides,
  };
}

const FORBIDDEN_KEYS = new Set(['verdict', 'approve', 'approved', 'reject', 'duyệt', 'trả lại']);

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

test('map severity high/medium/low sang chặn/nên sửa/gợi ý và map trường', () => {
  const result = normalize({
    comments: [
      comment({ severity: 'high', path: 'src/file1.ts', start_line: 10, end_line: 12, category: 'security' }),
      comment({ severity: 'medium', path: 'src/file2.ts', start_line: 3, end_line: 4, category: 'error-handling' }),
      comment({ severity: 'low', path: 'src/file3.ts', start_line: 7, end_line: 9, category: 'style' }),
    ],
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.severity),
    ['chặn', 'nên sửa', 'gợi ý'],
  );
  assert.deepEqual(result.findings[0], {
    severity: 'chặn',
    file: 'src/file1.ts',
    line: 10,
    end_line: 12,
    rule: 'security',
    claim: 'Mô tả',
    evidence: 'code();',
    confidence: null,
  });
  assert.equal(result.findings[1].file, 'src/file2.ts');
  assert.equal(result.findings[1].line, 3);
  assert.equal(result.findings[1].end_line, 4);
  assert.equal(result.findings[1].rule, 'error-handling');
  assert.equal(result.findings[2].line, 7);
});

test('severity lạ hạ xuống gợi ý và cảnh báo ra stderr', (t) => {
  const spy = t.mock.method(console, 'error', () => {});
  const result = normalize({
    comments: [comment({ severity: 'blocker', path: 'src/file2.ts', content: 'Mức lạ.' })],
  });

  assert.equal(result.findings[0].severity, 'gợi ý');
  assert.equal(spy.mock.callCount(), 1);
  const message = String(spy.mock.calls[0].arguments[0]);
  assert.match(message, /severity lạ/);
  assert.match(message, /"blocker"/);
  assert.match(message, /"gợi ý"/);
});

test('sắp xếp ổn định theo severity rồi confidence giảm dần, null sau số', () => {
  const result = normalize({
    comments: [
      comment({ severity: 'low', confidence: 0.99, content: 'thap-c.' }),
      comment({ severity: 'high', content: 'cao-null.' }),
      comment({ severity: 'medium', confidence: 0.5, content: 'vua-b.' }),
      comment({ severity: 'high', confidence: 0.8, content: 'cao-a.' }),
      comment({ severity: 'critical', confidence: 0.7, content: 'la-d.' }),
    ],
  });

  assert.deepEqual(
    result.findings.map((finding) => finding.claim),
    ['cao-a', 'cao-null', 'vua-b', 'thap-c', 'la-d'],
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.severity),
    ['chặn', 'chặn', 'nên sửa', 'gợi ý', 'gợi ý'],
  );
});

test('confidence null khi OCR không có, giữ số khi có', () => {
  const result = normalize({
    comments: [comment({ confidence: 0.25 }), comment({ confidence: undefined })],
  });
  assert.equal(result.findings[0].confidence, 0.25);
  assert.equal(result.findings[1].confidence, null);
});

test('fixture cơ bản: sắp xếp, claim và evidence đúng', async () => {
  const ocr = await loadFixture(BASIC);
  const result = normalize(ocr);

  assert.deepEqual(
    result.findings.map((finding) => [finding.severity, finding.file, finding.line, finding.end_line]),
    [
      ['chặn', 'src/file1.ts', 40, 41],
      ['nên sửa', 'src/file1.ts', 12, 14],
      ['gợi ý', 'src/file2.ts', 3, 3],
      ['gợi ý', 'src/file2.ts', 88, 90],
    ],
  );
  assert.equal(result.findings[0].claim, 'Chuỗi truy vấn được ghép trực tiếp từ input người dùng');
  assert.equal(result.findings[0].evidence, "db.query('select * from t where id=' + id)");
  assert.equal(result.findings[2].claim, 'Tên biến viết tắt khó đọc');
  assert.equal(result.findings[3].claim, 'Mức lạ để kiểm tra hạ cấp');
  assert.equal(result.findings[3].evidence, 'weird();');
});

test('comments null → findings rỗng', async () => {
  const nullFixture = normalize(await loadFixture(NULL_COMMENTS));
  const inlineNull = normalize({ comments: null });
  assert.deepEqual(nullFixture.findings, []);
  assert.deepEqual(inlineNull.findings, []);
});

test('meta lấy từ fixture, ưu tiên manifest rồi mới tới tham số', async () => {
  const ocr = await loadFixture(BASIC);
  const result = normalize(ocr, { base: 'tham-so-base', head: 'tham-so-head', durationMs: 1234.6, version: 'v-test' });
  assert.deepEqual(result.meta, {
    tool: 'dystopia',
    version: 'v-test',
    base: 'aaaa1111',
    head: 'bbbb2222',
    model: 'fake/model-1',
    tokens_in: 12000,
    tokens_out: 3234,
    duration_ms: 1235,
  });

  const partial = normalize(await loadFixture(PARTIAL), { base: 'tham-so-base', head: 'tham-so-head', version: 'v-test' });
  assert.equal(partial.meta.base, 'tham-so-base');
  assert.equal(partial.meta.head, 'tham-so-head');
  assert.equal(partial.meta.model, 'fake/model-2');
  assert.equal(partial.meta.tokens_in, 42);
  assert.equal(partial.meta.tokens_out, null);
  assert.equal(partial.meta.duration_ms, 9500);
});

test('parse elapsed nhiều dạng, không parse được → null', async () => {
  assert.equal(parseElapsed('15m49s'), 949000);
  assert.equal(parseElapsed('9.5s'), 9500);
  assert.equal(parseElapsed('1h2m3s'), 3723000);
  assert.equal(parseElapsed('42s'), 42000);
  assert.equal(parseElapsed('không rõ'), null);
  assert.equal(parseElapsed(''), null);
  assert.equal(parseElapsed(undefined), null);

  const fixture = await loadFixture(BASIC);
  assert.equal(normalize(fixture).meta.duration_ms, 949000);
  assert.equal(normalize({ ...fixture, summary: { ...fixture.summary, elapsed: 'không rõ' } }).meta.duration_ms, null);
  assert.equal(normalize({ summary: { elapsed: '2m' } }).meta.duration_ms, 120000);
});

test('toText đúng định dạng [mức] file:line-end_line rule — claim', async () => {
  const result = normalize(await loadFixture(BASIC));
  assert.equal(
    toText(result),
    [
      '[chặn] src/file1.ts:40-41 security — Chuỗi truy vấn được ghép trực tiếp từ input người dùng',
      '[nên sửa] src/file1.ts:12-14 error-handling — Lỗi bị nuốt trong khối catch',
      '[gợi ý] src/file2.ts:3-3 style — Tên biến viết tắt khó đọc',
      '[gợi ý] src/file2.ts:88-90 unknown-thing — Mức lạ để kiểm tra hạ cấp',
    ].join('\n'),
  );
  assert.equal(toText({ findings: [] }), '');
});

test('output không chứa key phán quyết (verdict/approve/reject/DUYỆT/TRẢ LẠI)', async () => {
  const result = normalize(await loadFixture(BASIC), { version: 'v-test' });
  const keys = collectKeys(result).map((key) => key.toLowerCase());
  for (const key of keys) {
    assert.equal(FORBIDDEN_KEYS.has(key), false, `key bị cấm trong output: ${key}`);
  }
});

test('CLI normalize đọc file OCR và in text', async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, 'lib', 'normalize.mjs'), BASIC, '--text']);
  const result = normalize(await loadFixture(BASIC));
  assert.equal(stdout.trim(), toText(result));
});

async function makeFakeOcr() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dystopia-test-'));
  const bin = path.join(dir, 'fake-ocr');
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FAKE_OCR_EXIT:-0}" != "0" ]; then exit "\${FAKE_OCR_EXIT}"; fi
out=""
prev=""
for a in "\$@"; do
  case "\$prev" in --output|-o) out="\$a";; esac
  case "\$a" in --output=*|-o=*) out="\${a#*=}";; esac
  prev="\$a"
done
if [ -z "\$out" ]; then echo "fake-ocr: thiếu --output" >&2; exit 2; fi
cp "\$FAKE_OCR_FIXTURE" "\$out"
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  const envFile = path.join(dir, 'empty.env');
  await writeFile(envFile, '');
  await chmod(envFile, 0o600);
  return { dir, bin, envFile };
}

function wrapperEnv(fake, fixture, extra = {}) {
  return {
    ...process.env,
    DYSTOPIA_OCR_BIN: fake.bin,
    DYSTOPIA_ENV_FILE: fake.envFile,
    FAKE_OCR_FIXTURE: fixture,
    DYSTOPIA_VERSION: 'v-wrapper',
    ...extra,
  };
}

test('wrapper review --text in đúng dòng text từ output OCR', async (t) => {
  const fake = await makeFakeOcr();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(path.join(ROOT, 'dystopia'), ['review', '--text'], {
    env: wrapperEnv(fake, BASIC),
  });
  const expected = toText(normalize(await loadFixture(BASIC), { version: 'v-wrapper' }));
  assert.equal(stdout.trim(), expected);
});

test('wrapper review mặc định ghi kết quả chuẩn hóa vào --output', async (t) => {
  const fake = await makeFakeOcr();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));

  const outFile = path.join(fake.dir, 'result.json');
  await execFileAsync(path.join(ROOT, 'dystopia'), ['review', '--output', outFile], {
    env: wrapperEnv(fake, BASIC),
  });
  const result = JSON.parse(await readFile(outFile, 'utf8'));
  assert.equal(result.meta.tool, 'dystopia');
  assert.equal(result.meta.version, 'v-wrapper');
  assert.equal(result.meta.model, 'fake/model-1');
  assert.equal(result.meta.base, 'aaaa1111');
  assert.equal(typeof result.meta.duration_ms, 'number');
  assert.equal(result.findings.length, 4);
});

test('wrapper review --raw giữ nguyên JSON gốc của OCR', async (t) => {
  const fake = await makeFakeOcr();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));

  const outFile = path.join(fake.dir, 'raw.json');
  await execFileAsync(path.join(ROOT, 'dystopia'), ['review', '--raw', '--output', outFile], {
    env: wrapperEnv(fake, BASIC),
  });
  assert.deepEqual(JSON.parse(await readFile(outFile, 'utf8')), await loadFixture(BASIC));
});

test('wrapper giữ nguyên exit code của OCR', async (t) => {
  const fake = await makeFakeOcr();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(path.join(ROOT, 'dystopia'), ['review', '--text'], {
      env: wrapperEnv(fake, BASIC, { FAKE_OCR_EXIT: '3' }),
    }),
    (error) => error.code === 3,
  );
});
