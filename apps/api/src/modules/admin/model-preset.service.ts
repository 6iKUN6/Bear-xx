import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModelPreset } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import type {
  CreateModelPresetDto,
  ModelPresetResponseDto,
  UpdateModelPresetDto,
} from './dto/model-preset.dto';

/** platform → 对应的 env 密钥变量名（仅用于“是否已配置”只读检测，绝不返回密钥值） */
const PLATFORM_ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  kimi: 'KIMI_API_KEY',
  doubao: 'DOUBAO_API_KEY',
};

/**
 * 模型预设 CRUD（管理端）
 * @description 仅管理元数据；apiKey 永不落库、永不返回，运行时由 registry 按 platform 从 env 取。
 * 写操作后失效 LlmModelRegistry 缓存，使新预设即时生效。
 */
@Injectable()
export class ModelPresetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly registry: LlmModelRegistryService,
  ) {}

  async list(): Promise<ModelPresetResponseDto[]> {
    const rows = await this.prisma.modelPreset.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  async get(id: string): Promise<ModelPresetResponseDto> {
    const row = await this.prisma.modelPreset.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('模型预设不存在');
    }
    return this.toResponse(row);
  }

  async create(dto: CreateModelPresetDto): Promise<ModelPresetResponseDto> {
    const exists = await this.prisma.modelPreset.findUnique({
      where: { presetId: dto.presetId },
    });
    if (exists) {
      throw new BadRequestException(`预设 id 已存在：${dto.presetId}`);
    }
    const row = await this.prisma.modelPreset.create({
      data: {
        presetId: dto.presetId,
        name: dto.name,
        description: dto.description ?? '',
        provider: dto.provider,
        platform: dto.platform,
        model: dto.model,
        baseURL: dto.baseURL ?? null,
        temperature: dto.temperature ?? null,
        maxOutputTokens: dto.maxOutputTokens ?? null,
        topP: dto.topP ?? null,
        enabled: dto.enabled ?? true,
        isDefault: dto.isDefault ?? false,
      },
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  async update(
    id: string,
    dto: UpdateModelPresetDto,
  ): Promise<ModelPresetResponseDto> {
    await this.ensureExists(id);
    const row = await this.prisma.modelPreset.update({
      where: { id },
      data: {
        presetId: dto.presetId,
        name: dto.name,
        description: dto.description,
        provider: dto.provider,
        platform: dto.platform,
        model: dto.model,
        baseURL: dto.baseURL,
        temperature: dto.temperature,
        maxOutputTokens: dto.maxOutputTokens,
        topP: dto.topP,
        enabled: dto.enabled,
        isDefault: dto.isDefault,
      },
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.ensureExists(id);
    if (row.isDefault) {
      throw new BadRequestException('默认模型预设不可删除');
    }
    await this.prisma.modelPreset.delete({ where: { id } });
    await this.registry.invalidate();
  }

  private async ensureExists(id: string): Promise<ModelPreset> {
    const row = await this.prisma.modelPreset.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('模型预设不存在');
    }
    return row;
  }

  private toResponse(row: ModelPreset): ModelPresetResponseDto {
    const envKey = PLATFORM_ENV_KEY[row.platform];
    const apiKeyConfigured = envKey
      ? Boolean(this.configService.get<string>(envKey)?.trim())
      : false;
    return {
      id: row.id,
      presetId: row.presetId,
      name: row.name,
      description: row.description,
      provider: row.provider,
      platform: row.platform,
      model: row.model,
      baseURL: row.baseURL,
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      topP: row.topP,
      enabled: row.enabled,
      isDefault: row.isDefault,
      apiKeyConfigured,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }
}
