import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MessageRole, MessageStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  conversationSummaryFullPrompt,
  conversationSummaryIncrementalPrompt,
} from '../../prompts';
import {
  estimateContextTextTokens,
  estimateContextTokens,
} from './context-budget';

export interface SummarySourceMessage {
  id: string;
  role: MessageRole;
  content: string;
  agentId?: string | null;
}

export interface ConversationSummaryValue {
  summary: string;
  latestMessageId: string | null;
  messageCount: number;
  sourceDigest: string | null;
}

export interface SummaryOptions {
  modelPreset?: string;
  maxOutputTokens?: number;
  onModelCall?: () => void | Promise<void>;
}

/**
 * 标识摘要覆盖的有序消息
 * @param messages 已冻结边界内的来源消息
 * @returns 不含正文的内容摘要
 * @description 同时校验顺序、角色、发言者和正文，禁止把其它范围或旧实现的摘要当成可复用前缀。
 */
export function summarySourceDigest(
  messages: readonly SummarySourceMessage[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        messages.map(({ id, role, content, agentId }) => [
          id,
          role,
          content,
          agentId ?? null,
        ]),
      ),
    )
    .digest('hex');
}

@Injectable()
export class ConversationSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 获取当前已保存摘要
   * @param conversationId 会话标识
   * @returns 当前摘要或空值
   * @description 读取方必须校验它是否属于自己的冻结历史前缀。
   */
  getConversationSummary(conversationId: string) {
    return this.prisma.conversationSummary.findUnique({
      where: { conversationId },
    });
  }

  /**
   * 按明确的历史前缀生成或增量更新摘要
   * @param conversationId 所属会话
   * @param sourceMessages 本轮决定压缩的消息，省略时读取已完成历史
   * @param options 摘要模型、输出预算和计费回调
   * @returns 覆盖给定前缀的摘要；没有来源时为空
   * @description 在主模型调用前按需执行；长输入逐块摘要，不再仅取最后 80 条。并发写用比较更新，旧任务不能覆盖更长的新摘要。
   */
  async refreshConversationSummary(
    conversationId: string,
    sourceMessages?: readonly SummarySourceMessage[],
    options: SummaryOptions = {},
  ): Promise<ConversationSummaryValue | null> {
    const messages =
      sourceMessages ??
      (await this.prisma.message.findMany({
        where: { conversationId, status: MessageStatus.DONE },
        select: { id: true, role: true, content: true, agentId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }));
    if (messages.length === 0) return null;
    const limits = this.modelRegistry.getContextLimits(options.modelPreset);
    const maxOutputTokens = Math.min(
      options.maxOutputTokens ?? 2048,
      limits.maxOutputTokens,
    );
    const existing = await this.getConversationSummary(conversationId);
    const reusable =
      existing &&
      existing.messageCount <= messages.length &&
      existing.sourceDigest ===
        summarySourceDigest(messages.slice(0, existing.messageCount));
    let summary = reusable ? existing.summary : '';
    let offset = reusable ? existing.messageCount : 0;
    const sourceDigest = summarySourceDigest(messages);
    if (
      offset === messages.length &&
      estimateContextTextTokens(summary) <= maxOutputTokens * 2
    )
      return existing;
    // 小模型需要更短摘要时从原始前缀重建，不用过长的旧摘要挤占新消息空间。
    if (
      offset === messages.length ||
      estimateContextTextTokens(summary) > maxOutputTokens * 2
    ) {
      summary = '';
      offset = 0;
    }
    const inputBudget = Math.floor(
      (limits.contextWindowTokens - maxOutputTokens) * 0.7,
    );
    const chunkTokens = inputBudget - maxOutputTokens * 2 - 1200;
    if (chunkTokens < 128)
      throw new BadRequestException(
        '模型上下文容量不足以生成会话摘要，请调整模型配置',
      );
    // 每个 UTF-16 单元至多三个 UTF-8 字节，预留标签空间后按字符块保证摘要请求本身也有界。
    const chunkChars = Math.max(1, Math.floor(((chunkTokens - 128) * 2) / 3));
    const sourceText = messages
      .slice(offset)
      .map((message) => {
        const speaker =
          message.role === MessageRole.USER
            ? '用户'
            : `助手${message.agentId ? ' ' + message.agentId : ''}`;
        return `【${speaker}】\n${message.content}`;
      })
      .join('\n\n');
    for (
      let start = 0;
      start < Math.max(1, sourceText.length);
      start += chunkChars
    ) {
      const content = sourceText.slice(start, start + chunkChars);
      const prompt = [
        {
          role: 'system' as const,
          content: summary
            ? conversationSummaryIncrementalPrompt
            : conversationSummaryFullPrompt,
        },
        {
          role: 'user' as const,
          content: `${summary ? '已有摘要：\n' + summary + '\n\n' : ''}新增历史片段：\n${content}\n\n摘要长度预算约 ${maxOutputTokens} token；只返回更新后的完整摘要。`,
        },
      ];
      if (estimateContextTokens(prompt) > inputBudget)
        throw new BadRequestException('会话摘要输入超出模型预算');
      await options.onModelCall?.();
      summary = (
        await this.llmService.generateChatText(prompt, {
          model: { modelId: limits.modelPreset },
          generation: { maxOutputTokens },
        })
      ).trim();
      if (!summary) throw new Error('会话摘要生成失败：模型返回空内容');
      if (estimateContextTextTokens(summary) > maxOutputTokens * 2)
        throw new Error('会话摘要生成失败：模型返回内容超出摘要预算');
    }
    const value: ConversationSummaryValue = {
      summary,
      latestMessageId: messages[messages.length - 1].id,
      messageCount: messages.length,
      sourceDigest,
    };
    // upsert 仅负责并发首次创建；已有行的替换必须比较读取版本，不能倒退覆盖其它任务成果。
    await this.prisma.conversationSummary.upsert({
      where: { conversationId },
      create: { conversationId, ...value },
      update: {},
    });
    if (existing && existing.messageCount <= messages.length) {
      await this.prisma.conversationSummary.updateMany({
        where: {
          conversationId,
          updatedAt: existing.updatedAt,
          sourceDigest: existing.sourceDigest,
        },
        data: value,
      });
    }
    return value;
  }
}
