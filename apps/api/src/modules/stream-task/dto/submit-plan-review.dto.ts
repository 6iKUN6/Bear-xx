import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { PlanReviewDecisionType } from '@litter-bear/types/protocol';

/** edit 决定时提交的单个步骤（仅目标文字，id 由后端重编号） */
class PlanReviewStepDto {
  @ApiProperty({ description: '步骤目标文字' })
  @IsString()
  goal!: string;
}

export class SubmitPlanReviewDto {
  @ApiProperty({
    description: '计划审批决定',
    enum: ['approve', 'edit', 'reject_replan', 'reject_terminate'],
    example: 'approve',
  })
  @IsIn(['approve', 'edit', 'reject_replan', 'reject_terminate'])
  decision!: PlanReviewDecisionType;

  @ApiPropertyOptional({
    description: 'edit 决定时的完整步骤列表（改后的文字 + 末尾追加的）',
    type: [PlanReviewStepDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanReviewStepDto)
  editedSteps?: PlanReviewStepDto[];

  @ApiPropertyOptional({ description: 'reject_replan 决定时的意见' })
  @IsOptional()
  @IsString()
  feedback?: string;

  @ApiPropertyOptional({
    description: '客户端已收到的最后一个事件 ID，用于恢复续跑时只接收新帧',
    example: '1751450000000-0',
  })
  @IsOptional()
  @IsString()
  lastEventId?: string;
}
