import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentUrlCryptoService } from './payment-url-crypto.service';

describe('PaymentUrlCryptoService', () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');

  function createService(key = encryptionKey): PaymentUrlCryptoService {
    return new PaymentUrlCryptoService(
      new ConfigService({ MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: key }),
    );
  }

  it('加密后可还原官方支付链接', () => {
    const service = createService();
    const url = 'https://pay.example/session?token=secret';

    const encrypted = service.encrypt(url);

    expect(encrypted).not.toContain('pay.example');
    expect(service.decrypt(encrypted)).toBe(url);
  });

  it('拒绝过期支付链接和认证失败的密文', () => {
    const service = createService();

    expect(() => service.assertNotExpired(new Date(0))).toThrow(
      '支付链接已过期',
    );
    expect(() => service.decrypt('v1.invalid.invalid.invalid')).toThrow(
      BadRequestException,
    );
  });

  it('拒绝非 32 字节的环境密钥', () => {
    expect(() =>
      createService(Buffer.alloc(16).toString('base64')).assertConfigured(),
    ).toThrow('MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY');
  });

  it('未启用麦当劳 MCP 时不会因缺少密钥而在构造阶段失败', () => {
    const service = new PaymentUrlCryptoService(new ConfigService());

    expect(() => service.encrypt('https://pay.example/session')).toThrow(
      'MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY',
    );
  });
});
