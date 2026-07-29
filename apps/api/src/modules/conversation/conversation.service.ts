import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询指定用户的全部会话列表
   * @param userId 用户ID
   * @returns 返回会话列表，包含会话基础信息及已按时间正序排列的消息列表
   * @description 根据用户ID查询其全部会话，并按会话更新时间倒序返回，便于前端直接渲染历史聊天记录。
   */
  async findAllByUser(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      // 过滤掉 admin 测试会话：测试记录只在 admin 测试工作台可见，不进端侧列表。
      where: { userId, isTest: false },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            turnTraceItems: {
              orderBy: { sequence: 'asc' },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role.toLowerCase(),
        content: m.content,
        status: m.status.toLowerCase(),
        createdAt: m.createdAt.getTime(),
        trace: m.turnTraceItems.map((item) => ({
          id: item.id,
          type: item.type,
          status: item.status,
          title: item.title,
          summary: item.summary,
          durationMs: item.durationMs,
          depth: item.depth,
          sequence: item.sequence,
          metrics: item.metrics,
          toolName: item.toolName,
          parentId: item.parentId,
          inputSummary: item.inputSummary,
          outputSummary: item.outputSummary,
        })),
      })),
      createdAt: c.createdAt.getTime(),
      updatedAt: c.updatedAt.getTime(),
    }));
  }

  /**
   * 创建一个新的空会话
   * @param userId 用户ID
   * @param title 会话标题
   * @returns 返回新建会话的基础信息，初始消息列表为空
   * @description 为指定用户创建新的会话记录；如果未传 title，则使用默认标题“新对话”。
   */
  async create(userId: string, title?: string) {
    const conversation = await this.prisma.conversation.create({
      data: {
        userId,
        title: title || '新对话',
      },
    });

    return {
      id: conversation.id,
      title: conversation.title,
      messages: [],
      createdAt: conversation.createdAt.getTime(),
      updatedAt: conversation.updatedAt.getTime(),
    };
  }

  /**
   * 删除指定会话
   * @param id 会话ID
   * @param userId 用户ID
   * @returns 无返回值
   * @description 仅允许删除属于当前用户的会话；若会话不存在或不属于当前用户，则抛出异常。
   */
  async delete(id: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    await this.prisma.conversation.delete({ where: { id } });
  }

  /**
   * 校验会话归属关系
   * @param conversationId 会话ID
   * @param userId 用户ID
   * @returns 返回已确认归属的会话记录
   * @description 查询指定会话并确认其属于当前用户；若不存在或无权限访问，则抛出异常。
   */
  async ensureOwnership(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    return conversation;
  }
}
