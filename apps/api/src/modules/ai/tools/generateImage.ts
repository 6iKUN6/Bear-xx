import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTaskUserId } from '../telemetry/model-call-context';
import type { ImageGenerationService } from '../../images/image-generation.service';

/** 无任务上下文（理论上不发生）时资产的兜底归属目录 */
const SYSTEM_OWNER_ID = 'system';

/**
 * 创建 AI 生图工具
 * @param imageGenerationService 生图管道服务
 * @returns 返回 LangChain 工具实例
 * @description 与其它静态工具不同，生图依赖服务注入，由 CapabilityRegistry
 * 构造时经此工厂创建。资产归属用户从任务执行上下文（ALS）读取。
 * 返回给模型的是稳定中文文本 + 图片 URL，由模型转述给用户（前端消息里
 * 的 markdown 图片可直接渲染）。
 */
export function createGenerateImageTool(
  imageGenerationService: ImageGenerationService,
) {
  return tool(
    async (input: { prompt: string; size?: string }) => {
      try {
        const userId = getTaskUserId() ?? SYSTEM_OWNER_ID;
        const image = await imageGenerationService.generate(
          userId,
          input.prompt,
          input.size,
        );
        return [
          '图片已生成并保存。',
          `图片地址：${image.url}`,
          image.revisedPrompt ? `实际使用的提示词：${image.revisedPrompt}` : '',
          '请把图片以 markdown 形式 ![图片](URL) 回复给用户。',
        ]
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        return `生图失败：${error instanceof Error ? error.message : String(error)}。请把失败原因告知用户。`;
      }
    },
    {
      name: 'generateImage',
      description:
        '根据文字描述生成一张图片并返回图片地址，适合用户要求画图、生成插画/海报/头像等场景。',
      schema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe('图片内容描述，越具体效果越好（主体、风格、构图、光线）'),
        size: z
          .enum(['1024x1024', '1024x1536', '1536x1024'])
          .optional()
          .describe('图片尺寸：方图/竖图/横图，默认方图'),
      }),
    },
  );
}
