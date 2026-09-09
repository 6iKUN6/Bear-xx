import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/** 校验未保存 FlowDefinition 的请求体。 */
export class ValidateAgentFlowDefinitionDto {
  @ApiProperty({
    description: '仅校验、不持久化的完整 FlowDefinition JSON 工件',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  definition: Record<string, unknown>;
}
