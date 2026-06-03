import { ApiProperty } from '@nestjs/swagger';

export class EmptyResultDto {
  @ApiProperty({
    description: '操作是否成功',
    example: true,
  })
  success: boolean;
}
