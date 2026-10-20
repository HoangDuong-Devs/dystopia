// report_finding của engine native: kiểm schema NGAY khi agent gọi, trả chuỗi
// lỗi để agent sửa lại trong cùng lượt. Finding hỏng không bao giờ vào output.
// Chỉ dùng module có sẵn của Node.

export const SEVERITIES = Object.freeze(['chặn', 'nên sửa', 'gợi ý']);
export const DEFAULT_CONFIDENCE = null;

const REJECT_PREFIX = 'report_finding bị từ chối: ';
const REJECT_SUFFIX = '. Sửa lại tham số rồi gọi lại.';

// Lý do từ chối của một lần gọi report_finding, hoặc null nếu finding hợp lệ.
export function rejectionReason(result) {
  if (typeof result !== 'string' || !result.startsWith(REJECT_PREFIX)) return null;
  const reason = result.slice(REJECT_PREFIX.length);
  return reason.endsWith(REJECT_SUFFIX) ? reason.slice(0, -REJECT_SUFFIX.length) : reason;
}

const SEVERITY_RANK = { 'chặn': 0, 'nên sửa': 1, 'gợi ý': 2 };

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInput(input, rest) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  const [line, endLine, severity, rule, claim, evidence, confidence] = rest;
  return {
    file: input,
    line,
    end_line: endLine,
    severity,
    rule,
    claim,
    evidence,
    confidence,
  };
}

/**
 * Kiểm một finding. Trả chuỗi lỗi (cho agent) hoặc null nếu hợp lệ.
 *
 * @param {Object} finding
 * @param {{changedFiles: Set<string>|string[], lineCount: (file: string) => Promise<number>}} context
 */
export async function checkFinding(finding, context) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return 'finding phải là object có các trường file, line, severity, rule, claim, evidence, confidence';
  }
  const file = text(finding.file);
  if (file === '') return 'file bắt buộc và phải là chuỗi khác rỗng';
  const changed = context.changedFiles instanceof Set ? context.changedFiles : new Set(context.changedFiles ?? []);
  if (!changed.has(file)) {
    return `file "${file}" không nằm trong danh sách file thay đổi của lần review này`;
  }

  const severity = text(finding.severity);
  if (!SEVERITIES.includes(severity)) {
    return `severity phải là một trong ${SEVERITIES.join(', ')}, nhận ${JSON.stringify(finding.severity)}`;
  }

  if (!Number.isInteger(finding.line) || finding.line < 1) {
    return `line phải là số nguyên ≥ 1 theo phía head, nhận ${JSON.stringify(finding.line)}`;
  }
  const endLine = finding.end_line === undefined || finding.end_line === null ? finding.line : finding.end_line;
  if (!Number.isInteger(endLine) || endLine < finding.line) {
    return `end_line phải là số nguyên ≥ line (${finding.line}), nhận ${JSON.stringify(finding.end_line)}`;
  }

  let lines;
  try {
    lines = await context.lineCount(file);
  } catch (error) {
    return `không đọc được "${file}" ở head: ${error.message}`;
  }
  if (finding.line > lines) {
    return `line ${finding.line} vượt quá ${lines} dòng của "${file}" ở head`;
  }
  if (endLine > lines) {
    return `end_line ${endLine} vượt quá ${lines} dòng của "${file}" ở head`;
  }

  const rule = text(finding.rule);
  if (rule === '') return 'rule bắt buộc và phải là chuỗi khác rỗng';
  const claim = text(finding.claim);
  if (claim === '') return 'claim bắt buộc và phải là chuỗi khác rỗng';
  const evidence = text(finding.evidence);
  if (evidence === '') return 'evidence bắt buộc và phải là chuỗi khác rỗng';

  const confidence = finding.confidence ?? null;
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return `confidence phải là số trong khoảng 0–1 (hoặc null), nhận ${JSON.stringify(finding.confidence)}`;
  }

  return null;
}

export function sortFindings(findings) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const rank = (SEVERITY_RANK[a.finding.severity] ?? 9) - (SEVERITY_RANK[b.finding.severity] ?? 9);
      if (rank !== 0) return rank;
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

/**
 * Bộ thu finding dùng chung cho các file trong một lần review.
 *
 * @param {{headTree: {read: (file: string) => Promise<{lines: number}>}, changedFiles: string[]}} options
 */
export function createFindingCollector(options) {
  const headTree = options.headTree;
  const changedFiles = new Set(options.changedFiles);
  const lineCounts = new Map();
  const findings = [];

  async function lineCount(file) {
    if (!lineCounts.has(file)) {
      lineCounts.set(file, headTree.read(file).then((document) => document.lines));
    }
    return lineCounts.get(file);
  }

  // Gọi được cả dạng object (tool của Pi) lẫn positional như spec.
  async function report_finding(input, ...rest) {
    const finding = normalizeInput(input, rest);
    const error = await checkFinding(finding, { changedFiles, lineCount });
    if (error) return `${REJECT_PREFIX}${error}${REJECT_SUFFIX}`;

    const endLine = finding.end_line === undefined || finding.end_line === null ? finding.line : finding.end_line;
    findings.push({
      severity: text(finding.severity),
      file: text(finding.file),
      line: finding.line,
      end_line: endLine,
      rule: text(finding.rule),
      claim: text(finding.claim),
      evidence: text(finding.evidence),
      confidence: finding.confidence ?? null,
    });
    return `đã ghi nhận finding: ${text(finding.file)}:${finding.line}-${endLine} ${text(finding.severity)}`;
  }

  return { report_finding, findings, changedFiles, lineCount };
}

export const REPORT_SPEC = Object.freeze({
  name: 'report_finding',
  description:
    'Báo một finding. Dòng tính theo phía head. severity: chặn | nên sửa | gợi ý. ' +
    'evidence bắt buộc. Trả lỗi nếu tham số sai để sửa lại.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'file thay đổi, đường dẫn tương đối trong repo' },
      line: { type: 'integer', minimum: 1, description: 'dòng bắt đầu phía head' },
      end_line: { type: 'integer', minimum: 1, description: 'dòng kết thúc phía head' },
      severity: { type: 'string', enum: [...SEVERITIES] },
      rule: { type: 'string' },
      claim: { type: 'string', description: 'câu mô tả ngắn' },
      evidence: { type: 'string', description: 'đoạn code/dẫn chứng, không được rỗng' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['file', 'line', 'severity', 'rule', 'claim', 'evidence'],
  },
});
