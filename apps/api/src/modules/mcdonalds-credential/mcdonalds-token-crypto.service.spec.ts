import { ConfigService } from '@nestjs/config';
import { McDonaldsTokenCryptoService } from './mcdonalds-token-crypto.service';

describe('McDonaldsTokenCryptoService', () => {
  const encryptionKey = Buffer.alloc(32, 11).toString('base64');

  it('加密后可还原绑定 Token，且密文不含明文', () => {
    const service = new McDonaldsTokenCryptoService(
      new ConfigService({ MCDONALDS_CREDENTIAL_ENCRYPTION_KEY: encryptionKey }),
    );
    const token = 'mcd-token-secret';

    const ciphertext = service.encrypt(token);

    expect(ciphertext).not.toContain(token);
    expect(service.decrypt(ciphertext)).toBe(token);
  });

  it('相同 Token 生成稳定指纹，不暴露原文', () => {
    const service = new McDonaldsTokenCryptoService(
      new ConfigService({ MCDONALDS_CREDENTIAL_ENCRYPTION_KEY: encryptionKey }),
    );

    const fingerprint = service.fingerprint('mcd-token-secret');

    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).not.toContain('mcd-token-secret');
    expect(service.fingerprint('mcd-token-secret')).toBe(fingerprint);
  });
});
