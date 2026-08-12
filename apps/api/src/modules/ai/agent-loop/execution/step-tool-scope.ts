/**
 * 分步上下文中间件：把「本步提示词」与「本步允许工具」注入共享的 ReAct 执行器
 *
 * 背景：plan/hybrid 每步共用同一个 ReAct 执行器（单一编译子图，为了 HITL 中断穿透与流式
 * 不能每步换执行器，也不能每步换构造期的 systemPrompt/tools）。而实测发现：
 *   1. 把编译子图作为外层节点嵌入时，prepare_step 通过 messages 注入的**前导步骤提示词**
 *      （无论 System 还是 Human）到不了子图的模型调用——子图只看到原始对话。于是每步模型都
 *      看到完整用户请求 + 全部工具，把后续步骤的工具（如 generateImage）也顺手调了。
 *   2. 但**自定义 state 通道**能可靠地从外层图传进子图，并在子图的 `wrapModelCall` 里读到。
 * 故本中间件走 state 通道：
 *   - `stepInstruction` → 本次模型调用的 systemPrompt（步骤聚焦 + 已有观察，真正送达模型）；
 *   - `stepAllowedTools` → 本步的建议工具（planner 标注）；
 *   - `scopedApprovalTools` → 需要按步隔离的审批类工具 = 审批工具 ∩「计划里被某步标注过」。
 *     只对「计划确实安排了它」的审批工具做隔离；计划从没标注的审批工具不隔离（否则会把它
 *     锁死到永远不可调用，比原 bug 更糟）。
 *
 * 工具可见规则：保留工具 T ⟺ T 不在 scopedApprovalTools（只读工具，或计划没安排的审批工具），
 * 或 T 在本步 stepAllowedTools 里。即：被隔离的审批工具只在明确安排它的步骤可见；
 * 只读工具始终可见。硬隔离——模型看不到的工具就无从调用。
 */

import { createMiddleware } from 'langchain';
import { z } from 'zod';

interface NamedTool {
  name?: string;
}
interface StepContextRequest {
  systemPrompt?: string;
  tools?: NamedTool[];
  state?: {
    stepInstruction?: string;
    stepAllowedTools?: string[];
    scopedApprovalTools?: string[];
  };
}

/**
 * 创建分步上下文中间件（完全由 state 驱动）
 * @returns 可挂到 createAgent 的中间件
 */
export function createStepContextMiddleware() {
  return createMiddleware({
    name: 'StepContext',
    // 声明 state 通道，使外层图设置的同名字段能传进子图并在此读到
    stateSchema: z.object({
      stepInstruction: z.string().optional(),
      stepAllowedTools: z.array(z.string()).optional(),
      scopedApprovalTools: z.array(z.string()).optional(),
    }),
    wrapModelCall: (request: StepContextRequest, handler) => {
      const instruction = request.state?.stepInstruction;
      const allowedSet = new Set(request.state?.stepAllowedTools ?? []);
      const scopedSet = new Set(request.state?.scopedApprovalTools ?? []);

      const next: StepContextRequest = { ...request };

      // 步骤提示词作为本次模型调用的 systemPrompt 送达（这是 messages 注入到不了的补救）
      if (instruction) {
        next.systemPrompt = instruction;
      }

      // 只在有需要隔离的审批工具时才过滤，避免无谓改动工具集
      if (scopedSet.size > 0) {
        next.tools = (request.tools ?? []).filter((tool) => {
          const name = tool?.name;
          if (name && scopedSet.has(name)) {
            return allowedSet.has(name);
          }
          return true;
        });
      }

      return handler(next as never);
    },
  });
}
