import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 当前用户可安全查看的麦当劳 MCP 凭据状态。 */
export class McDonaldsCredentialResponseDto {
  @ApiProperty({
    description: '本地凭据 ID',
    example: 'cmf_mcd_credential_123',
  })
  id: string;

  @ApiProperty({ enum: ['ACTIVE', 'INVALID', 'REVOKED'], example: 'ACTIVE' })
  status: 'ACTIVE' | 'INVALID' | 'REVOKED';

  @ApiProperty({ description: '仅用于识别当前 Token 的脱敏标识' })
  hint: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-08-13T12:00:00.000Z',
  })
  verifiedAt: string | null;

  @ApiProperty({ example: '2026-08-13T12:00:00.000Z' })
  updatedAt: string;
}
