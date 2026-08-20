import { Module } from '@nestjs/common';
import { LlmCredentialCryptoService } from './llm-credential-crypto.service';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { LlmService } from './llm.service';
import { LlmChatModelFactory } from './providers/chat-model.factory';

@Module({
  providers: [
    LlmChatModelFactory,
    LlmCredentialCryptoService,
    LlmModelRegistryService,
    LlmService,
  ],
  exports: [
    LlmService,
    LlmModelRegistryService,
    LlmCredentialCryptoService,
    LlmChatModelFactory,
  ],
})
export class LlmModule {}
