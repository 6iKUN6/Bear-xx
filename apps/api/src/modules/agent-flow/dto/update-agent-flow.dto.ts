import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** 更新 AgentFlow 基本信息的请求体。 */
export class UpdateAgentFlowDto {
  @ApiProperty({
    description: 'Flow 名称，去除首尾空白后长度为 1–100 个字符',
    example: '退款审批流程',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Flow 描述；缺省或空字符串表示无描述',
    example: '处理退款条件判断、人工确认与通知',
    maxLength: 2_000,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;
}
