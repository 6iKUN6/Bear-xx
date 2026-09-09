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
}

export class TestSessionDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty({ description: '最后一条消息预览' }) lastMessage: string;
  @ApiProperty() messageCount: number;
  @ApiProperty({ example: 1735689600000 }) updatedAt: number;
}

export class TestExecutionModelSnapshotDto {
  @ApiProperty({ description: '任务冻结的模型预设业务标识' })
  presetId: string;

  @ApiProperty({ description: '当前模型预设显示名称', nullable: true })
  name: string | null;

  @ApiProperty({ description: '当前底层模型名', nullable: true })
  model: string | null;

  @ApiProperty({ description: '当前供应商模板标识', nullable: true })
  providerKey: string | null;
}

export class TestExecutionFlowSnapshotDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() versionId: string;
  @ApiProperty() version: number;
  @ApiProperty({ description: '任务创建时冻结的 Flow Definition 摘要' })
  digest: string;
}

export class TestExecutionNodeModelDto {
  @ApiProperty() nodeId: string;
  @ApiProperty({ nullable: true }) nodeName: string | null;
  @ApiProperty() nodeType: string;
  @ApiProperty({ enum: ['agent-default', 'explicit'] })
  source: 'agent-default' | 'explicit';
  @ApiProperty({ type: TestExecutionModelSnapshotDto })
  model: TestExecutionModelSnapshotDto;
}

export class TestMessageExecutionDto {
  @ApiProperty() taskId: string;
  @ApiProperty() taskStatus: string;
  @ApiProperty({ type: TestExecutionFlowSnapshotDto })
  flow: TestExecutionFlowSnapshotDto;
  @ApiProperty({ type: TestExecutionModelSnapshotDto, nullable: true })
  agentDefaultModel: TestExecutionModelSnapshotDto | null;
  @ApiProperty({ type: TestExecutionNodeModelDto, isArray: true })
  nodeModels: TestExecutionNodeModelDto[];
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
  @ApiProperty({ type: TestMessageExecutionDto, nullable: true })
  execution: TestMessageExecutionDto | null;
}

export class TestSessionDetailDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty({ example: 1735689600000 }) updatedAt: number;
  @ApiProperty({ type: TestSessionMessageDto, isArray: true })
  messages: TestSessionMessageDto[];
}
