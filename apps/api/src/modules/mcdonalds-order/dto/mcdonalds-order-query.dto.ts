import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** 麦当劳订单历史游标分页查询。 */
export class McDonaldsOrderQueryDto {
  @ApiPropertyOptional({
    description: '上一页最后一条订单的本地 ID',
    example: 'cmf_mcd_order_123',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: '返回条数，默认 20，最大 50',
    example: 20,
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
