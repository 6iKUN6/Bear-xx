/**
 * plan/hybrid 的提示词拼装
 *
 * 从 AgentLoopController 原样搬出：迁 StateGraph 只换编排载体，
 * 提示词语义必须保持逐字一致，否则回归时分不清是"图错了"还是"提示词变了"。
 */

import type { AgentLoopInput } from '../agent-loop.types';
import type { PlanStep } from './plan.types';

/**
 * 构建单步执行提示词
 * @param input agent loop 输入上下文
 * @param plan 本轮任务计划
 * @param step 当前步骤
 * @param observations 此前各步收集到的观察
 * @returns 返回该步骤的系统提示词
 * @description 只让模型专注当前步骤，并把已有观察作为上下文注入，避免重复整体计划。
 */
export function buildStepPrompt(
  input: AgentLoopInput,
  steps: readonly PlanStep[],
  step: PlanStep,
  observations: string[],
): string {
  const sections: string[] = [];
  if (input.systemPrompt) {
    sections.push(input.systemPrompt);
  }

  // 计划概览标出当前步：给模型连贯感，但下面的工具约束会明确禁止它越界执行后续步骤。
  const currentIndex = steps.findIndex((item) => item.id === step.id);
  sections.push(
    `## 任务计划（你只负责其中一步）\n${steps
      .map(
        (item, index) =>
          `${index + 1}. ${item.goal}${index === currentIndex ? '  ← 当前步骤' : ''}`,
      )
      .join('\n')}`,
  );
  sections.push(`## 当前步骤\n${step.goal}`);

  if (observations.length > 0) {
    sections.push(
      `## 已有信息\n${observations
        .map((text, index) => `【步骤${index + 1}】${text}`)
        .join('\n')}`,
    );
  }

  // 工具边界：这是防「每步都顺手生图/下单」的关键。计划给了本步建议工具就按它收窄，
  // 并显式禁止调用不属于本步的工具（后续步骤会单独执行）。没给建议工具则按需自取。
  const allowed = step.suggestedTools?.filter((name) => name.length > 0) ?? [];
  if (allowed.length > 0) {
    sections.push(
      `## 工具边界（必须遵守）\n本步骤**只允许**调用这些工具：${allowed.join('、')}。` +
        '严禁调用不在此列的任何工具——尤其是生成图片、下单等有成本/副作用的工具，' +
        '它们属于后续步骤，会在各自步骤单独执行。若本步骤不需要工具，直接用已有信息作答。',
    );
  } else {
    sections.push(
      '## 工具边界（必须遵守）\n本步骤按需调用工具即可；同一工具只调用一次，拿到结果就作答。' +
        '严禁提前执行后续步骤才需要的工具（如生成图片、下单等有成本/副作用的动作）。',
    );
  }

  sections.push(
    '只专注完成"当前步骤"，简洁输出该步骤的结果，不要重复整体计划。',
  );

  return sections.join('\n\n');
}

/**
 * 构建最终综合提示词
 * @param input agent loop 输入上下文
 * @param observations 各步骤收集到的观察
 * @returns 返回综合回答的系统提示词
 * @description 基于全部观察做一次收敛回答，不暴露内部步骤与工具细节。
 */
export function buildSynthesisPrompt(
  input: AgentLoopInput,
  observations: string[],
): string {
  const sections: string[] = [];
  if (input.systemPrompt) {
    sections.push(input.systemPrompt);
  }

  if (observations.length > 0) {
    sections.push(
      `## 已收集的信息\n${observations
        .map((text, index) => `【步骤${index + 1}】${text}`)
        .join('\n')}`,
    );
  }

  sections.push(
    '请基于以上已收集的信息，直接、完整地回答用户的请求；不要提及内部步骤、计划或工具细节。',
  );

  return sections.join('\n\n');
}
