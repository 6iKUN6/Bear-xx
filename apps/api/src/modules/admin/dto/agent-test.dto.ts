import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** admin 流式测试请求：不复用 mobile 的 ChatCompletionsDto，语义独立 */
export class AgentTestDto {
  @ApiProperty({ description: '测试输入内容', example: '深圳今天天气怎么样' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description: '指定测试的智能体 id；不传用默认智能体',
    example: 'agent_abc123',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description: '指定模型预设 id（覆盖 agent 的模型）',
    example: 'openai:gpt-5.5',
  })
  @IsOptional()
  @IsString()
  modelPreset?: string;
}
