// Test report_finding của engine native: từ chối schema sai/line ngoài head/file
// không thay đổi/evidence rỗng, và agent sửa lại được trong cùng lượt.
// Không gọi LLM thật (driver giả).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { createFindingCollector } from '../lib/engine/native/finding.mjs';
import { review } from '../lib/engine/native/index.mjs';
import { createTools } from '../lib/engine/native/tools.mjs';
import { makeNativeRepo } from './fixtures/native-repo/repo.mjs';

const execFileAsync = promisify(execFile);

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

function validFinding(overrides = {}) {
  return {
    file: 'src/file1.ts',
    line: 2,
    end_line: 2,
    severity: 'nên sửa',
    rule: 'logic',
    claim: 'Giá trị sai',
    evidence: 'export const value1b = 2;',
    confidence: 0.8,
    ...overrides,
  };
}

test('report_finding từ chối severity sai, line ngoài head, file không đổi, evidence rỗng', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const tools = createTools({
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    runner: localRunner(repo.dir),
  });
  const collector = createFindingCollector({ headTree: tools.headTree, changedFiles: ['src/file1.ts'] });

  const cases = [
    [validFinding({ severity: 'high' }), /severity/],
    [validFinding({ line: 99, end_line: 99 }), /vượt quá 3 dòng/],
    [validFinding({ file: 'src/khong-doi.ts' }), /không nằm trong danh sách file thay đổi/],
    [validFinding({ evidence: '   ' }), /evidence/],
    [validFinding({ rule: '' }), /rule/],
    [validFinding({ claim: '' }), /claim/],
    [validFinding({ confidence: 1.5 }), /confidence/],
    [validFinding({ line: 0 }), /line/],
    [validFinding({ end_line: 1 }), /end_line/],
  ];
  for (const [finding, pattern] of cases) {
    const message = await collector.report_finding(finding);
    assert.equal(typeof message, 'string');
    assert.match(message, /report_finding bị từ chối/);
    assert.match(message, pattern, `finding ${JSON.stringify(finding)}`);
  }
  assert.deepEqual(collector.findings, []);

  const ok = await collector.report_finding(validFinding());
  assert.match(ok, /đã ghi nhận finding/);
  assert.equal(collector.findings.length, 1);
  assert.deepEqual(collector.findings[0], {
    severity: 'nên sửa',
    file: 'src/file1.ts',
    line: 2,
    end_line: 2,
    rule: 'logic',
    claim: 'Giá trị sai',
    evidence: 'export const value1b = 2;',
    confidence: 0.8,
  });
});

test('agent sửa report_finding sai rồi gọi lại trong cùng lượt: chỉ finding đúng vào output', async (t) => {
  const repo = await makeNativeRepo(t, { files: 1 });
  const seen = [];
  const factory = async (options) => ({
    model: 'fake/model-fix',
    async prompt() {
      seen.push(await options.tools.report_finding(validFinding({ severity: 'high' })));
      seen.push(await options.tools.report_finding(validFinding({ line: 99, end_line: 99 })));
      seen.push(await options.tools.report_finding(validFinding({ evidence: '' })));
      seen.push(await options.tools.report_finding(validFinding()));
    },
    async abort() {},
    async dispose() {},
  });

  const result = await review({
    repo: repo.dir,
    base: repo.base,
    head: repo.head,
    models: [{ provider: 'fake', model: 'model-fix', label: 'fake/model-fix' }],
    model: { provider: 'fake', model: 'model-fix', label: 'fake/model-fix' },
    driver: factory,
    runner: localRunner(repo.dir),
    version: '0.3.0-dev',
  });

  assert.equal(seen.filter((message) => /bị từ chối/.test(message)).length, 3);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, 'src/file1.ts');
  assert.equal(result.findings[0].line, 2);
});
