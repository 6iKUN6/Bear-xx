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

export function useNavBarMetrics(): NavBarMetrics {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
    return {
      isWeapp: false,
      topPadding: "calc(env(safe-area-inset-top) + 8px)",
      contentHeight: 44,
      totalHeight: "calc(env(safe-area-inset-top) + 52px)",
      horizontalInset: 16,
      sideWidth: 44,
      capsuleWidth: 88,
      capsuleHeight: 32,
    };
  }

  const windowInfo = Taro.getWindowInfo();
  const statusBarHeight = windowInfo.statusBarHeight ?? 0;

  if (typeof Taro.getMenuButtonBoundingClientRect !== "function") {
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

  const menuButtonRect = Taro.getMenuButtonBoundingClientRect();
  const verticalGap = Math.max(menuButtonRect.top - statusBarHeight, 6);
  const horizontalInset = Math.max(windowInfo.windowWidth - menuButtonRect.right, 12);
  const contentHeight = Math.max(menuButtonRect.height + verticalGap * 2, 44);
  const sideWidth = Math.max(menuButtonRect.width, 44);
  const capsuleWidth = Math.max(menuButtonRect.width, 88);
  const capsuleHeight = Math.max(menuButtonRect.height, 32);

  return {
    isWeapp: true,
    topPadding: statusBarHeight,
    contentHeight,
    totalHeight: statusBarHeight + contentHeight,
    horizontalInset,
    sideWidth,
    capsuleWidth,
    capsuleHeight,
  };
}
