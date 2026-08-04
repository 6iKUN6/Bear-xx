/**
 * 审批卡片组装器（设计稿，待 review 后接线到 approval.required 事件）
 *
 * 接线计划：
 * 1. agent loop 触发审批中断处，用本组装器产出 ApprovalCardData，
 *    挂到 ApprovalRequiredPayload.card 字段随事件下发；
 * 2. 第一期只走 buildFromTemplate（规则模板，零模型开销、零延迟）；
 * 3. 第二期接 enhanceWithAi：小模型结构化输出 title/summary/riskLevel/
 *    warnings，校验通过才替换模板文案，失败静默保留模板结果。
 */
import { Injectable } from '@nestjs/common';
import {
  APPROVAL_CARD_VERSION,
  type ApprovalCardData,
  type ApprovalCardField,
  type ApprovalDecisionType,
} from '@litter-bear/types/protocol';

/** 参数值展示上限：过长截断，防止巨型 args 撑爆卡片 */
const FIELD_VALUE_MAX_LENGTH = 120;
/** warnings 条数上限（AI 生成侧同样裁剪） */
const MAX_WARNINGS = 3;

export interface ApprovalCardContext {
  toolName: string;
  /** 工具入参（原始对象） */
  args: Record<string, unknown>;
  /** 工具描述（来自工具定义，模板 summary 的原料） */
  toolDescription?: string;
  /** 允许的决定（来自 CapabilityRegistry / 事件既有字段，代码事实源） */
  allowedDecisions: ApprovalDecisionType[];
}

@Injectable()
export class ApprovalCardBuilder {
  /**
   * 规则模板组装（兜底通道，第一期唯一通道）
   * @description 纯代码拼装：标题=工具名，summary=工具描述改写，
   * fields=args 逐项展开（截断）。不依赖模型，审批可用性与 AI 解耦。
   */
  buildFromTemplate(context: ApprovalCardContext): ApprovalCardData {
    return {
      version: APPROVAL_CARD_VERSION,
      title: `调用工具：${context.toolName}`,
      riskLevel: 'medium',
      summary: context.toolDescription
        ? `该操作将执行「${context.toolName}」——${context.toolDescription}`
        : `该操作将执行工具「${context.toolName}」，请确认参数无误后批准。`,
      fields: this.buildFields(context.args),
      decisions: context.allowedDecisions,
      source: 'template',
    };
  }

  /**
   * AI 增强通道（第二期接线，当前留白）
   * @description 设计：用低成本模型对 context 做结构化输出
   * （目标 schema = ApprovalCardAiFields），经 class-validator/zod 校验后
   * 替换模板卡的文案字段；decisions/fields 结构字段永不接受 AI 值。
   * 校验失败/超时（建议 2s 预算）→ 原样返回模板卡，source 保持 template。
   */
  async enhanceWithAi(
    templateCard: ApprovalCardData,
    _context: ApprovalCardContext,
  ): Promise<ApprovalCardData> {
    // TODO(review 后实现)：llmService 结构化输出 → 校验 → 合并文案字段
    // 并把 source 置为 'ai'；warnings 裁剪到 MAX_WARNINGS。
    await Promise.resolve();
    return templateCard;
  }

  /** args → 展示行：单层展开，值序列化后截断；嵌套对象整体 JSON 化 */
  private buildFields(args: Record<string, unknown>): ApprovalCardField[] {
    return Object.entries(args).map(([label, rawValue]) => {
      const value =
        typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
      return {
        label,
        value:
          value.length > FIELD_VALUE_MAX_LENGTH
            ? `${value.slice(0, FIELD_VALUE_MAX_LENGTH)}…`
            : value,
      };
    });
  }
}

// 常量导出供接线时的 AI 侧复用
export { MAX_WARNINGS };
