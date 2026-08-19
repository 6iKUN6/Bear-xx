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

export class AgentFlowValidationResponseDto {
  @ApiProperty() valid: boolean;
  @ApiProperty({ type: FlowDefinitionValidationErrorDto, isArray: true })
  errors: FlowDefinitionValidationErrorDto[];
  @ApiPropertyOptional({
    description: '合法 Definition 的布局无关 SHA-256 摘要',
  })
  digest?: string;
}
