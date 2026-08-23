import { AgentFlowVersionStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FlowDefinitionValidationErrorDto {
  @ApiProperty() path: string;
  @ApiProperty() rule: string;
  @ApiProperty() message: string;
}

export class AgentFlowVersionResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() flowId: string;
  @ApiProperty() version: number;
  @ApiProperty({ enum: AgentFlowVersionStatus }) status: AgentFlowVersionStatus;
  @ApiProperty({ type: 'object', additionalProperties: true })
  definition: object;
  /** 该工件是否仍符合当前 Definition 契约；false 时不能编辑、校验或发布 */
  @ApiProperty() schemaCompatible: boolean;
  @ApiPropertyOptional({
    type: () => FlowDefinitionValidationErrorDto,
    isArray: true,
  })
  schemaErrors?: FlowDefinitionValidationErrorDto[];
  @ApiProperty({ nullable: true }) digest: string | null;
  @ApiProperty() schemaVersion: number;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
  @ApiProperty({ nullable: true }) publishedAt: number | null;
  @ApiProperty({ nullable: true }) archivedAt: number | null;
}

export class AgentFlowResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ nullable: true }) publishedVersionId: string | null;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
  @ApiPropertyOptional({ type: AgentFlowVersionResponseDto, nullable: true })
  publishedVersion?: AgentFlowVersionResponseDto | null;
  @ApiPropertyOptional({ type: AgentFlowVersionResponseDto })
  draftVersion?: AgentFlowVersionResponseDto;
}

export class AgentFlowDetailResponseDto extends AgentFlowResponseDto {
  @ApiProperty({ type: AgentFlowVersionResponseDto, isArray: true })
  versions: AgentFlowVersionResponseDto[];
}

/** 内置 Flow 模板：新建 Flow 的起点，避免管理员手写整份 Definition。 */
export class AgentFlowTemplateResponseDto {
  @ApiProperty({
    description: '预设标识',
    enum: ['direct', 'react', 'plan_execute', 'hybrid'],
  })
  preset: string;

  @ApiProperty({ description: '模板 Definition 声明的名称' })
  name: string;

  @ApiProperty({ description: '模板 Definition 声明的描述' })
  description: string;

  @ApiProperty({
    description: '可直接提交给创建接口的完整 FlowDefinition',
    type: 'object',
    additionalProperties: true,
  })
  definition: object;
}

export class AgentFlowValidationResponseDto {
  @ApiProperty() valid: boolean;
  @ApiProperty({ type: FlowDefinitionValidationErrorDto, isArray: true })
  errors: FlowDefinitionValidationErrorDto[];
  @ApiPropertyOptional({
    description: '合法 Definition 的布局无关 SHA-256 摘要',
  })
  digest?: string;
}
