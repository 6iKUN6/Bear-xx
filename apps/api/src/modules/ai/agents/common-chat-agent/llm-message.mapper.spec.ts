import { HumanMessage } from '@langchain/core/messages';
import { toLangChainMessages } from './llm-message.mapper';

describe('toLangChainMessages', () => {
  it('将当前用户图片映射为文本与 image_url 内容块', () => {
    const [message] = toLangChainMessages([
      {
        role: 'user',
        content: '看看这张图',
        image: { url: 'https://cdn.example.com/image.webp', detail: 'auto' },
      },
    ]);

    expect(message).toBeInstanceOf(HumanMessage);
    expect(message.content).toEqual([
      { type: 'text', text: '看看这张图' },
      {
        type: 'image_url',
        image_url: {
          url: 'https://cdn.example.com/image.webp',
          detail: 'auto',
        },
      },
    ]);
  });

  it('纯文本消息保持字符串内容，不改变旧模型请求形状', () => {
    const [message] = toLangChainMessages([
      { role: 'user', content: '只有文字' },
    ]);

    expect(message.content).toBe('只有文字');
  });
});
