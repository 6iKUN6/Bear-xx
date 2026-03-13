import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllByUser(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: { userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
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
      })),
      createdAt: c.createdAt.getTime(),
      updatedAt: c.updatedAt.getTime(),
    }));
  }

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

  async delete(id: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    await this.prisma.conversation.delete({ where: { id } });
  }

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
