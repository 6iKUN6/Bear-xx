import {
  IsString,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform, Type } from 'class-transformer';
import { ReasoningSelectionDto } from '../../llm/dto/reasoning-selection.dto';

export class VoiceCompletionsDto {
  @ApiPropertyOptional({
    description: '会话 ID；首轮语音消息可不传，后端会自动创建新会话',
    example: 'conv_abc123',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({
    description: '指定使用的智能体 id；不传则用默认智能体',
    example: 'agent_abc123',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description:
      '本条消息选择的模型预设业务 ID；必须属于回答智能体允许集合，仅替换 Flow 中的 agent-default',
    example: 'deepseek-official:deepseek-chat',
  })
  @IsOptional()
  @IsString()
  selectedModelPresetId?: string;

  @ApiPropertyOptional({
    type: ReasoningSelectionDto,
    description: '仅 direct Agent 可用的本轮思考设置',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReasoningSelectionDto)
  @Transform(({ value }: { value: unknown }) => parseReasoningFormField(value))
  reasoning?: ReasoningSelectionDto;
}

/**
 * 解析 multipart/form-data 中以 JSON 字符串提交的思考配置
 * @param value 表单字段原始值
 * @returns JSON 合法时返回解析结果，否则保留原值交给 ValidationPipe 返回 400
 * @description Taro.uploadFile 的普通表单字段只能稳定提交字符串；这里仅负责安全解析，
 * 不吞掉语法错误，也不替代 ReasoningSelectionDto 的字段级校验。
 */
function parseReasoningFormField(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return plainToInstance(
      ReasoningSelectionDto,
      JSON.parse(value) as Record<string, unknown>,
    );
  } catch {
    return value;
  }
}
