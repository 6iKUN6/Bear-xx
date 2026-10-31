const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readdir, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { ConfigService } = require('@nestjs/config');
const {
  HtmlRenderService,
} = require('../dist/src/modules/html-render/html-render.service');

/**
 * 真实浏览器隔离回归
 * @description 先构建 API，再执行 node --test 本文件。只启动本次测试的回环探针与浏览器，
 * 不连接开发栈/COS，不读取任何真实凭据。Chrome 或 ffmpeg 不可用时真实失败，不用 mock 判过。
 */
test(
  '不可信 HTML 不能经弹窗、WebSocket、子页面或 Worker 访问宿主',
  {
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'html-render-security-'));
    const hits = [];
    const server = createServer((request, response) => {
      hits.push(`http:${request.url}`);
      response.end('local security probe');
    });
    server.on('upgrade', (request, socket) => {
      hits.push(`websocket:${request.url}`);
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      const sentinel = join(root, 'owned-sentinel.txt');
      await writeFile(sentinel, 'owned-render-file-sentinel');
      const service = new HtmlRenderService(
        new ConfigService({
          HTML_RENDER_TMP_ROOT: root,
        }),
      );
      const result = await service.render({
        width: 64,
        height: 64,
        durationSeconds: 1,
        fps: 1,
        signal: AbortSignal.timeout(25_000),
        html: `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'">
        </head><body>中文
        <img src="${base}/image">
        <iframe src="${base}/iframe"></iframe>
        <iframe src="${pathToFileURL(sentinel).href}"></iframe>
        <script>
          let fileWasRead = false;
          const ignore = () => {};
          fetch(${JSON.stringify(pathToFileURL(sentinel).href)})
            .then(response => response.text()).then(() => { fileWasRead = true; }).catch(ignore);
          fetch(${JSON.stringify(`${base}/fetch`)}).catch(ignore);
          try { new WebSocket(${JSON.stringify(`ws://127.0.0.1:${address.port}/socket`)}); } catch {}
          window.open(${JSON.stringify(`${base}/popup`)});
          const popup = window.open('about:blank');
          if (popup) popup.location = ${JSON.stringify(`${base}/blank-popup`)};
          try {
            new Worker(URL.createObjectURL(new Blob([
              ${JSON.stringify(`fetch('${base}/worker'); new WebSocket('ws://127.0.0.1:${address.port}/worker-socket');`)},
            ], { type: 'text/javascript' })));
          } catch {}
          window.renderFrame = async () => {
            await new Promise(resolve => setTimeout(resolve, 800));
            if (fileWasRead) throw new Error('sandbox file read bypass');
          };
        </script></body></html>`,
      });
      try {
        assert.equal(result.frameCount, 1);
        assert.ok(result.byteLength > 0);
        assert.deepEqual(hits, [], '任何探针命中都代表宿主网络隔离被绕过');
      } finally {
        await result.dispose();
      }
      assert.deepEqual(await readdir(root), ['owned-sentinel.txt']);
      const commands = execFileSync('ps', ['-axo', 'command='], {
        encoding: 'utf8',
      });
      assert.equal(
        commands
          .split('\n')
          .some((line) => line.includes(`${root}/html-render-`)),
        false,
        '本次浏览器子进程必须已退出',
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
