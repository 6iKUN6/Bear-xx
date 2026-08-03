import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Agent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentDefinitionService } from './agent-definition.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentResponseDto } from './dto/agent-response.dto';

/**
 * 智能体 CRUD
 * @description 管理数据化的智能体定义。写操作后失效 AgentDefinitionService 缓存。
 * 策略枚举合法性由 DTO @IsEnum 保证；工具组/技能的闭集成员性由运行时装配阶段优雅过滤，此处不硬失败。
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentDefinitionService: AgentDefinitionService,
  ) {}

  async list(): Promise<AgentResponseDto[]> {
    const agents = await this.prisma.agent.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return agents.map((agent) => this.toResponse(agent));
  }

  async get(id: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return this.toResponse(agent);
  }

  async create(dto: CreateAgentDto, userId: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.create({
      data: {
        name: dto.name,
        description: dto.description ?? '',
        avatar: dto.avatar?.trim() || null,
        systemPrompt: dto.systemPrompt ?? null,
        modelPreset: dto.modelPreset ?? null,
        defaultStrategy: dto.defaultStrategy ?? undefined,
        allowedStrategies: dto.allowedStrategies ?? [],
        toolGroups: dto.toolGroups ?? [],
        skills: dto.skills ?? [],
        maxSteps: dto.maxSteps ?? null,
        enabled: dto.enabled ?? true,
        createdById: userId,
      },
    });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<AgentResponseDto> {
    await this.ensureExists(id);
    const agent = await this.prisma.agent.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        // undefined=不改；null/空串=清空回默认头像
        avatar:
          dto.avatar === undefined ? undefined : dto.avatar?.trim() || null,
        systemPrompt: dto.systemPrompt,
        modelPreset: dto.modelPreset,
        defaultStrategy: dto.defaultStrategy,
        allowedStrategies: dto.allowedStrategies,
        toolGroups: dto.toolGroups,
        skills: dto.skills,
        maxSteps: dto.maxSteps,
        enabled: dto.enabled,
      },
    });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async remove(id: string): Promise<void> {
    const agent = await this.ensureExists(id);
    if (agent.isDefault) {
      throw new BadRequestException('默认智能体不可删除');
    }
    await this.prisma.agent.delete({ where: { id } });
    this.agentDefinitionService.invalidate();
  }

  private async ensureExists(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return agent;
  }

  private toResponse(agent: Agent): AgentResponseDto {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      avatar: agent.avatar,
      systemPrompt: agent.systemPrompt,
      modelPreset: agent.modelPreset,
      defaultStrategy: agent.defaultStrategy,
      allowedStrategies: agent.allowedStrategies,
      toolGroups: agent.toolGroups,
      skills: agent.skills,
      maxSteps: agent.maxSteps,
      enabled: agent.enabled,
      isDefault: agent.isDefault,
      createdAt: agent.createdAt.getTime(),
      updatedAt: agent.updatedAt.getTime(),
    };
  }
}
