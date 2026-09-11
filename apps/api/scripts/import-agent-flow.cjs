#!/usr/bin/env node
/**
 * 将标准 FlowDefinition JSON 创建为新的 AgentFlow 草稿，并可选择立即发布。
 *
 * 用法：
 *   pnpm --filter ./apps/api run flow:import -- ./scripts/fixtures/loop-container-v10.json
 *   pnpm --filter ./apps/api run flow:import -- ./scripts/fixtures/loop-container-v10.json \
 *     --model-preset=<presetId> --publish
 */
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

/**
 * 解析命令行参数
 * @param {string[]} argv 去掉 node 与脚本路径后的参数
 * @returns {{ filePath?: string, publish: boolean, actor?: string, modelPreset?: string, help: boolean }} 返回导入选项
 * @description 文件路径只允许一个；未知开关和空参数直接失败，避免静默执行错误操作。
 */
function parseArguments(argv) {
  const options = {
    filePath: undefined,
    publish: false,
    actor: undefined,
    modelPreset: undefined,
    help: false,
  };
  for (const argument of argv) {
    if (argument === '--') {
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--publish') {
      options.publish = true;
      continue;
    }
    if (argument.startsWith('--actor=')) {
      options.actor = requireOptionValue(argument, '--actor=');
      continue;
    }
    if (argument.startsWith('--model-preset=')) {
      options.modelPreset = requireOptionValue(argument, '--model-preset=');
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`未知参数：${argument}`);
    }
    if (options.filePath) {
      throw new Error('只能指定一个 JSON 文件路径');
    }
    options.filePath = argument;
  }
  if (!options.help && !options.filePath) {
    throw new Error('必须提供 FlowDefinition JSON 文件路径');
  }
  return options;
}

/**
 * 读取非空命令行选项值
 * @param {string} argument 完整参数
 * @param {string} prefix 参数名前缀
 * @returns {string} 返回去除首尾空白的选项值
 * @description 空值属于输入错误，不能回退到自动选择后执行另一个操作者或模型。
 */
function requireOptionValue(argument, prefix) {
  const value = argument.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} 不能为空`);
  return value;
}

/**
 * 读取并解析 FlowDefinition 文件
 * @param {string} filePath 命令行提供的文件路径
 * @param {string} cwd 相对路径的解析目录
 * @returns {{ absolutePath: string, definition: object }} 返回绝对路径和对象根 JSON
 * @description 文件与 JSON 基础错误在启动 Nest 前暴露，避免无效输入仍连接数据库和 Redis。
 */
function readDefinitionFile(filePath, cwd = process.cwd()) {
  const absolutePath = path.resolve(cwd, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`JSON 文件不存在：${absolutePath}`);
  }
  let definition;
  try {
    definition = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(definition)) {
    throw new Error('FlowDefinition JSON 根值必须是对象');
  }
  return { absolutePath, definition };
}

/**
 * 用指定模型预设物化 Definition 中的全部模型节点
 * @param {object} input 原始 Definition 对象
 * @param {{ id: string, reasoning?: object }} model 目标模型预设及其默认思考选择
 * @returns {object} 返回独立的物化 Definition，不修改调用方对象
 * @description 覆盖范围与运行时模型节点闭集一致；固定思考或普通模型会移除旧 reasoning，
 * 可调思考模型写入能力目录默认值，使自定义 Flow 的发布配置保持显式且可校验。
 */
function materializeModelPreset(input, model) {
  const definition = JSON.parse(JSON.stringify(input));
  if (!Array.isArray(definition.nodes)) return definition;
  for (const node of definition.nodes) {
    if (!isRecord(node) || !isRecord(node.config)) continue;
    let config;
    if (node.type === 'plan-loop' && isRecord(node.config.executor)) {
      config = node.config.executor;
    } else if (
      node.type === 'agent' ||
      node.type === 'plan' ||
      node.type === 'synthesize' ||
      (node.type === 'approval' && node.config.policy === 'model')
    ) {
      config = node.config;
    }
    if (!config) continue;
    config.modelPreset = model.id;
    if (model.reasoning) {
      config.reasoning = JSON.parse(JSON.stringify(model.reasoning));
    } else {
      delete config.reasoning;
    }
  }
  return definition;
}

/**
 * 在正式服务层上执行创建与可选发布
 * @param {object} input 导入依赖和参数
 * @param {string} input.actorId 审计操作者 ID
 * @param {object} input.definition 最终入库 Definition
 * @param {object} input.flowService AgentFlowService 实例
 * @param {boolean} input.publish 是否发布
 * @param {object} input.versionService AgentFlowVersionService 实例
 * @returns {Promise<{ flow: object, version: object }>} 返回创建的 Flow 和最终版本
 * @description 发布先对内存 Definition 做完整预检，确定性错误不会留下半成品；创建后的瞬时
 * 发布故障会保留草稿并携带其 ID 抛错，方便管理员恢复而不是静默删除审计事实。
 */
async function importFlowWithServices(input) {
  if (input.publish) {
    const validation = await input.versionService.validateDefinition(
      input.definition,
    );
    if (!validation.valid) {
      throw new Error(
        `发布预检失败：${formatValidationErrors(validation.errors)}`,
      );
    }
  }

  const flow = await input.flowService.create(input.definition, input.actorId);
  if (!flow.draftVersion) {
    throw new Error(`Flow「${flow.id ?? '未知'}」创建后未返回草稿版本`);
  }
  if (!input.publish) {
    return { flow, version: flow.draftVersion };
  }

  try {
    const version = await input.versionService.publish(
      flow.draftVersion.id,
      input.actorId,
    );
    return { flow, version };
  } catch (error) {
    throw new Error(
      `Flow ${flow.id} 的草稿 ${flow.draftVersion.id} 已创建，但发布失败：${formatError(error)}`,
      { cause: error },
    );
  }
}

/**
 * 解析本次审计操作者
 * @param {object} prisma PrismaService 实例
 * @param {string | undefined} selector 可选用户 ID 或用户名
 * @returns {Promise<{ id: string, username: string | null, role: string }>} 返回管理员摘要
 * @description 显式选择必须命中 ADMIN/SUPER_ADMIN；缺省优先最早创建的 SUPER_ADMIN，
 * 再选择最早创建的 ADMIN，绝不借用普通用户身份。
 */
async function resolveActor(prisma, selector) {
  const select = { id: true, username: true, role: true };
  if (selector) {
    const actor = await prisma.user.findFirst({
      where: {
        role: { in: ['ADMIN', 'SUPER_ADMIN'] },
        OR: [{ id: selector }, { username: selector.toLowerCase() }],
      },
      select,
    });
    if (!actor) {
      throw new Error(`未找到匹配的管理员：${selector}`);
    }
    return actor;
  }
  for (const role of ['SUPER_ADMIN', 'ADMIN']) {
    const actor = await prisma.user.findFirst({
      where: { role },
      orderBy: { createdAt: 'asc' },
      select,
    });
    if (actor) return actor;
  }
  throw new Error(
    '数据库中没有 ADMIN 或 SUPER_ADMIN，无法记录 Flow 审计操作者',
  );
}

/**
 * 解析显式模型覆盖及其默认思考参数
 * @param {object} modelRegistry LlmModelRegistryService 实例
 * @param {string | undefined} presetId 命令行指定的模型预设 ID
 * @returns {{ id: string, reasoning?: object } | undefined} 返回可用于 Definition 物化的模型
 * @description 只接受当前运行时已加载的可用预设；默认思考选择来自同一能力目录，不按模型名猜测。
 */
function resolveModelOverride(modelRegistry, presetId) {
  if (!presetId) return undefined;
  const preset = modelRegistry
    .listAvailableModels()
    .find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`模型预设不存在或未启用：${presetId}`);
  }
  const reasoning = preset.reasoningCapability?.defaultSelection;
  return reasoning ? { id: preset.id, reasoning } : { id: preset.id };
}

/**
 * 格式化 Definition 校验错误
 * @param {Array<{ path?: string, rule?: string, message?: string }>} errors 校验错误列表
 * @returns {string} 返回单行可定位摘要
 */
function formatValidationErrors(errors) {
  return errors
    .map(
      (error) =>
        `${error.path ?? '$'} [${error.rule ?? 'unknown'}] ${error.message ?? '未知错误'}`,
    )
    .join('；');
}

/**
 * 格式化未知异常
 * @param {unknown} error 捕获到的异常
 * @returns {string} 返回不含请求凭据的错误说明
 * @description Nest HttpException 的对象响应会展开 message 与 errors，避免打印成 `[object Object]`。
 */
function formatError(error) {
  if (error && typeof error.getResponse === 'function') {
    const response = error.getResponse();
    if (isRecord(response)) {
      const message =
        typeof response.message === 'string' ? response.message : error.message;
      const details = Array.isArray(response.errors)
        ? formatValidationErrors(response.errors)
        : '';
      return details ? `${message}：${details}` : message;
    }
    if (typeof response === 'string') return response;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断未知值是否为普通对象
 * @param {unknown} value 待检查值
 * @returns {boolean} 返回是否可按键值对象读取
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 加载本地 API 环境变量
 * @param {string} environmentFile `.env` 绝对路径
 * @returns {void} 无返回值
 * @description 文件不存在时沿用容器或调用方注入的环境变量，不创建或改写任何配置文件。
 */
function loadEnvironment(environmentFile) {
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
}

/**
 * 打印命令用法
 * @returns {void} 无返回值
 */
function printUsage() {
  console.log(
    '用法：pnpm --filter ./apps/api run flow:import -- <flow.json> [--publish] ' +
      '[--actor=<用户ID或用户名>] [--model-preset=<presetId>]',
  );
}

/**
 * 执行 Flow JSON 导入命令
 * @returns {Promise<void>} 无返回值
 * @description 输入文件通过基础解析后才启动 Nest；所有数据库写入均委托正式 AgentFlow 服务。
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const source = readDefinitionFile(options.filePath);
  const apiRoot = path.resolve(__dirname, '..');
  loadEnvironment(path.join(apiRoot, '.env'));
  process.env.TS_NODE_PROJECT = path.join(apiRoot, 'tsconfig.json');
  require('ts-node/register');
  require('tsconfig-paths/register');

  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../src/app.module');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const {
    AgentFlowService,
  } = require('../src/modules/agent-flow/agent-flow.service');
  const {
    AgentFlowVersionService,
  } = require('../src/modules/agent-flow/agent-flow-version.service');
  const {
    LlmModelRegistryService,
  } = require('../src/modules/llm/llm-model-registry.service');

  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = application.get(PrismaService);
    const flowService = application.get(AgentFlowService);
    const versionService = application.get(AgentFlowVersionService);
    const modelRegistry = application.get(LlmModelRegistryService);
    const actor = await resolveActor(prisma, options.actor);
    const model = resolveModelOverride(modelRegistry, options.modelPreset);
    const definition = model
      ? materializeModelPreset(source.definition, model)
      : source.definition;
    const result = await importFlowWithServices({
      actorId: actor.id,
      definition,
      flowService,
      publish: options.publish,
      versionService,
    });

    console.log(
      `[flow:import] 已${options.publish ? '发布' : '创建草稿'}：${definition.name}`,
    );
    console.log(`[flow:import] Flow ID: ${result.flow.id}`);
    console.log(`[flow:import] Version ID: ${result.version.id}`);
    console.log(`[flow:import] 状态: ${result.version.status}`);
    console.log(
      `[flow:import] 操作者: ${actor.username ?? actor.id} (${actor.role})`,
    );
    console.log(`[flow:import] 模型覆盖: ${model?.id ?? '未使用'}`);
    console.log(`[flow:import] 来源: ${source.absolutePath}`);
    console.log(
      `[flow:import] 编辑器: /flows/${result.flow.id}/versions/${result.version.id}/edit`,
    );
  } finally {
    await application.close();
  }
}

module.exports = {
  formatError,
  formatValidationErrors,
  importFlowWithServices,
  materializeModelPreset,
  parseArguments,
  readDefinitionFile,
  resolveActor,
  resolveModelOverride,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[flow:import] 失败：${formatError(error)}`);
    process.exit(1);
  });
}
