import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ModelReasoningCapabilityDto } from '../../llm/dto/reasoning-selection.dto';

export const UPSTREAM_FORMATS = [
  'openai_chat_completions',
  'openai_responses',
  'anthropic_messages',
  'gemini_generate_content',
] as const;

/** 创建供应商连接时一并创建的模型配置。 */
export class CreateConnectionModelDto {
  @ApiProperty({ description: '模型显示名称', example: 'DeepSeek Chat' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: '模型用途说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '供应商模型 ID', example: 'deepseek-chat' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model: string;

  @ApiProperty({ description: '上游 wire 格式', enum: UPSTREAM_FORMATS })
  @IsIn(UPSTREAM_FORMATS)
  upstreamFormat: string;

  @ApiPropertyOptional({ description: 'temperature' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 token' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxOutputTokens?: number;

  @ApiPropertyOptional({ description: 'topP' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '是否设为系统默认模型' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** 新建供应商连接及首批模型。 */
export class CreateModelProviderConnectionDto {
  @ApiProperty({ description: '内置供应商模板标识', example: 'deepseek' })
  @IsString()
  @IsNotEmpty()
  providerKey: string;

  @ApiProperty({ description: '连接显示名称', example: 'DeepSeek 官方' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: '供应商 API 根地址' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  baseURL: string;

  @ApiProperty({ description: 'API Key 明文，仅写入并加密落库' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  apiKey: string;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ type: CreateConnectionModelDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateConnectionModelDto)
  models: CreateConnectionModelDto[];
}

/** 修改供应商连接；模板标识与稳定连接键不可修改。 */
export class UpdateModelProviderConnectionDto {
  @ApiPropertyOptional({ description: '连接显示名称' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: '供应商 API 根地址' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  baseURL?: string;

  @ApiPropertyOptional({
    description: '新 API Key；省略表示保持已保存密钥不变',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  apiKey?: string;

  @ApiPropertyOptional({ description: '是否启用' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** 供应商模板中的推荐模型安全投影。 */
export class ModelProviderRecommendedModelDto {
  @ApiProperty() model: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: UPSTREAM_FORMATS }) upstreamFormat: string;
  @ApiProperty({ type: ModelReasoningCapabilityDto, nullable: true })
  reasoningCapability: ModelReasoningCapabilityDto | null;
}

/** 代码内置供应商模板的管理端投影。 */
export class ModelProviderTemplateResponseDto {
  @ApiProperty() providerKey: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) defaultBaseURL: string | null;
  @ApiProperty({ enum: UPSTREAM_FORMATS }) defaultUpstreamFormat: string;
  @ApiProperty({ enum: UPSTREAM_FORMATS, isArray: true })
  allowedUpstreamFormats: string[];
  @ApiProperty({ type: ModelProviderRecommendedModelDto, isArray: true })
  recommendedModels: ModelProviderRecommendedModelDto[];
}

/** 连接探测请求，必须指定该连接下用于最小对话的模型。 */
export class ProbeModelProviderConnectionDto {
  @ApiProperty({ description: '属于当前连接的模型预设数据库 ID' })
  @IsString()
  @IsNotEmpty()
  modelPresetId: string;
}

/** 连接探测结论。 */
export class ModelProviderConnectionProbeResultDto {
  @ApiProperty({ enum: ['reachable', 'unreachable'] })
  status: string;
  @ApiProperty() reachable: boolean;
  @ApiProperty({ nullable: true }) error: string | null;
}

/** 新增单个模型预设。 */
export class CreateModelPresetDto extends CreateConnectionModelDto {}

/** 更新模型预设；presetId 与归属连接不可修改。 */
export class UpdateModelPresetDto extends PartialType(
  CreateConnectionModelDto,
) {}

/** 模型预设所属连接的安全摘要。 */
export class ModelPresetConnectionSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() connectionKey: string;
  @ApiProperty() providerKey: string;
  @ApiProperty() name: string;
  @ApiProperty() baseURL: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ enum: ['unverified', 'reachable', 'unreachable'] })
  status: string;
}

/** 模型预设管理端投影。 */
export class ModelPresetResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() presetId: string;
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ enum: UPSTREAM_FORMATS }) upstreamFormat: string;
  @ApiProperty({ description: 'provider，由 upstreamFormat 推导' })
  provider: string;
  @ApiProperty() model: string;
  @ApiProperty({ nullable: true }) temperature: number | null;
  @ApiProperty({ nullable: true }) maxOutputTokens: number | null;
  @ApiProperty({ nullable: true }) topP: number | null;
  @ApiProperty({ type: ModelReasoningCapabilityDto, nullable: true })
  reasoningCapability: ModelReasoningCapabilityDto | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({
    description: 'API Key 是否已在所属连接配置；密钥本身永不下发',
  })
  apiKeyConfigured: boolean;
  @ApiProperty({ nullable: true }) apiKeyHint: string | null;
  @ApiProperty({ enum: ['unverified', 'unreachable', 'basic', 'tools'] })
  capability: string;
  @ApiProperty({ nullable: true }) lastCheckedAt: number | null;
  @ApiProperty({ nullable: true }) lastCheckError: string | null;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
  @ApiProperty({ type: ModelPresetConnectionSummaryDto })
  connection: ModelPresetConnectionSummaryDto;
}

/** 模型预设引用位置。 */
export class ModelPresetReferenceDto {
  @ApiProperty({ enum: ['agent', 'flow', 'task'] }) type: string;
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) versionId: string | null;
  @ApiProperty({ nullable: true }) version: number | null;
  @ApiProperty({ nullable: true }) status: string | null;
}

/** 单个模型预设的引用汇总。 */
export class ModelPresetReferencesResponseDto {
  @ApiProperty() agentCount: number;
  @ApiProperty() flowCount: number;
  @ApiProperty() taskCount: number;
  @ApiProperty({ type: ModelPresetReferenceDto, isArray: true })
  items: ModelPresetReferenceDto[];
}

/** 供应商连接列表与详情投影。 */
export class ModelProviderConnectionResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() connectionKey: string;
  @ApiProperty() providerKey: string;
  @ApiProperty() name: string;
  @ApiProperty() baseURL: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty() apiKeyConfigured: boolean;
  @ApiProperty({ nullable: true }) apiKeyHint: string | null;
  @ApiProperty({ enum: ['unverified', 'reachable', 'unreachable'] })
  status: string;
  @ApiProperty({ nullable: true }) lastCheckedAt: number | null;
  @ApiProperty({ nullable: true }) lastCheckError: string | null;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
  @ApiProperty({ type: ModelPresetResponseDto, isArray: true })
  models: ModelPresetResponseDto[];
  @ApiProperty() agentReferenceCount: number;
  @ApiProperty() flowReferenceCount: number;
  @ApiProperty() taskReferenceCount: number;
}

/** 模型完整能力探测结论。 */
export class ModelPresetProbeResultDto {
  @ApiProperty({ enum: ['unverified', 'unreachable', 'basic', 'tools'] })
  capability: string;
  @ApiProperty() reachable: boolean;
  @ApiProperty() toolRoundTrip: boolean;
  @ApiProperty({ nullable: true }) error: string | null;
}
