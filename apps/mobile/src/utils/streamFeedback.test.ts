import { formatStreamFeedbackStatus } from "@litter-bear/chat-core";

const current = {
  id: "workflow-2",
  type: "workflow.step.start",
  title: "正在整理出行计划",
  detail: "步骤 推荐路线",
  tone: "info" as const,
  display: "panel" as const,
  updatedAt: 0,
};

const toolDone = {
  id: "tool-1",
  type: "tool.call.done",
  title: "工具调用完成",
  detail: "已查询天气",
  toolSummary: "北京明天晴，最高 25 度",
  tone: "success" as const,
  display: "panel" as const,
  updatedAt: 0,
};

const text = formatStreamFeedbackStatus(current, [toolDone, current]);
const expected = "正在整理出行计划 · 步骤 推荐路线 · 工具反馈：北京明天晴，最高 25 度";

if (text !== expected) {
  throw new Error(`流光状态文案不符合预期：${text}`);
}
