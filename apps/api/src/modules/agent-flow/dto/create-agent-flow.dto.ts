import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/** 创建 AgentFlow 的请求体。 */
export class CreateAgentFlowDto {
  @ApiProperty({
    description: '完整的 FlowDefinition JSON 工件',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  definition: Record<string, unknown>;
}
