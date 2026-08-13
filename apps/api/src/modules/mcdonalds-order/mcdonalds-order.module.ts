import { Module } from '@nestjs/common';
import { McpModule } from '../ai/mcp/mcp.module';
import { McDonaldsCredentialModule } from '../mcdonalds-credential/mcdonalds-credential.module';
import { McDonaldsOrderController } from './mcdonalds-order.controller';
import { McDonaldsOrderService } from './mcdonalds-order.service';
import { PaymentUrlCryptoService } from './payment-url-crypto.service';

/** 麦当劳订单领域模块。 */
@Module({
  imports: [McpModule, McDonaldsCredentialModule],
  controllers: [McDonaldsOrderController],
  providers: [McDonaldsOrderService, PaymentUrlCryptoService],
  exports: [McDonaldsOrderService, PaymentUrlCryptoService],
})
export class McDonaldsOrderModule {}
