import { LlmCredentialCryptoService } from './llm-credential-crypto.service';

describe('LlmCredentialCryptoService', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  /**
   * 构造带指定主密钥的加密服务
   * @param encryptionKey base64 主密钥；显式传 undefined 用于模拟密钥缺失
   * @returns 返回可直接调用的服务实例
   * @description 不给默认值：默认参数会把「显式传 undefined」也吃成默认密钥，
   * 缺失密钥的用例就永远测不到真实分支。
   */
  function createService(encryptionKey: string | undefined) {
    return new LlmCredentialCryptoService({
      get: () => encryptionKey,
    } as never);
  }

  it('加密后可解回原文，且密文带版本前缀', () => {
    const service = createService(key);
    const ciphertext = service.encrypt('sk-secret-value');

    expect(ciphertext.startsWith('v1.')).toBe(true);
    expect(ciphertext).not.toContain('sk-secret-value');
    expect(service.decrypt(ciphertext)).toBe('sk-secret-value');
  });

  it('相同明文两次加密得到不同密文', () => {
    const service = createService(key);

    // IV 每次随机，否则相同 key 会产生相同密文，可被用于比对不同预设是否共用同一个 key
    expect(service.encrypt('sk-same')).not.toBe(service.encrypt('sk-same'));
  });

  it('密文被篡改时拒绝解密，不返回残缺明文', () => {
    const service = createService(key);
    const [version, iv, authTag, ciphertext] = service
      .encrypt('sk-secret-value')
      .split('.');
    const tampered = [version, iv, authTag, `${ciphertext}ff`].join('.');

    expect(() => service.decrypt(tampered)).toThrow('解密失败');
  });

  it('主密钥变更后拒绝解密旧密文，而不是回退到空 key', () => {
    const ciphertext = createService(key).encrypt('sk-secret-value');
    const rotated = createService(Buffer.alloc(32, 9).toString('base64'));

    expect(() => rotated.decrypt(ciphertext)).toThrow('解密失败');
  });

  it('主密钥缺失或长度不对时明确报错', () => {
    expect(() => createService(undefined).encrypt('sk-x')).toThrow(
      'LLM_CREDENTIAL_ENCRYPTION_KEY',
    );
    expect(() =>
      createService(Buffer.alloc(16, 1).toString('base64')).encrypt('sk-x'),
    ).toThrow('32 字节');
  });

  it('指纹稳定且脱敏标识不含 apiKey 原文字符', () => {
    const service = createService(key);
    const fingerprint = service.fingerprint('sk-secret-value');

    expect(service.fingerprint('sk-secret-value')).toBe(fingerprint);
    expect(service.fingerprint('sk-other-value')).not.toBe(fingerprint);
    // 刻意用指纹尾部而非 key 尾部：后者截图/共享屏幕时仍可被比对
    expect(service.toDisplayHint(fingerprint)).toBe(
      `Key ...${fingerprint.slice(-6)}`,
    );
    expect(service.toDisplayHint(fingerprint)).not.toContain('value');
  });
});
