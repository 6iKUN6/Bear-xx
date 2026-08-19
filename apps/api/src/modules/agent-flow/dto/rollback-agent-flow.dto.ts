import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** 指定要恢复的历史 FlowVersion。 */
export class RollbackAgentFlowDto {
  @ApiProperty({
    description: '同一 Flow 下要恢复的 PUBLISHED 或 ARCHIVED 版本 ID',
  })
  @IsString()
  @IsNotEmpty()
  versionId: string;
}
