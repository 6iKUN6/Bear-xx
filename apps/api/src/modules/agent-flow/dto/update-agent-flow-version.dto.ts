import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/** 覆盖 Flow 草稿版本的请求体。 */
export class UpdateAgentFlowVersionDto {
  @ApiProperty({
    description: '完整替换 DRAFT 版本的 FlowDefinition JSON 工件',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  definition: Record<string, unknown>;
}
