import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { LlmMessage } from '../llm/llm.types';
import { ConversationSummaryService } from './conversation-summary.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';

export interface ChatContextBundle {
  messages: LlmMessage[];
  summary?: {
    content: string;
    latestMessageId?: string;
    messageCount: number;
  };
  recentWindow: {
    limit: number;
    messageCount: number;
  };
}

@Injectable()
export class ChatContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationSummaryService: ConversationSummaryService,
  ) {}

  /**
   * 构建聊天上下文消息列表
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @returns 返回可直接传给 LLM 的上下文消息列表
   * @description 组合会话摘要和最近窗口消息，替代全量历史回放，减少长会话的上下文长度和查询负担。
   */
  async buildChatMessages(
    conversationId: string,
    pendingMessageId: string,
    answeringAgentId?: string | null,
  ): Promise<LlmMessage[]> {
    const bundle = await this.buildContextBundle(
      conversationId,
      pendingMessageId,
      answeringAgentId,
    );
    return bundle.messages;
  }

  /**
   * 构建聊天上下文包
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @param answeringAgentId 本轮回答者智能体 id；null/undefined = 默认助手
   * @returns 返回包含 LLM 消息、摘要信息和最近窗口信息的上下文包
   * @description 以“较早历史摘要 + 最近消息窗口”为核心。群聊会话（历史中存在其它智能体的发言）时做身份感知转写：
   * 回答者自己的消息保持 assistant 角色，其它智能体的消息转写为带署名的 user 侧记录，
   * 避免模型把别的助手说过的话当成自己说的。单助手会话路径与原实现完全一致。
   */
  async buildContextBundle(
    conversationId: string,
    pendingMessageId: string,
    answeringAgentId?: string | null,
  ): Promise<ChatContextBundle> {
    const summary =
      await this.conversationSummaryService.getConversationSummary(
        conversationId,
      );
    const recentMessages = await this.prisma.message.findMany({
      where: {
        conversationId,
        id: { not: pendingMessageId },
      },
      select: {
        role: true,
        content: true,
        agentId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
    });

    const orderedMessages = recentMessages.reverse();
    const currentAgentId = answeringAgentId ?? null;

    // 群语境判定：历史 assistant 消息中存在与本轮回答者不同的发言者（null 视为默认助手，同一身份）。
    const foreignAgentIds = new Set(
      orderedMessages
        .filter(
          (m) =>
            m.role === MessageRole.ASSISTANT &&
            (m.agentId ?? null) !== currentAgentId,
        )
        .map((m) => m.agentId ?? null),
    );
    const isGroupContext = foreignAgentIds.size > 0;
    const agentNameById = isGroupContext
      ? await this.loadAgentNames(foreignAgentIds)
      : new Map<string | null, string>();

    const contextMessages: LlmMessage[] = [];

    if (isGroupContext) {
      contextMessages.push({
        role: 'system',
        content: this.formatGroupContextMessage(),
      });
    }

    if (summary?.summary) {
      contextMessages.push({
        role: 'system',
        content: this.formatSummaryContextMessage(summary.summary),
      });
    }

    const messages = contextMessages.concat(
      orderedMessages.map((message) => {
        if (
          isGroupContext &&
          message.role === MessageRole.ASSISTANT &&
          (message.agentId ?? null) !== currentAgentId
        ) {
          // 其它智能体的发言：转写为带署名的 user 侧记录，让模型知道这是群里别人说的。
          const name = agentNameById.get(message.agentId ?? null) ?? '助手';
          return {
            role: 'user' as const,
            content: `[助手·${name}]: ${message.content}`,
          };
        }
        return {
          role: this.toLlmMessageRole(message.role),
          content: message.content,
        };
      }),
    );

    return {
      messages,
      summary: summary?.summary
        ? {
            content: summary.summary,
            latestMessageId: summary.latestMessageId ?? undefined,
            messageCount: summary.messageCount,
          }
        : undefined,
      recentWindow: {
        limit: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
        messageCount: recentMessages.length,
      },
    };
  }

  /**
   * 批量加载智能体显示名
   * @param agentIds 其它发言者 id 集合（可含 null=默认助手）
   * @returns 返回 id → 名称映射；null 键映射到默认智能体名（查不到则“默认助手”）
   */
  private async loadAgentNames(
    agentIds: Set<string | null>,
  ): Promise<Map<string | null, string>> {
    const nameById = new Map<string | null, string>();
    const concreteIds = [...agentIds].filter((id): id is string => id !== null);

    if (concreteIds.length > 0) {
      const agents = await this.prisma.agent.findMany({
        where: { id: { in: concreteIds } },
        select: { id: true, name: true },
      });
      for (const agent of agents) {
        nameById.set(agent.id, agent.name);
      }
    }

    if (agentIds.has(null)) {
      const defaultAgent = await this.prisma.agent.findFirst({
        where: { isDefault: true },
        select: { name: true },
      });
      nameById.set(null, defaultAgent?.name ?? '默认助手');
    }

    return nameById;
  }

  /**
   * 群聊语境说明
   * @returns 返回注入 LLM 的 system 消息内容
   * @description 告知模型处于多助手协作对话，历史中带署名的记录来自其它助手，只需以自己的身份回答。
   */
  private formatGroupContextMessage() {
    return [
      '当前是一个多助手协作对话：用户可以点名不同的智能助手回答。',
      '历史消息中形如「[助手·某某]: 内容」的记录是其它助手的发言，不是你说的，也不是用户说的。',
      '请以你自己的身份直接回答用户，不要模仿该署名格式，也不要替其它助手发言。',
    ].join('\n');
  }

  /**
   * 转换消息角色
   * @param role 数据库中的消息角色枚举
   * @returns 返回 LLM 可识别的消息角色
   * @description 将数据库层的 USER 和 ASSISTANT 枚举转换为统一的 LLM 消息角色字符串，避免在调用方重复判断。
   */
  private toLlmMessageRole(role: MessageRole): 'user' | 'assistant' {
    return role === MessageRole.USER ? 'user' : 'assistant';
  }

  /**
   * 格式化摘要上下文消息
   * @param summary 会话较早历史摘要
   * @returns 返回注入 LLM 的 system 上下文消息
   * @description 明确摘要只用于延续上下文，并要求最近消息优先于摘要，降低旧摘要和最新对话冲突时的误用风险。
   */
  private formatSummaryContextMessage(summary: string) {
    return [
      '以下是当前会话较早历史的压缩摘要，只用于延续上下文，不要向用户暴露摘要本身。',
      '如果摘要与最近消息冲突，优先相信最近消息。',
      '',
      summary,
    ].join('\n');
  }
}
