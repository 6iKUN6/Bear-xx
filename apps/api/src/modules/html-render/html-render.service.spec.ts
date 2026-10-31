import { PassThrough } from 'node:stream';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'node:child_process';
import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import { HtmlRenderService } from './html-render.service';

// puppeteer-core 只发布 ESM，测试里把它换成一个可断言的最小替身：这里验证的是「服务如何
// 驱动浏览器」，真实浏览器行为由独立渲染管线脚本单独取证。
jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));
// ffmpeg 同理：断言参数数组与失败收敛，不真的编码视频。
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>(
    'node:child_process',
  ),
  spawn: jest.fn(),
}));
// mkdir 默认透传真实实现，只用来让「帧目录建不出来」这条失败路径可复现。
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, mkdir: jest.fn(actual.mkdir) };
});

const launchMock = jest.spyOn(puppeteer, 'launch');
const spawnMock = jest.mocked(spawn);
const mkdirMock = jest.mocked(mkdir);

describe('HtmlRenderService', () => {
  let service: HtmlRenderService;
  let config: Record<string, string>;
  let tempRoot: string;
  let page: FakePage;
  let browser: { newPage: jest.Mock; close: jest.Mock; process: jest.Mock };
  let createPage: () => FakePage;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'html-render-spec-'));
    page = new FakePage();
    createPage = () => page;
    browser = {
      newPage: jest.fn(() => Promise.resolve(createPage())),
      close: jest.fn(() => Promise.resolve(undefined)),
      process: jest.fn(() => null),
    };
    // 替身只实现服务实际调用的两个方法，其余 Browser 成员与本次断言无关
    launchMock.mockResolvedValue(browser as Browser);
    spawnMock.mockImplementation((_command, args) => {
      if (!Array.isArray(args)) throw new Error('ffmpeg 必须使用参数数组');
      const outputPath: unknown = args[args.length - 1];
      if (typeof outputPath !== 'string') throw new Error('缺少成片输出路径');
      return fakeFfmpegProcess(0, outputPath);
    });
    config = {
      HTML_RENDER_CHROME_PATH: process.execPath,
      HTML_RENDER_TMP_ROOT: tempRoot,
      HTML_RENDER_FFMPEG_PATH: 'ffmpeg',
    };
    service = new HtmlRenderService(createConfigService(config));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('按帧号推进时间轴，逐帧截图后交给 ffmpeg 合成', async () => {
    const result = await service.render({
      html: '<html><body>动画</body></html>',
      width: 1080,
      height: 1920,
      durationSeconds: 1,
      fps: 4,
    });

    expect(page.setViewport).toHaveBeenCalledWith({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
    });
    // 时间戳只由帧号决定：第 i 帧是 i / fps 秒，与真实耗时无关
    expect(page.frameTimes).toEqual([0, 0.25, 0.5, 0.75]);
    expect(page.screenshotPaths).toEqual([
      expect.stringContaining('frame-000000.png'),
      expect.stringContaining('frame-000001.png'),
      expect.stringContaining('frame-000002.png'),
      expect.stringContaining('frame-000003.png'),
    ]);
    expect(result.frameCount).toBe(4);
    expect(await pathExists(result.filePath)).toBe(true);

    const ffmpegArgs = spawnMock.mock.calls[0];
    if (!Array.isArray(ffmpegArgs[1]))
      throw new Error('ffmpeg 必须使用参数数组');
    expect(ffmpegArgs[0]).toBe('ffmpeg');
    expect(ffmpegArgs[1]).toEqual(
      expect.arrayContaining(['-framerate', '4', '-pix_fmt', 'yuv420p']),
    );
    expect(ffmpegArgs[1]).not.toContain('sh');
    expect(ffmpegArgs[1][ffmpegArgs[1].length - 1]).toBe(result.filePath);

    await result.dispose();
    expect(await pathExists(result.filePath)).toBe(false);
    expect(browser.close).toHaveBeenCalled();
  });

  it('等待中文字体就绪后才开始截图', async () => {
    await service.render(renderRequest({ durationSeconds: 1, fps: 2 }));

    const fontReadyIndex = page.evaluations.findIndex((expression) =>
      expression.includes('document.fonts.ready'),
    );
    expect(fontReadyIndex).toBeGreaterThanOrEqual(0);
    expect(fontReadyIndex).toBeLessThan(page.firstScreenshotOrder);
  });

  it('HTML 缺少 renderFrame 时明确失败，不靠等待动画自然播完', async () => {
    page.hasFrameApi = false;

    await expect(service.render(renderRequest())).rejects.toMatchObject({
      code: 'FRAME_API_MISSING',
    });
    expect(page.screenshotPaths).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('renderFrame 抛错时按取帧失败收敛并清理临时目录', async () => {
    page.frameError = new Error('动画脚本报错');

    await expect(service.render(renderRequest())).rejects.toMatchObject({
      code: 'FRAME_CAPTURE_FAILED',
    });
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it('ffmpeg 非零退出时失败并清掉本次帧目录', async () => {
    spawnMock.mockImplementation(() => fakeFfmpegProcess(1));
    await expect(service.render(renderRequest())).rejects.toMatchObject({
      code: 'FFMPEG_FAILED',
    });
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it('取消信号会中止渲染、关闭浏览器并清理帧目录', async () => {
    const controller = new AbortController();
    page.onScreenshot = () => {
      if (page.screenshotPaths.length === 2) controller.abort();
    };

    await expect(
      service.render({ ...renderRequest(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(browser.close).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it.each([
    ['奇数宽度', { width: 1081 }],
    ['超长时长', { durationSeconds: 1801 }],
    ['超出帧数预算', { durationSeconds: 1800, fps: 60 }],
    ['超出单帧像素', { width: 3840, height: 3840 }],
  ])('%s 在启动浏览器前就拒绝', async (_label, overrides) => {
    await expect(
      service.render({ ...renderRequest(), ...overrides }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('拒绝超过体积上限的 HTML', async () => {
    await expect(
      service.render({ ...renderRequest(), html: 'x'.repeat(5_000_001) }),
    ).rejects.toMatchObject({ code: 'HTML_TOO_LARGE' });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('优先使用显式配置的 Chrome 路径', async () => {
    await service.render(renderRequest());

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: process.execPath,
        headless: true,
      }),
    );
  });

  it('浏览器保留沙箱、使用管道且不继承 Worker 凭据环境', async () => {
    const result = await service.render(renderRequest());
    const options = launchMock.mock.calls[0][0];
    expect(options?.pipe).toBe(true);
    expect(options?.args).not.toContain('--no-sandbox');
    expect(options?.args).toContain('--proxy-bypass-list=<-loopback>');
    expect(options?.env).not.toBe(process.env);
    expect(Object.keys(options?.env ?? {})).toEqual(
      expect.arrayContaining(['HOME', 'TMPDIR']),
    );
    expect(
      Object.keys(options?.env ?? {}).every((key) =>
        [
          'HOME',
          'TMPDIR',
          'PATH',
          'LANG',
          'LC_ALL',
          'TZ',
          'SystemRoot',
        ].includes(key),
      ),
    ).toBe(true);
    expect(options?.userDataDir).toContain(tempRoot);
    await result.dispose();
  });

  it('root 环境拒绝启动，不自动禁用 Chromium 沙箱', async () => {
    if (!process.getuid) throw new Error('该回归需要 Unix uid');
    const uid = jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      await expect(service.render(renderRequest())).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      expect(launchMock).not.toHaveBeenCalled();
      expect(await listRenderDirs(tempRoot)).toEqual([]);
    } finally {
      uid.mockRestore();
    }
  });

  it('HTML 由带 sandbox/CSP 的可信响应头载入，只放行一次主文档', async () => {
    const result = await service.render(renderRequest());
    const policy = page.documentHeaders['Content-Security-Policy'];
    expect(policy).toContain('sandbox allow-scripts');
    for (const kind of ['connect', 'frame', 'worker', 'object']) {
      expect(policy).toContain(`${kind}-src 'none'`);
    }
    expect(policy).not.toContain('allow-popups');
    expect(policy).not.toContain('allow-same-origin');
    expect(
      await page.dispatchRequest('https://html-render.invalid/', true),
    ).toBe('blocked');
    expect(await page.dispatchRequest('http://127.0.0.1/private', false)).toBe(
      'blocked',
    );
    expect(await page.dispatchRequest('file:///private/sentinel', true)).toBe(
      'blocked',
    );
    expect(await page.dispatchRequest('data:text/plain,safe', false)).toBe(
      'continued',
    );
    await result.dispose();
  });

  it('浏览器关闭报错时等待本次子进程 close 再清理目录', async () => {
    const child = controllableFfmpegProcess();
    browser.process.mockReturnValue(child);
    browser.close.mockRejectedValueOnce(new Error('CDP 已断开'));
    const rendering = service.render(renderRequest());
    await waitUntil(() => child.kill.mock.calls.length === 1);
    expect(await listRenderDirs(tempRoot)).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
    child.emit('close', null);
    const result = await rendering;
    await result.dispose();
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it('显式 Chrome 路径失效时直接失败，不回落到探测列表', async () => {
    const brokenPath = join(tempRoot, 'chrome-without-exec-bit');
    await writeFile(brokenPath, 'not a binary');
    config.HTML_RENDER_CHROME_PATH = brokenPath;

    const rendering = service.render(renderRequest());
    await expect(rendering).rejects.toMatchObject({ code: 'CHROME_NOT_FOUND' });
    await expect(rendering).rejects.toThrow(brokenPath);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it.each([['0'], ['-1'], ['2.5'], ['abc']])(
    '显式并发上限 %s 非法时直接失败，不静默回落到 1',
    async (raw) => {
      config.HTML_RENDER_MAX_CONCURRENCY = raw;

      await expect(service.render(renderRequest())).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      expect(launchMock).not.toHaveBeenCalled();
    },
  );

  it('临时根目录不存在时失败，且不占住槽位让下一个请求继续', async () => {
    const missingRoot = join(tempRoot, 'missing-root');
    config.HTML_RENDER_TMP_ROOT = missingRoot;

    const rendering = service.render(renderRequest());
    await expect(rendering).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(rendering).rejects.toThrow(missingRoot);
    // 服务不会替配置建目录：卷没挂上必须是一次看得见的失败
    expect(await pathExists(missingRoot)).toBe(false);
    expect(launchMock).not.toHaveBeenCalled();

    // 并发上限为 1；槽位若漏释放，这次渲染会一直排在前一次失败后面
    config.HTML_RENDER_TMP_ROOT = tempRoot;
    const result = await service.render(renderRequest());
    expect(result.frameCount).toBe(2);
    await result.dispose();
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it('帧目录创建失败时清掉已建目录并释放槽位', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('磁盘已满'));

    await expect(service.render(renderRequest())).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await listRenderDirs(tempRoot)).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();

    const result = await service.render(renderRequest());
    expect(result.frameCount).toBe(2);
    await result.dispose();
  });

  it('排队等待期间取消会立即失败，被移除的等待者不阻塞后续请求', async () => {
    const gate = deferred();
    page.screenshotGate = gate.promise;
    const started = deferred();
    page.onScreenshot = () => started.resolve();

    const first = service.render(renderRequest());
    await started.promise;

    const controller = new AbortController();
    const queued = service.render({
      ...renderRequest(),
      signal: controller.signal,
    });
    await flushEventLoop();
    controller.abort();

    // 第一支仍卡在截图上，排队者必须现在就知道自己被取消，而不是等它跑完
    await expect(queued).rejects.toMatchObject({ code: 'ABORTED' });

    gate.resolve();
    await expect(first).resolves.toMatchObject({ frameCount: 2 });

    // 队列里若还留着已取消的等待者，这一支会一直排到超时
    await expect(service.render(renderRequest())).resolves.toMatchObject({
      frameCount: 2,
    });
  });

  it('并发上限内的请求按提交顺序串行执行', async () => {
    const gate = deferred();
    const pages: FakePage[] = [];
    const started: number[] = [];
    let running = 0;
    let maxRunning = 0;
    createPage = () => {
      const created = new FakePage();
      const id = pages.length;
      pages.push(created);
      if (id === 0) created.screenshotGate = gate.promise;
      created.goto.mockImplementation(() => {
        started.push(id);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return Promise.resolve(undefined);
      });
      return created;
    };
    const track = (promise: Promise<unknown>) =>
      promise.finally(() => {
        running -= 1;
      });

    const first = track(service.render(renderRequest()));
    await waitUntil(() => pages[0]?.screenshotPaths.length === 1);
    const second = track(service.render(renderRequest()));
    const third = track(service.render(renderRequest()));
    await flushEventLoop();
    gate.resolve();
    await Promise.all([first, second, third]);

    expect(started).toEqual([0, 1, 2]);
    expect(maxRunning).toBe(1);
  });

  it('浏览器启动期间取消：返回后立即关闭且不再加载 HTML', async () => {
    const launching = deferred<Browser>();
    launchMock.mockReturnValueOnce(launching.promise);
    const controller = new AbortController();

    const rendering = service.render({
      ...renderRequest(),
      signal: controller.signal,
    });
    await waitUntil(() => launchMock.mock.calls.length === 1);
    controller.abort();
    launching.resolve(browser as Browser);

    await expect(rendering).rejects.toMatchObject({ code: 'ABORTED' });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(await listRenderDirs(tempRoot)).toEqual([]);
  });

  it('取消 ffmpeg 后即使超过五秒也等 close 才结算并释放目录', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const child = controllableFfmpegProcess();
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();

    let settled = false;
    const rendering = service.render({
      ...renderRequest(),
      signal: controller.signal,
    });
    void rendering.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitUntil(() => spawnMock.mock.calls.length === 1);
    const workRoot = dirname(dirname(page.screenshotPaths[0]));

    controller.abort();
    await jest.advanceTimersByTimeAsync(6_000);

    // 只 kill 不结算：此时子进程仍可能写文件，目录与槽位都必须继续被这一支持有
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    expect(await pathExists(workRoot)).toBe(true);

    child.emit('close', null);
    await expect(rendering).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await pathExists(workRoot)).toBe(false);
  });

  /**
   * 构造一次渲染请求
   * @param overrides 需要覆盖的字段
   * @returns 返回默认 1080×1920、1 秒 2 帧的请求
   */
  function renderRequest(overrides: Record<string, unknown> = {}) {
    return {
      html: '<html><body>动画</body></html>',
      width: 1080,
      height: 1920,
      durationSeconds: 1,
      fps: 2,
      ...overrides,
    };
  }
});

/**
 * 可断言的最小页面替身
 * @description 只实现渲染服务实际调用的接口；截图顺序、evaluate 表达式与 renderFrame 时间点
 * 都被记录下来，供用例断言确定性取帧与字体等待顺序。
 */
class FakePage {
  readonly evaluations: string[] = [];
  readonly frameTimes: number[] = [];
  readonly screenshotPaths: string[] = [];
  hasFrameApi = true;
  frameError: Error | null = null;
  onScreenshot: (() => void) | null = null;
  /** 非空时每次截图都等它 resolve，用来把一次渲染卡在取帧中途。 */
  screenshotGate: Promise<void> | null = null;

  /** 第一次截图时的 evaluate 调用序号，用于断言字体等待发生在截图之前。 */
  firstScreenshotOrder = Number.POSITIVE_INFINITY;

  setViewport = jest.fn(() => Promise.resolve(undefined));

  setRequestInterception = jest.fn(() => Promise.resolve(undefined));

  documentHeaders: Record<string, string> = {};
  private requestHandler?: (request: HTTPRequest) => unknown;

  on = jest.fn((event: string, handler: (request: HTTPRequest) => unknown) => {
    if (event === 'request') this.requestHandler = handler;
  });

  mainFrame = () => null;

  goto = jest.fn(async (url: string) => {
    await this.dispatchRequest(url, true);
  });

  /**
   * 向真实拦截策略提交最小请求替身
   * @param url 请求地址
   * @param navigation 是否为导航请求
   * @returns 返回拦截策略的最终处置
   * @description 替身仅实现策略使用的方法，不伪造浏览器级隔离；隔离另有真实 Chrome 回归。
   */
  async dispatchRequest(url: string, navigation: boolean): Promise<string> {
    let outcome = 'pending';
    const request: Partial<HTTPRequest> = {
      url: () => url,
      isNavigationRequest: () => navigation,
      frame: () => null,
      respond: (response) => {
        this.documentHeaders = response.headers ?? {};
        outcome = 'responded';
        return Promise.resolve();
      },
      continue: () => {
        outcome = 'continued';
        return Promise.resolve();
      },
      abort: () => {
        outcome = 'blocked';
        return Promise.resolve();
      },
    };
    // 只将策略消费的方法组成的替身交给处理器，未用方法不参与这条单测。
    await this.requestHandler?.(request as HTTPRequest);
    return outcome;
  }

  waitForFunction = jest.fn(() =>
    this.hasFrameApi
      ? Promise.resolve(undefined)
      : Promise.reject(new Error('timeout')),
  );

  evaluate = jest.fn(
    (
      expression: string | ((...args: never[]) => unknown),
      argument?: number,
    ) => {
      if (typeof expression === 'string') {
        this.evaluations.push(expression);
        return Promise.resolve(true);
      }
      this.evaluations.push('renderFrame');
      if (this.frameError) return Promise.reject(this.frameError);
      this.frameTimes.push(argument as number);
      return Promise.resolve(undefined);
    },
  );

  screenshot = jest.fn(async (options: { path: string }) => {
    this.firstScreenshotOrder = Math.min(
      this.firstScreenshotOrder,
      this.evaluations.length,
    );
    this.screenshotPaths.push(options.path);
    this.onScreenshot?.();
    if (this.screenshotGate) await this.screenshotGate;
  });
}

/**
 * 构造一个可控的 ffmpeg 子进程替身
 * @param exitCode 进程退出码
 * @returns 返回带 stderr 流与 kill 的最小 ChildProcess 形状
 */
function fakeFfmpegProcess(exitCode: number, outputPath?: string) {
  const child = createChildProcessStub();
  setImmediate(() => {
    if (exitCode !== 0) child.stderr?.emit('data', Buffer.from('编码失败'));
    if (exitCode === 0 && outputPath) {
      // 真实 ffmpeg 会写出成片；服务随后 stat 这个文件，因此替身也要落盘
      void writeFile(outputPath, Buffer.from('fake-mp4')).then(() =>
        child.emit('close', exitCode),
      );
      return;
    }
    child.emit('close', exitCode);
  });
  return child;
}

/**
 * 构造一个只在测试显式 emit 时才 close 的 ffmpeg 子进程替身
 * @returns 返回带 stderr 流、kill 与已启动 pid 的子进程替身
 * @description 用来验证「kill 之后必须等 close」：close 由用例延后触发，替身不会自己结束。
 */
function controllableFfmpegProcess() {
  const child = createChildProcessStub();
  Object.defineProperty(child, 'pid', { value: 4321 });
  return child;
}

/**
 * 构造子进程替身骨架
 * @returns 返回带 stderr 流与 kill 的空壳子进程
 */
function createChildProcessStub() {
  const child = Object.assign(new ChildProcess(), {
    stderr: new PassThrough(),
    kill: jest.fn<boolean, [NodeJS.Signals?]>(),
  });
  return child;
}

/**
 * 构造本次测试使用的配置服务
 * @param values 环境变量键值与读取结果
 * @returns 返回可直接传给服务的配置对象
 * @description 传入的是同一个可变对象，用例可以在两次渲染之间改配置来复现「配置修好后
 * 同一实例能继续工作」。
 */
function createConfigService(values: Record<string, string>) {
  return new ConfigService(values);
}

/**
 * 构造一个可手动结算的 promise
 * @returns 返回 promise 与 resolve 函数
 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/**
 * 反复让出事件循环直到条件成立
 * @param predicate 需要成立的条件
 * @returns 条件成立后返回
 * @description 只在同一轮里让出微/宏任务，不做时间等待，条件不成立会直接失败。
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('等待条件成立超时');
}

/**
 * 让出若干轮事件循环
 * @param turns 让出的轮数
 * @returns 让出后返回
 * @description 用于让已经在跑但还没进入队列的渲染走到下一步，例如 Chrome 路径探测这类异步
 * 文件访问完成之后。
 */
async function flushEventLoop(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 判断路径是否存在
 * @param path 目标路径
 * @returns 存在返回 true
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出渲染临时根目录下残留的渲染目录
 * @param root 渲染临时根目录
 * @returns 返回残留目录名列表
 */
async function listRenderDirs(root: string): Promise<string[]> {
  const entries = await readdir(root);
  return entries.filter((entry) => entry.startsWith('html-render-'));
}
