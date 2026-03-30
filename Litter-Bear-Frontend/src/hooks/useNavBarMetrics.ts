import Taro from "@tarojs/taro";

export interface NavBarMetrics {
  topPadding: number | string;
  contentHeight: number | string;
  totalHeight: number | string;
  horizontalInset: number;
  sideWidth: number;
}

export function useNavBarMetrics(): NavBarMetrics {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
    return {
      topPadding: "calc(env(safe-area-inset-top) + 8px)",
      contentHeight: 44,
      totalHeight: "calc(env(safe-area-inset-top) + 52px)",
      horizontalInset: 16,
      sideWidth: 44,
    };
  }

  const systemInfo = Taro.getSystemInfoSync();
  const statusBarHeight = systemInfo.statusBarHeight ?? 0;

  if (typeof Taro.getMenuButtonBoundingClientRect !== "function") {
    return {
      topPadding: statusBarHeight,
      contentHeight: 44,
      totalHeight: statusBarHeight + 44,
      horizontalInset: 16,
      sideWidth: 44,
    };
  }

  const menuButtonRect = Taro.getMenuButtonBoundingClientRect();
  const verticalGap = Math.max(menuButtonRect.top - statusBarHeight, 6);
  const horizontalInset = Math.max(systemInfo.windowWidth - menuButtonRect.right, 12);
  const contentHeight = Math.max(menuButtonRect.height + verticalGap * 2, 44);
  const sideWidth = Math.max(menuButtonRect.width, 44);

  return {
    topPadding: statusBarHeight,
    contentHeight,
    totalHeight: statusBarHeight + contentHeight,
    horizontalInset,
    sideWidth,
  };
}
