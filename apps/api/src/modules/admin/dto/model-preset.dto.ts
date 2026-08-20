import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

const UPSTREAM_FORMATS = [
  'openai_chat_completions',
  'openai_responses',
  'anthropic_messages',
] as const;

export class CreateModelPresetDto {
  @ApiProperty({
    description: '业务预设 id（供 agent 引用）',
    example: 'openai:gpt-5.5',
  })
  @IsString()
  @IsNotEmpty()
  presetId: string;

  @ApiProperty({ description: '显示名', example: 'GPT-5.5' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description:
      '上游 wire 格式；决定使用哪个 SDK。provider 由它推导，不单独配置',
    enum: UPSTREAM_FORMATS,
  })
  @IsIn(UPSTREAM_FORMATS)
  upstreamFormat: string;

  @ApiProperty({
    description:
      '平台标签，仅用于分组展示，可自由填写（如 openai / kimi / 自建中转站）',
    example: 'openai',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  platform: string;

  @ApiProperty({ description: '模型名', example: 'gpt-5.5' })
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiPropertyOptional({ description: '上游 baseURL；留空用 SDK 默认地址' })
  @IsOptional()
  @IsString()
  baseURL?: string;

  @ApiPropertyOptional({
    description:
      'apiKey 明文；仅在写入时提交，加密落库后永不回显。留空表示不修改',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  apiKey?: string;

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

  @ApiPropertyOptional({ description: '是否默认预设', default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateModelPresetDto extends PartialType(CreateModelPresetDto) {}

export class ModelPresetResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() presetId: string;
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ enum: UPSTREAM_FORMATS }) upstreamFormat: string;
  @ApiProperty({ description: 'provider，由 upstreamFormat 推导' })
  provider: string;
  @ApiProperty() platform: string;
  @ApiProperty() model: string;
  @ApiProperty({ nullable: true }) baseURL: string | null;
  @ApiProperty({ nullable: true }) temperature: number | null;
  @ApiProperty({ nullable: true }) maxOutputTokens: number | null;
  @ApiProperty({ nullable: true }) topP: number | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({
    description: 'apiKey 是否已配置；密钥本身与完整指纹永不下发',
    example: true,
  })
  apiKeyConfigured: boolean;
  @ApiProperty({
    description: 'apiKey 脱敏标识（取自不可逆指纹尾部）',
    nullable: true,
    example: 'Key ...a1b2c3',
  })
  apiKeyHint: string | null;
  @ApiProperty({
    description: '探针实测的能力档位',
    enum: ['unverified', 'unreachable', 'basic', 'tools'],
  })
  capability: string;
  @ApiProperty({ nullable: true }) lastCheckedAt: number | null;
  @ApiProperty({ nullable: true }) lastCheckError: string | null;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
}

/** 保存前试探连接：允许对尚未落库的参数直接探测。 */
export class ProbeModelPresetDto {
  @ApiProperty({ description: '上游 wire 格式', enum: UPSTREAM_FORMATS })
  @IsIn(UPSTREAM_FORMATS)
  upstreamFormat: string;

  @ApiProperty({ description: '平台标签', example: 'openai' })
  @IsString()
  @IsNotEmpty()
  platform: string;

  @ApiProperty({ description: '模型名', example: 'gpt-5.5' })
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiPropertyOptional({ description: '上游 baseURL' })
  @IsOptional()
  @IsString()
  baseURL?: string;

  @ApiPropertyOptional({
    description: 'apiKey 明文；对已落库预设探测时可省略，此时使用已保存的密钥',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  apiKey?: string;
}

export class ModelPresetProbeResultDto {
  @ApiProperty({
    description: '探测出的能力档位',
    enum: ['unverified', 'unreachable', 'basic', 'tools'],
  })
  capability: string;

  @ApiProperty({ description: 'L1 连通性是否通过' })
  reachable: boolean;

  @ApiProperty({ description: 'L2 工具往返是否闭环' })
  toolRoundTrip: boolean;

  @ApiProperty({ description: '失败原因（安全文本）', nullable: true })
  error: string | null;
}
