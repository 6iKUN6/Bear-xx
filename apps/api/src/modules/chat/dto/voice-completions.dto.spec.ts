import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { VoiceCompletionsDto } from './voice-completions.dto';

describe('VoiceCompletionsDto', () => {
  it('解析 multipart JSON 字符串中的 reasoning', async () => {
    const dto = plainToInstance(VoiceCompletionsDto, {
      reasoning: '{"activation":"enabled","effort":"high"}',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.reasoning).toEqual({ activation: 'enabled', effort: 'high' });
  });

  it('非法 JSON 不会被吞掉，仍由 DTO 校验拒绝', async () => {
    const dto = plainToInstance(VoiceCompletionsDto, {
      reasoning: '{invalid-json',
    });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
