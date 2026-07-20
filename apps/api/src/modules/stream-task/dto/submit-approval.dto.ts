import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import type { ApprovalDecisionType } from '@litter-bear/types/protocol';

export class SubmitApprovalDto {
  @ApiProperty({
    description: '人工审批决定',
    enum: ['approve', 'reject', 'edit'],
    example: 'approve',
  })
  @IsIn(['approve', 'reject', 'edit'])
  decision!: ApprovalDecisionType;

  @ApiPropertyOptional({
    description: 'edit 决定时用于替换的工具入参',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  editedArgs?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'reject 决定时的说明' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description: '客户端已收到的最后一个事件 ID，用于恢复续跑时只接收新帧',
    example: '1751450000000-0',
  })
  @IsOptional()
  @IsString()
  lastEventId?: string;
}
