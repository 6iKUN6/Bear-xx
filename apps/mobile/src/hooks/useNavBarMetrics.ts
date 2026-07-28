import Taro from "@tarojs/taro";

export interface NavBarMetrics {
  isWeapp: boolean;
  topPadding: number | string;
  contentHeight: number | string;
  totalHeight: number | string;
  horizontalInset: number;
  sideWidth: number;
  capsuleWidth: number;
  capsuleHeight: number;
}

/** 非小程序端（H5 等）的固定回退值，胶囊尺寸用 CSS 安全区兜底。 */
const WEB_METRICS: NavBarMetrics = {
  isWeapp: false,
  topPadding: "calc(env(safe-area-inset-top) + 8px)",
  contentHeight: 44,
  totalHeight: "calc(env(safe-area-inset-top) + 52px)",
  horizontalInset: 16,
  sideWidth: 44,
  capsuleWidth: 88,
  capsuleHeight: 32,
};

/**
 * 会话级缓存：导航栏尺寸在同一次会话内不变（状态栏高度、胶囊位置为设备常量）。
 * 缓存后避免每次渲染都调用原生测量 API——流式对话高频重渲染时，反复调用是崩溃与性能问题的根源。
 */
let cachedMetrics: NavBarMetrics | null = null;

/**
 * 构建小程序端的安全回退尺寸
 * @param statusBarHeight 状态栏高度
 * @returns 返回不依赖胶囊测量的导航栏尺寸
 * @description 当 getMenuButtonBoundingClientRect 尚不可用（返回 null 或字段缺失）时使用，保证渲染不崩溃。
 */
function buildWeappFallback(statusBarHeight: number): NavBarMetrics {
  return {
    isWeapp: true,
    topPadding: statusBarHeight,
    contentHeight: 44,
    totalHeight: statusBarHeight + 44,
    horizontalInset: 16,
    sideWidth: 44,
    capsuleWidth: 88,
    capsuleHeight: 32,
  };
}

/**
 * 计算导航栏尺寸
 * @returns 返回尺寸及其是否稳定（可缓存）
 * @description 小程序端优先用胶囊按钮测量结果；测量不可用时返回安全回退且标记为不稳定，交由后续渲染重试。
 * 全程对 windowInfo 与胶囊 rect 做空值守卫，任何异常返回都不会抛错。
 */
function computeNavBarMetrics(): { metrics: NavBarMetrics; stable: boolean } {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
    return { metrics: WEB_METRICS, stable: true };
  }

  const windowInfo =
    typeof Taro.getWindowInfo === "function" ? Taro.getWindowInfo() : null;
  const statusBarHeight = windowInfo?.statusBarHeight ?? 0;

  const rect =
    typeof Taro.getMenuButtonBoundingClientRect === "function"
      ? Taro.getMenuButtonBoundingClientRect()
      : null;

  // 胶囊尺寸尚不可用：返回安全回退，标记为不稳定以便下次渲染重试。
  if (
    !rect ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number" ||
    typeof rect.top !== "number" ||
    typeof rect.right !== "number"
  ) {
    return { metrics: buildWeappFallback(statusBarHeight), stable: false };
  }

  const windowWidth = windowInfo?.windowWidth ?? rect.right;
  const verticalGap = Math.max(rect.top - statusBarHeight, 6);
  const horizontalInset = Math.max(windowWidth - rect.right, 12);
  const contentHeight = Math.max(rect.height + verticalGap * 2, 44);

  return {
    metrics: {
      isWeapp: true,
      topPadding: statusBarHeight,
      contentHeight,
      totalHeight: statusBarHeight + contentHeight,
      horizontalInset,
      sideWidth: Math.max(rect.width, 44),
      capsuleWidth: Math.max(rect.width, 88),
      capsuleHeight: Math.max(rect.height, 32),
    },
    stable: true,
  };
}

/**
 * 获取导航栏尺寸
 * @returns 返回导航栏布局所需的尺寸集合
 * @description 结果会话级缓存，避免流式对话高频重渲染时反复调用原生测量 API；
 * 首次或胶囊尚未就绪时返回安全回退（不缓存），待测量稳定后缓存。
 */
export function useNavBarMetrics(): NavBarMetrics {
  if (cachedMetrics) {
    return cachedMetrics;
  }

  const { metrics, stable } = computeNavBarMetrics();
  if (stable) {
    cachedMetrics = metrics;
  }
  return metrics;
}
