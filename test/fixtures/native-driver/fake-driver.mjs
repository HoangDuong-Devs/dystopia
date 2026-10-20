// Driver giả cho test qua DYSTOPIA_NATIVE_DRIVER (không bao giờ gọi LLM).
// Kịch bản đọc từ DYSTOPIA_FAKE_SCENARIO:
//   { "model": "fake/model", "steps": [{"usage": {...}}, {"report": {...}}, {"call": "read_file", "args": {}}] }

import process from 'node:process';

export async function createDriver(options) {
  const scenario = JSON.parse(process.env.DYSTOPIA_FAKE_SCENARIO || '{}');
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const usage = { tokens_in: 0, tokens_out: 0 };
  let aborted = false;

  return {
    model: scenario.model ?? 'fake/driver-model',
    async prompt() {
      for (const step of steps) {
        if (aborted) break;
        if (step.usage) {
          usage.tokens_in += step.usage.tokens_in ?? 0;
          usage.tokens_out += step.usage.tokens_out ?? 0;
          options.onUsage?.(step.usage);
          continue;
        }
        try {
          if (step.report) await options.tools.report_finding(step.report);
          else if (step.call) await options.tools[step.call](step.args ?? {});
        } catch (error) {
          if (error?.code !== 'NATIVE_TRUNCATED') throw error;
          aborted = true;
        }
      }
    },
    async abort() {
      aborted = true;
    },
    usage() {
      return { ...usage };
    },
    async dispose() {},
  };
}
