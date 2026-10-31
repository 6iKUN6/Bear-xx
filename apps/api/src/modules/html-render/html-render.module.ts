import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { HtmlRenderService } from './html-render.service';
import { RenderPipelineService } from './render-pipeline.service';

/**
 * HTML → mp4 渲染模块
 * @description 导出渲染内核（HtmlRenderService）与渲染执行编排（RenderPipelineService）；
 * 编排依赖对象存储做幂等上传，因此引入 StorageModule。这里不重复封装 COS。
 */
@Module({
  imports: [StorageModule],
  providers: [HtmlRenderService, RenderPipelineService],
  exports: [HtmlRenderService, RenderPipelineService],
})
export class HtmlRenderModule {}
