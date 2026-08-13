import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 绑定麦当劳 MCP Token 的请求参数。 */
export class BindMcDonaldsCredentialDto {
  @ApiProperty({
    description: '用户在麦当劳 MCP 平台自行生成的 Token，仅本次请求使用',
    example: '请粘贴你在麦当劳 MCP 平台生成的 Token',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token: string;
}
