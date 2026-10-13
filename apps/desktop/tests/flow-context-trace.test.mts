import assert from "node:assert/strict";
import test from "node:test";
import {
  toMessageStreamFeedback,
  toMessageStreamFeedbackFromTrace,
  buildStreamTraceRows,
} from "@litter-bear/chat-core";
import { StreamTaskEventType } from "@litter-bear/types/protocol";

const metrics = {
  invocations: [
    {
      callIndex: 1,
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 80,
      estimated: false,
    },
    {
      callIndex: 2,
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 0,
      estimated: false,
    },
    { callIndex: 3, inputTokens: 100, estimated: true },
  ],
  provider: "openai",
  model: "test",
  inputTokens: 9000,
  outputTokens: 1000,
  peakInputTokens: 3000,
  contextWindowTokens: 10000,
  contextUsagePercent: 30,
  contextUsageEstimated: false,
  inputTokenLimit: 8000,
  reasoning: { effort: "high" as const },
  contextSources: {
    conversation: "auto" as const,
    historyMessageCount: 3,
    summaryMessageCount: 20,
    upstream: [
      { nodeKey: "research", nodeExecutionId: "research#1", field: "text" },
    ],
  },
};

test("实时与历史模型记录显示同样的来源、峰值与累计消耗", () => {
  const live = toMessageStreamFeedback({
    type: StreamTaskEventType.ModelCallDone,
    data: { payload: metrics },
    rawData: "",
  });
  const history = toMessageStreamFeedbackFromTrace({
    id: "trace-1",
    type: "MODEL_CALL",
    status: "SUCCESS",
    title: "调用模型",
    depth: 0,
    sequence: 1,
    metrics,
  });
  assert.ok(live && history);
  const [liveRow] = buildStreamTraceRows([live], false);
  const [historyRow] = buildStreamTraceRows([history], false);
  assert.equal(liveRow.detail, historyRow.detail);
  assert.match(liveRow.detail!, /3,000 \/ 10,000/);
  assert.match(liveRow.detail!, /9,000/);
  assert.match(liveRow.detail!, /research.text/);
  assert.match(liveRow.detail!, /high/);
  assert.match(liveRow.detail!, /命中率 80%/);
  assert.match(liveRow.detail!, /命中率 0%/);
  assert.match(liveRow.detail!, /供应商未提供或未完整提供/);
  assert.match(liveRow.detail!, /逐次模型调用（3 次）/);
  assert.match(liveRow.detail!, /第 3 次.*估算/);
});

test("失败模型调用刷新后仍显示错误行和已经消耗的 token", () => {
  const history = toMessageStreamFeedbackFromTrace({
    id: "failed",
    type: "MODEL_CALL",
    status: "ERROR",
    title: "调用模型失败",
    depth: 0,
    sequence: 1,
    metrics,
  });
  assert.ok(history);
  const [row] = buildStreamTraceRows([history], false);
  assert.equal(row.status, "fail");
  assert.equal(row.inputTokens, 9000);
  const live = toMessageStreamFeedback({
    type: StreamTaskEventType.ModelCallDone,
    data: { payload: { ...metrics, status: "error" } },
    rawData: "",
  });
  assert.equal(live?.tone, "error");
});
