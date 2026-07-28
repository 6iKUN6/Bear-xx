import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** 时间范围查询（默认近 7 天） */
export class ObservabilityRangeQueryDto {
  @ApiPropertyOptional({
    description: '统计时间窗口天数（默认 7，最大 90）',
    example: 7,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

/** 近期任务分页查询 */
export class RecentTasksQueryDto extends ObservabilityRangeQueryDto {
  @ApiPropertyOptional({
    description: '返回条数（默认 20，最大 100）',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: '游标：上一页最后一条任务的 id（按创建时间倒序分页）',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
