import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/** 导入 JSON 文件内容的请求体。 */
export class ImportAgentFlowDto {
  @ApiProperty({
    description:
      '从 JSON 文件解析出的完整 FlowDefinition；不接受数据库 ID 或审计字段',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  definition: Record<string, unknown>;
}
