/**
 * HITL（人工审批）中断与恢复的共用逻辑
 *
 * 抽成纯函数模块：ReAct 链路（`common-chat-agent-loop.service`）与 plan/hybrid 编排图
 * （`plan-graph.runner`）都要挂中间件、读中断、发 approval.required、把人工决定映射回
 * HITLResponse。这四件事必须完全一致——两边各写一份，审批语义立刻漂移。
 *
 * 不做 Nest service：没有依赖也没有实例状态，包一层 DI 只是增加间接层。
 */

import { humanInTheLoopMiddleware, type AnyAgentMiddleware } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  ApprovalDecision,
  ApprovalDecisionType,
} from '@litter-bear/types/protocol';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import type { CommonChatAgentStreamEvent } from './common-chat-agent.types';

/** HITL 中断值里的单个待审动作（humanInTheLoopMiddleware 通过 interrupt() 抛出） */
export interface HitlActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

export interface HitlReviewConfig {
  actionName: string;
  allowedDecisions: ApprovalDecisionType[];
}

/** HITL 中断值（HITLRequest） */
export interface HitlRequestValue {
  actionRequests?: HitlActionRequest[];
  reviewConfigs?: HitlReviewConfig[];
}

/** HITL 恢复值（Command.resume 回传的 HITLResponse.decisions 元素） */
export type HitlDecision =
  | { type: 'approve' }
  | {
      type: 'edit';
      editedAction: { name: string; args: Record<string, unknown> };
    }
  | { type: 'reject'; message?: string };

/**
 * 可读取中断状态的最小图接口
 * @description ReactAgent 门面与编译后的 StateGraph 都有 getState，
 * 这里只声明用得到的那一点，绕开 langchain / langgraph 的重型泛型。
 */
export interface InterruptReadable {
  getState(config: Record<string, unknown>): Promise<{
    tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>;
    values?: { messages?: BaseMessage[] };
  }>;
}

/**
 * 构建 HITL 中间件
 * @param toolNames 需要人工审批的工具名
 * @returns 返回可传给 createAgent 的中间件数组
 * @description 三态决定（通过/改参/拒绝）对所有受审工具一致；工具执行前中断。
 */
export function buildHitlMiddleware(toolNames: string[]): AnyAgentMiddleware[] {
  const interruptOn: Record<
    string,
    { allowedDecisions: ApprovalDecisionType[]; description: string }
  > = {};

  for (const name of toolNames) {
    interruptOn[name] = {
      allowedDecisions: ['approve', 'edit', 'reject'],
      description: `请确认是否执行工具「${name}」`,
    };
  }

  return [humanInTheLoopMiddleware({ interruptOn })];
}

/**
 * 读取挂起中断的原始值（不区分类型）
 * @param graph 已运行到中断的 agent 或编排图
 * @param threadId 会话标识（= taskId）
 * @returns 首个挂起中断的 value；无挂起返回 undefined
 * @description 中断是图状态，只能从 getState 读；编排图里中断发生在子图内，
 * 外层 getState 同样读得到（已实测穿透）。工具审批与计划审批的 value 形状不同，
 * 由调用方按形状分流，故这里只返回原始值。
 */
export async function readRawInterrupt(
  graph: InterruptReadable,
  threadId: string,
): Promise<unknown> {
  const state = await graph.getState({
    configurable: { thread_id: threadId },
  });
  const interrupts = (state.tasks ?? []).flatMap(
    (task) => task.interrupts ?? [],
  );
  return interrupts[0]?.value;
}

/**
 * 从 checkpointer 状态读取挂起的工具 HITL 中断值
 * @returns 中断的 HITLRequest 值；无挂起或非工具审批则返回 undefined
 */
export async function readInterruptValue(
  graph: InterruptReadable,
  threadId: string,
): Promise<HitlRequestValue | undefined> {
  const value = await readRawInterrupt(graph, threadId);
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * 从已读取的工具 HITL 中断值生成 approval.required 事件
 * @param value 工具 HITL 中断值（HITLRequest）
 * @param nodeKey 事件的节点标识（ReAct 与编排图各自标注来源）
 * @returns 每个待审动作一个事件
 */
export function* emitApprovalFromValue(
  value: HitlRequestValue,
  nodeKey: string,
): Generator<CommonChatAgentStreamEvent, void, unknown> {
  const reviewConfigs = value.reviewConfigs ?? [];
  const actionRequests = value.actionRequests ?? [];

  for (let index = 0; index < actionRequests.length; index++) {
    const action = actionRequests[index];
    const review = reviewConfigs.find(
      (item) => item.actionName === action.name,
    );

    yield {
      type: StreamTaskEventType.ApprovalRequired,
      payload: {
        toolName: action.name,
        args: stringifyArgs(action.args),
        description: action.description,
        allowedDecisions: review?.allowedDecisions ?? ['approve', 'reject'],
        index,
        nodeKey,
        traceKey: `approval:${action.name}:${index}`,
        publicStatus: '待人工确认',
      },
    };
  }
}

/**
 * 检测挂起的工具人工审批并生成 approval.required 事件
 * @param graph 已运行到中断的 agent 或编排图
 * @param threadId 会话标识
 * @param nodeKey 事件的节点标识
 * @returns 每个待审动作一个事件；无挂起则不产出
 */
export async function* emitPendingApproval(
  graph: InterruptReadable,
  threadId: string,
  nodeKey: string,
): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
  const value = await readInterruptValue(graph, threadId);
  if (!value) {
    return;
  }
  yield* emitApprovalFromValue(value, nodeKey);
}

/**
 * 把人工决定映射为 HITLResponse
 * @description approve → 执行；reject → 回注拒绝说明；edit → 用改后入参执行。
 * 每个 actionRequest 对应一个决定。
 */
export function buildHitlResponse(
  decision: ApprovalDecision,
  actionRequests: HitlActionRequest[],
): { decisions: HitlDecision[] } {
  const count = Math.max(1, actionRequests.length);
  const decisions: HitlDecision[] = [];

  for (let index = 0; index < count; index++) {
    const action: HitlActionRequest | undefined = actionRequests[index];

    if (decision.decision === 'approve') {
      decisions.push({ type: 'approve' });
    } else if (decision.decision === 'reject') {
      decisions.push({ type: 'reject', message: decision.reason });
    } else {
      decisions.push({
        type: 'edit',
        editedAction: {
          name: action?.name ?? '',
          args: decision.editedArgs ?? action?.args ?? {},
        },
      });
    }
  }

  return { decisions };
}

function stringifyArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  try {
    return typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    return undefined;
  }
}
