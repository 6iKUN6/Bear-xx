import {
  STREAM_TASK_EVENT_LABELS,
  StreamTaskEventType,
  type FlowWaitingHumanPayload,
} from "./index.js";

describe("AgentFlow 流式协议", () => {
  it("为运行、节点与人工等待事件提供稳定类型和中文文案", () => {
    expect(StreamTaskEventType.FlowRunStarted).toBe("flow.run.started");
    expect(StreamTaskEventType.FlowNodeStarted).toBe("flow.node.started");
    expect(StreamTaskEventType.FlowNodeCompleted).toBe("flow.node.completed");
    expect(StreamTaskEventType.FlowNodeFailed).toBe("flow.node.failed");
    expect(StreamTaskEventType.FlowWaitingHuman).toBe("flow.waiting_human");
    expect(StreamTaskEventType.FlowRunResumed).toBe("flow.run.resumed");
    expect(STREAM_TASK_EVENT_LABELS[StreamTaskEventType.FlowWaitingHuman]).toBe(
      "等待人工确认",
    );
  });

  it("用可判别载荷承载工具与计划审批卡片所需字段", () => {
    const toolWaiting = {
      type: StreamTaskEventType.FlowWaitingHuman,
      payload: {
        approvalId: "approval-tool-1",
        nodeKey: "execute",
        traceKey: "flow:execute:approval",
        expiresAt: "2026-08-16T03:00:00.000Z",
        approval: {
          kind: "tool",
          requests: [
            {
              toolName: "create-order",
              args: '{"storeId":"masked"}',
              description: "请确认是否创建订单",
              index: 0,
            },
            {
              toolName: "cancel-order",
              args: '{"orderId":"masked"}',
              description: "请确认是否取消订单",
              index: 1,
            },
          ],
          allowedDecisions: ["approve", "reject", "edit"],
        },
      },
    } satisfies {
      type: StreamTaskEventType.FlowWaitingHuman;
      payload: FlowWaitingHumanPayload;
    };
    const planWaiting = {
      type: StreamTaskEventType.FlowWaitingHuman,
      payload: {
        approvalId: "approval-plan-1",
        nodeKey: "review",
        traceKey: "flow:review:approval",
        expiresAt: "2026-08-16T03:00:00.000Z",
        approval: {
          kind: "plan-review",
          steps: [{ id: "step-1", goal: "查询天气" }],
          revision: 0,
          allowedDecisions: [
            "approve",
            "edit",
            "reject_replan",
            "reject_terminate",
          ],
        },
      },
    } satisfies {
      type: StreamTaskEventType.FlowWaitingHuman;
      payload: FlowWaitingHumanPayload;
    };

    expect(toolWaiting.payload.approval.kind).toBe("tool");
    if (toolWaiting.payload.approval.kind === "tool") {
      expect(toolWaiting.payload.approval.requests).toHaveLength(2);
    }
    expect(planWaiting.payload.approval.kind).toBe("plan-review");
  });
});
