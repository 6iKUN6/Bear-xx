import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskTraceItemDto } from './observability-response.dto';

/** admin 流式测试请求：不复用 mobile 的 ChatCompletionsDto，语义独立 */
export class AgentTestDto {
  @ApiProperty({ description: '测试输入内容', example: '深圳今天天气怎么样' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description:
      '测试会话 id；传入则续接该会话（多轮记忆），不传则新建测试会话',
    example: 'conv_test_123',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

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

export class TestSessionDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty({ description: '最后一条消息预览' }) lastMessage: string;
  @ApiProperty() messageCount: number;
  @ApiProperty({ example: 1735689600000 }) updatedAt: number;
}

export class TestSessionMessageDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['user', 'assistant'] }) role: string;
  @ApiProperty() content: string;
  @ApiProperty({
    description: '发言智能体 id；null=用户/默认助手',
    nullable: true,
  })
  agentId: string | null;
  @ApiProperty({ enum: ['streaming', 'done', 'error'] }) status: string;
  @ApiProperty({ example: 1735689600000 }) createdAt: number;
  @ApiProperty({ type: TaskTraceItemDto, isArray: true })
  trace: TaskTraceItemDto[];
}

export class TestSessionDetailDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty({ example: 1735689600000 }) updatedAt: number;
  @ApiProperty({ type: TestSessionMessageDto, isArray: true })
  messages: TestSessionMessageDto[];
}
