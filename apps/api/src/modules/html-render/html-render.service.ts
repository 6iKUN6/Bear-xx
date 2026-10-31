import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { FLOW_RENDER_LIMITS } from '@litter-bear/types/agent-flow';

/** 渲染失败的原因闭集；Activity 层据此决定是否可重试。 */
export type HtmlRenderErrorCode =
  | 'INVALID_PARAMETERS'
  | 'HTML_TOO_LARGE'
  | 'CHROME_NOT_FOUND'
  | 'FRAME_API_MISSING'
  | 'CONFIG_INVALID'
  | 'PAGE_ERROR'
  | 'FRAME_CAPTURE_FAILED'
  | 'FFMPEG_FAILED'
  | 'ABORTED';

/**
 * 渲染失败
 * @description 带固定原因码，让上层把「HTML 没提供时间接口」这类配置错误判成不可重试，
 * 而不是让 Temporal 重试三次同一个必然失败的输入。
 */
export class HtmlRenderError extends Error {
  constructor(
    readonly code: HtmlRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HtmlRenderError';
  }
}

/** 一次渲染请求。 */
export interface HtmlRenderRequest {
  /** 上游产出的完整 HTML 文档。 */
  html: string;
  /** 视口与成片宽度（像素，偶数）。 */
  width: number;
  /** 视口与成片高度（像素，偶数）。 */
  height: number;
  /** 成片时长（秒）。 */
  durationSeconds: number;
  /** 成片帧率。 */
  fps: number;
  /** 取消信号；触发后必须停掉浏览器与 ffmpeg 并清理临时目录。 */
  signal?: AbortSignal;
  /** 每帧截取后的进度回调；Activity 用它发心跳。 */
  onFrame?: (progress: {
    frame: number;
    totalFrames: number;
  }) => void | Promise<void>;
}

/** 一次渲染的产物；调用方负责上传并调用 `dispose`。 */
export interface HtmlRenderResult {
  /** 成片在本机临时目录中的绝对路径，**不得**写入节点输出。 */
  filePath: string;
  /** 实际截取的帧数。 */
  frameCount: number;
  /** 成片字节数。 */
  byteLength: number;
  /** 删除本次渲染产生的临时目录；可重复调用。 */
  dispose: () => Promise<void>;
}

/** 等待 HTML 暴露时间推进接口的上限；缺失即配置错误，不需要等满渲染时长。 */
const FRAME_API_WAIT_MS = 30_000;
/** 加载 HTML 文档的上限。 */
const PAGE_LOAD_TIMEOUT_MS = 60_000;
/** ffmpeg 合成上限；单次渲染总预算由 Temporal 的 Activity 超时兜底。 */
const FFMPEG_TIMEOUT_MS = 15 * 60_000;
/** 只由拦截器在内存中响应，绝不向 DNS 或网络请求这个地址。 */
const RENDER_DOCUMENT_URL = 'https://html-render.invalid/';
/**
 * 响应头级隔离策略，不使用 HTML 可改写的 meta；sandbox 禁止弹窗、下载与同源权限。
 * request 拦截覆盖不到 WebSocket 和新 target 的首个请求，因此必须在脚本执行前施加 CSP。
 */
const RENDER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ');
/** 单次渲染允许使用的 Chrome 可执行文件候选（按优先级）。 */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
] as const;

/** 一个正在排队等槽位的渲染；`grant` 由释放方调用，槽位随调用一起移交。 */
interface RenderWaiter {
  grant: () => void;
}

/**
 * HTML → mp4 渲染服务
 * @description 唯一职责是把一段 HTML 渲染成视频文件：Puppeteer 逐帧调用 HTML 自己提供的
 * `window.renderFrame(timeSeconds)` 推进动画并截图，再由 ffmpeg 用参数数组合成 mp4。
 * 上传、对象命名与幂等属于调用方（Activity + CosStorageService），这里不碰存储。
 *
 * 刻意只支持一个引擎、一种时间接口：两套渲染语义会让「同一份 HTML 在两条链路上出片不同」，
 * 而排查这种差异的成本远高于多接一个引擎带来的收益。
 */
@Injectable()
export class HtmlRenderService {
  private readonly logger = new Logger(HtmlRenderService.name);
  private readonly waiters: RenderWaiter[] = [];
  private activeRenders = 0;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 把 HTML 渲染成 mp4
   * @param request 待渲染的 HTML 与四项成片参数
   * @returns 返回成片临时文件、帧数与清理函数
   * @description 任何失败路径都会先清掉本次渲染的临时目录再抛错；调用方只需在上传完成后
   * 调用 `dispose`。取消信号会终止浏览器与 ffmpeg，不会留下孤儿进程。
   *
   * 取得槽位之后的所有初始化（建临时目录、建帧目录）都在 try 内：目录建不出来同样是一次
   * 失败的渲染，必须和取帧、合成失败一样释放槽位，否则后续请求会永远排在这一支后面。
   */
  async render(request: HtmlRenderRequest): Promise<HtmlRenderResult> {
    this.assertRequest(request);
    const concurrency = this.concurrencyLimit();
    const chromePath = await this.resolveChromePath();
    const ffmpegPath =
      this.configService.get<string>('HTML_RENDER_FFMPEG_PATH')?.trim() ||
      'ffmpeg';
    const totalFrames = request.durationSeconds * request.fps;

    await this.acquire(concurrency, request.signal);

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (request.signal?.aborted) controller.abort();

    let dispose: (() => Promise<void>) | undefined;
    try {
      const workRoot = await this.createWorkRoot();
      dispose = this.createDisposer(workRoot);
      const framesDir = join(workRoot, 'frames');
      const outputPath = join(workRoot, 'output.mp4');

      await this.captureFrames({
        request,
        chromePath,
        framesDir,
        totalFrames,
        signal: controller.signal,
      });
      await this.encodeVideo({
        ffmpegPath,
        framesDir,
        outputPath,
        fps: request.fps,
        signal: controller.signal,
      });
      const file = await stat(outputPath);
      return {
        filePath: outputPath,
        frameCount: totalFrames,
        byteLength: file.size,
        dispose,
      };
    } catch (error) {
      await dispose?.();
      throw this.normalizeError(error, controller.signal);
    } finally {
      request.signal?.removeEventListener('abort', onExternalAbort);
      this.release();
    }
  }

  /**
   * 校验渲染参数
   * @param request 渲染请求
   * @returns 无返回值；参数越界时抛出不可重试的渲染错误
   * @description Definition 校验已经挡过一次，这里是第二道：服务可以被 Activity 之外的
   * 代码调用，参数越界会直接把 Chromium 或 ffmpeg 打成不可预期的失败模式。
   */
  private assertRequest(request: HtmlRenderRequest): void {
    const { width, height, durationSeconds, fps } = request;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      !Number.isInteger(durationSeconds) ||
      !Number.isInteger(fps) ||
      width < FLOW_RENDER_LIMITS.minWidth ||
      width > FLOW_RENDER_LIMITS.maxWidth ||
      height < FLOW_RENDER_LIMITS.minHeight ||
      height > FLOW_RENDER_LIMITS.maxHeight ||
      durationSeconds < FLOW_RENDER_LIMITS.minDurationSeconds ||
      durationSeconds > FLOW_RENDER_LIMITS.maxDurationSeconds ||
      fps < FLOW_RENDER_LIMITS.minFps ||
      fps > FLOW_RENDER_LIMITS.maxFps ||
      width % 2 !== 0 ||
      height % 2 !== 0 ||
      width * height > FLOW_RENDER_LIMITS.maxPixels ||
      durationSeconds * fps > FLOW_RENDER_LIMITS.maxTotalFrames
    ) {
      throw new HtmlRenderError(
        'INVALID_PARAMETERS',
        '渲染参数超出契约允许的范围',
      );
    }
    if (!request.html.trim()) {
      throw new HtmlRenderError('INVALID_PARAMETERS', '待渲染的 HTML 为空');
    }
    if (
      Buffer.byteLength(request.html, 'utf8') > FLOW_RENDER_LIMITS.maxHtmlBytes
    ) {
      throw new HtmlRenderError(
        'HTML_TOO_LARGE',
        `待渲染的 HTML 超过 ${FLOW_RENDER_LIMITS.maxHtmlBytes} 字节上限`,
      );
    }
  }

  /**
   * 创建本次渲染独占的工作目录
   * @returns 返回新建的工作目录绝对路径，其下的 frames 子目录已就绪
   * @description 每次渲染一个 mkdtemp 目录，互不覆盖，失败与取消都由调用方整目录删除。
   *
   * 根目录**不会**被自动创建：显式配置的 HTML_RENDER_TMP_ROOT 不存在或不可写时直接失败。
   * 悄悄建目录会把「卷没挂上」伪装成成功——帧图会落到容器可写层，既撑爆镜像层，也让
   * 帧图留在磁盘上的事实被掩盖；配置错误必须是看得见的失败。
   */
  private async createWorkRoot(): Promise<string> {
    const root = this.tempRoot();
    let workRoot: string;
    try {
      workRoot = await mkdtemp(join(root, 'html-render-'));
    } catch (error) {
      throw new HtmlRenderError(
        'CONFIG_INVALID',
        `渲染临时根目录不可用（${root}）：${describeError(error)}`,
      );
    }
    try {
      await mkdir(join(workRoot, 'frames'), { recursive: true });
      return workRoot;
    } catch (error) {
      await this.createDisposer(workRoot)();
      throw new HtmlRenderError(
        'CONFIG_INVALID',
        `渲染帧目录创建失败（${workRoot}）：${describeError(error)}`,
      );
    }
  }

  /**
   * 逐帧推进动画并截图
   * @param input 浏览器路径、帧目录、总帧数与取消信号
   * @returns 无返回值；帧图全部落在独立临时目录
   * @description 时间轴由帧号决定（第 i 帧为 `i / fps` 秒），不依赖 wall-clock 或等待动画
   * 自然播完：那既不确定，也会让成片时长随机器负载漂移。
   *
   * 取消监听在启动浏览器之前就注册：启动本身无法中断，但取消必须让浏览器一返回就被关闭，
   * 而不是继续加载 HTML、取满所有帧才发现已取消。
   */
  private async captureFrames(input: {
    request: HtmlRenderRequest;
    chromePath: string;
    framesDir: string;
    totalFrames: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { request, chromePath, framesDir, totalFrames, signal } = input;
    if (signal.aborted) {
      throw new HtmlRenderError('ABORTED', '渲染已被取消');
    }
    let browser: Browser | undefined;
    const onAbort = () => {
      if (browser) void closeBrowser(browser);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      browser = await this.launchBrowser(
        chromePath,
        join(dirname(framesDir), 'browser'),
      );
      if (signal.aborted) {
        throw new HtmlRenderError('ABORTED', '渲染已被取消');
      }
      const page = await browser.newPage();
      await page.setViewport({
        width: request.width,
        height: request.height,
        deviceScaleFactor: 1,
      });
      await this.loadIsolatedHtml(page, request.html);
      await this.waitForFrameApi(page);
      await this.waitForFonts(page);

      for (let frame = 0; frame < totalFrames; frame += 1) {
        if (signal.aborted) {
          throw new HtmlRenderError('ABORTED', '渲染已被取消');
        }
        const timeSeconds = frame / request.fps;
        await this.advanceFrame(page, timeSeconds);
        await page.screenshot({
          path: join(framesDir, `frame-${String(frame).padStart(6, '0')}.png`),
          type: 'png',
        });
        await request.onFrame?.({ frame: frame + 1, totalFrames });
      }
    } catch (error) {
      if (signal.aborted) {
        throw new HtmlRenderError('ABORTED', '渲染已被取消');
      }
      throw error instanceof HtmlRenderError
        ? error
        : new HtmlRenderError(
            'FRAME_CAPTURE_FAILED',
            `逐帧渲染失败：${describeError(error)}`,
          );
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (browser) await closeBrowser(browser);
    }
  }

  /**
   * 启动受控浏览器
   * @param chromePath 系统 Chrome/Chromium 可执行文件
   * @param profilePath 本次独占临时目录下的浏览器配置目录
   * @returns 返回已连接的浏览器实例
   * @description 始终保留 Chromium 沙箱，root 环境明确失败，不以容器替代浏览器沙箱。
   * 浏览器只获得字体/语言所需的白名单环境与临时 HOME，不继承 Worker 的 COS、数据库或模型凭据；
   * CDP 使用管道而非监听端口。不可达代理与禁用直连 WebRTC 是 CSP 之外的纵深网络限制。
   * puppeteer-core 为 ESM，按需加载避免不执行渲染的进程解析浏览器依赖。
   */
  private async launchBrowser(
    chromePath: string,
    profilePath: string,
  ): Promise<Browser> {
    if (process.getuid?.() === 0) {
      throw new HtmlRenderError(
        'CONFIG_INVALID',
        '渲染 Worker 必须以非 root 用户运行并启用 Chromium 沙箱',
      );
    }
    const args = [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
      '--mute-audio',
      '--hide-scrollbars',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
    ];
    const environment: Record<string, string> = {
      HOME: dirname(profilePath),
      TMPDIR: dirname(profilePath),
    };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot']) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    const { default: puppeteer } = await import('puppeteer-core');
    return puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      pipe: true,
      userDataDir: profilePath,
      env: environment,
      args,
      protocolTimeout: 5 * 60_000,
    });
  }

  /**
   * 在脚本执行之前用可信响应头加载隔离 HTML
   * @param page 本次浏览器的新页面
   * @param html 模型产出的不可信 HTML
   * @returns 无返回值；导航和资源加载失败时交由渲染错误路径收敛
   * @description 只响应第一次主文档导航，其他导航及外部资源全部中止。响应头 CSP 对
   * WebSocket、Worker、iframe、弹窗、表单和下载生效，HTML 内追加 meta 不能放宽它。
   */
  private async loadIsolatedHtml(page: Page, html: string): Promise<void> {
    await page.setRequestInterception(true);
    let documentServed = false;
    page.on('request', (request) => {
      if (
        !documentServed &&
        request.url() === RENDER_DOCUMENT_URL &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        documentServed = true;
        void request.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Content-Security-Policy': RENDER_CONTENT_SECURITY_POLICY,
            'X-DNS-Prefetch-Control': 'off',
          },
          body: html,
        });
        return;
      }
      const url = request.url();
      if (
        !request.isNavigationRequest() &&
        (url.startsWith('data:') || url.startsWith('blob:'))
      ) {
        void request.continue();
        return;
      }
      void request.abort('blockedbyclient');
    });
    await page.goto(RENDER_DOCUMENT_URL, {
      waitUntil: 'load',
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
  }

  /**
   * 等待 HTML 暴露统一时间接口
   * @param page 已加载 HTML 的页面
   * @returns 无返回值；接口缺失时抛出不可重试错误
   * @description 契约是 `window.renderFrame(timeSeconds)`，允许返回 Promise。缺接口时不能
   * 退回 sleep 或直接截图：那会产出一支时长对但画面不动的视频，看起来像成功。
   */
  private async waitForFrameApi(page: Page): Promise<void> {
    try {
      await page.waitForFunction(
        () => {
          const scope: typeof globalThis & { renderFrame?: unknown } =
            globalThis;
          return typeof scope.renderFrame === 'function';
        },
        { timeout: FRAME_API_WAIT_MS },
      );
    } catch {
      throw new HtmlRenderError(
        'FRAME_API_MISSING',
        'HTML 未提供 window.renderFrame(timeSeconds)，无法确定性取帧',
      );
    }
  }

  /**
   * 等待字体加载完成
   * @param page 已加载 HTML 的页面
   * @returns 无返回值
   * @description 中文字体在首帧前未就绪会截到缺字或回退字形；逐帧重试也无法补回，
   * 只能在开始前等一次 `document.fonts.ready`。
   */
  private async waitForFonts(page: Page): Promise<void> {
    await page.evaluate(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
    );
  }

  /**
   * 把动画推进到指定时间点
   * @param page 已加载 HTML 的页面
   * @param timeSeconds 该帧对应的时间（秒）
   * @returns 无返回值；接口抛错或缺失时失败
   * @description `page.evaluate` 会自动等待返回的 Promise，因此异步时间接口同样被正确同步。
   */
  private async advanceFrame(page: Page, timeSeconds: number): Promise<void> {
    try {
      await page.evaluate((time: number) => {
        const scope: typeof globalThis & {
          renderFrame?: (value: number) => unknown;
        } = globalThis;
        if (typeof scope.renderFrame !== 'function') {
          throw new Error('window.renderFrame 缺失');
        }
        return scope.renderFrame(time);
      }, timeSeconds);
    } catch (error) {
      throw new HtmlRenderError(
        'FRAME_CAPTURE_FAILED',
        `第 ${Math.round(timeSeconds * 1000)} 毫秒处的 renderFrame 执行失败：${describeError(error)}`,
      );
    }
  }

  /**
   * 用 ffmpeg 把帧图合成为 mp4
   * @param input 帧目录、输出路径、帧率与取消信号
   * @returns 无返回值
   * @description 参数以数组传给子进程，不经过 shell，路径与用户输入无法被解释成命令。
   * 输出固定 yuv420p + faststart，保证小程序与浏览器都能直接播放。
   *
   * 取消或超时只发出 kill，不立即结算：必须等到本次子进程的 `close` 才算这一支真的结束。
   * 提前 reject 会让调用方马上删临时目录、释放槽位，而旧进程可能仍在写文件，下一次渲染
   * 就会和上一次的残留写同一片目录。
   */
  private encodeVideo(input: {
    ffmpegPath: string;
    framesDir: string;
    outputPath: string;
    fps: number;
    signal: AbortSignal;
  }): Promise<void> {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      String(input.fps),
      '-i',
      join(input.framesDir, 'frame-%06d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
      input.outputPath,
    ];
    return new Promise<void>((resolve, reject) => {
      // 取消可能恰好发生在最后一帧之后：此时不会再进循环检查，若不在这里补一次判断，
      // 已经取消的 attempt 仍会启动 ffmpeg 并写出成片。
      if (input.signal.aborted) {
        reject(new HtmlRenderError('ABORTED', '渲染已被取消'));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(input.ffmpegPath, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        reject(
          new HtmlRenderError(
            'FFMPEG_FAILED',
            `ffmpeg 启动失败：${describeError(error)}`,
          ),
        );
        return;
      }

      let stderr = '';
      let settled = false;
      // 已判定失败但仍在等子进程退出；close 到达时用它结算，避免把取消记成合成失败
      let pendingError: HtmlRenderError | undefined;

      const finish = (error?: HtmlRenderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        input.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      // SIGKILL 只代表发出了终止请求；只有 close 能证明本次进程和管道已经关闭。
      // 等待期间保留目录和槽位，避免超时兜底提前放行下一次渲染。
      const stopWith = (error: HtmlRenderError) => {
        if (settled || pendingError) return;
        pendingError = error;
        child.kill('SIGKILL');
        clearTimeout(timeoutTimer);
      };
      const onAbort = () => {
        stopWith(new HtmlRenderError('ABORTED', '渲染已被取消'));
      };
      const timeoutTimer = setTimeout(() => {
        stopWith(new HtmlRenderError('FFMPEG_FAILED', 'ffmpeg 合成超时'));
      }, FFMPEG_TIMEOUT_MS);
      input.signal.addEventListener('abort', onAbort, { once: true });

      child.stderr?.on('data', (chunk: Buffer) => {
        // 只保留末尾片段：ffmpeg 的错误行在结尾，而完整日志可能有几十 KB
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
      });
      child.on('error', (error) => {
        // 进程没起来（ENOENT/EACCES）时没有在写文件的进程，可以直接结算
        const failure = new HtmlRenderError(
          'FFMPEG_FAILED',
          `ffmpeg 进程错误：${describeError(error)}`,
        );
        if (child.pid === undefined) finish(failure);
        else stopWith(failure);
      });
      child.on('close', (code) => {
        if (pendingError) {
          finish(pendingError);
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        finish(
          new HtmlRenderError(
            'FFMPEG_FAILED',
            `ffmpeg 合成失败（退出码 ${code ?? 'null'}）：${stderr.trim().slice(0, 500)}`,
          ),
        );
      });
    });
  }

  /**
   * 解析系统 Chrome/Chromium 路径
   * @returns 返回可执行的文件路径
   * @description 显式配置优先且**独占**：配置了 HTML_RENDER_CHROME_PATH 就只用它，失效时直接
   * 报错。回落到探测列表会让「配置写错了」变成「碰巧用了另一份浏览器」，出片差异极难定位。
   * 未配置时才按常见安装位置探测；找不到同样直接失败——没有浏览器的「渲染成功」只可能是假成功。
   */
  private async resolveChromePath(): Promise<string> {
    const configured = this.configService
      .get<string>('HTML_RENDER_CHROME_PATH')
      ?.trim();
    if (configured) {
      try {
        await access(configured, fsConstants.X_OK);
        return configured;
      } catch {
        throw new HtmlRenderError(
          'CHROME_NOT_FOUND',
          `HTML_RENDER_CHROME_PATH 指向的文件不可执行：${configured}`,
        );
      }
    }
    for (const candidate of CHROME_CANDIDATES) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new HtmlRenderError(
      'CHROME_NOT_FOUND',
      '未找到 Chrome/Chromium 可执行文件：请配置 HTML_RENDER_CHROME_PATH 或在镜像内安装 chromium',
    );
  }

  /** 渲染临时目录的根；容器内应指向可写磁盘而不是镜像层。 */
  private tempRoot(): string {
    const configured = this.configService
      .get<string>('HTML_RENDER_TMP_ROOT')
      ?.trim();
    return configured || tmpdir();
  }

  /**
   * 构造可重复调用的临时目录清理函数
   * @param workRoot 本次渲染独占的临时目录
   * @returns 返回幂等的清理函数
   * @description 帧图可能上百 MB，必须保证失败与取消路径也删掉；重复调用不应报错，
   * 否则「上传成功后的清理」会掩盖真正的结果。
   */
  private createDisposer(workRoot: string): () => Promise<void> {
    let disposed = false;
    return async () => {
      if (disposed) return;
      try {
        await rm(workRoot, { recursive: true, force: true });
        disposed = true;
      } catch (error) {
        this.logger.warn(`渲染临时目录清理失败：${describeError(error)}`);
      }
    };
  }

  /**
   * 把内部错误收敛成可判定的渲染错误
   * @param error 捕获到的异常
   * @param signal 本次渲染的取消信号
   * @returns 返回渲染错误
   * @description 取消优先于其他错误：取消时浏览器关闭本身会抛错，不能把取消记成渲染失败。
   */
  private normalizeError(error: unknown, signal: AbortSignal): HtmlRenderError {
    if (signal.aborted) {
      return new HtmlRenderError('ABORTED', '渲染已被取消');
    }
    if (error instanceof HtmlRenderError) {
      return error;
    }
    return new HtmlRenderError(
      'PAGE_ERROR',
      `渲染失败：${describeError(error)}`,
    );
  }

  /**
   * 取得一个渲染槽位
   * @param limit 本次渲染生效的并发上限
   * @param signal 外部取消信号
   * @returns 无返回值；拿到槽位后返回
   * @description 释放时槽位直接移交队首等待者，而不是先归还再让所有人竞争，因此
   * `activeRenders` 始终等于正在渲染的数量，FIFO 也不会被插队。
   *
   * 等待期间取消会把自己从队列里摘掉并立即失败，不会等到前一支长视频跑完才发现。
   */
  private async acquire(limit: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new HtmlRenderError('ABORTED', '渲染已被取消');
    }
    if (this.waiters.length === 0 && this.activeRenders < limit) {
      this.activeRenders += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const removeAbortListener = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: RenderWaiter = {
        grant: () => {
          removeAbortListener();
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        // 已获授权说明槽位归本次渲染，由 render 的 finally 释放，这里不能再动队列
        if (index === -1) return;
        this.waiters.splice(index, 1);
        removeAbortListener();
        reject(new HtmlRenderError('ABORTED', '渲染已被取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
    // 授权与取消可能同时发生：拿到槽位后必须复核一次，否则已取消的渲染会继续跑
    if (signal?.aborted) {
      this.release();
      throw new HtmlRenderError('ABORTED', '渲染已被取消');
    }
  }

  /** 释放渲染槽位：有等待者时直接移交，没有才真正减少计数。 */
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    this.activeRenders = Math.max(0, this.activeRenders - 1);
  }

  /**
   * 读取并发上限
   * @returns 返回本次渲染生效的并发数
   * @description 未配置时默认串行；显式配置必须是正整数。写错时直接失败而不是悄悄回落到 1——
   * 静默回落会让运维以为限制已经生效，实际配置却从没被读过。
   */
  private concurrencyLimit(): number {
    const raw = this.configService
      .get<string>('HTML_RENDER_MAX_CONCURRENCY')
      ?.trim();
    if (!raw) return 1;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new HtmlRenderError(
        'CONFIG_INVALID',
        `HTML_RENDER_MAX_CONCURRENCY 必须是正整数，当前为「${raw}」`,
      );
    }
    return parsed;
  }
}

/**
 * 关闭浏览器
 * @param browser 待关闭的浏览器实例
 * @returns 无返回值
 * @description browser.close 失败时强制终止本次浏览器子进程，并等待 close 再允许释放帧目录。
 * 只处理 Puppeteer 返回的本次子进程，不按进程名称清理，也不影响其他渲染或用户的 Chrome。
 */
async function closeBrowser(browser: Browser): Promise<void> {
  const child = browser.process();
  const closed =
    child && child.exitCode === null && child.signalCode === null
      ? new Promise<void>((resolve) => child.once('close', () => resolve()))
      : Promise.resolve();
  try {
    await browser.close();
  } catch {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await closed;
}

/**
 * 把未知异常压成一段可读文本
 * @param error 捕获到的异常
 * @returns 返回错误信息；非 Error 时退回字符串形式
 * @description 只用于日志与失败摘要，不会作为节点输出写库。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
