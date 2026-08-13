import { Module } from '@nestjs/common';
import { McpModule } from '../ai/mcp/mcp.module';
import { McDonaldsCredentialController } from './mcdonalds-credential.controller';
import { McDonaldsCredentialService } from './mcdonalds-credential.service';
import { McDonaldsTokenCryptoService } from './mcdonalds-token-crypto.service';

/** 用户级麦当劳 MCP 凭据模块。 */
@Module({
  imports: [McpModule],
  controllers: [McDonaldsCredentialController],
  providers: [McDonaldsCredentialService, McDonaldsTokenCryptoService],
  exports: [McDonaldsCredentialService, McDonaldsTokenCryptoService],
})
export class McDonaldsCredentialModule {}
