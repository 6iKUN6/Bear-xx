import Taro from "@tarojs/taro";

function unit() {
  return Taro.getEnv() === Taro.ENV_TYPE.WEB ? "px" : "rpx";
}

export function px(value: number) {
  return `${value}${unit()}`;
}

export function safeAreaBottom(value: number) {
  return `calc(${px(value)} + env(safe-area-inset-bottom))`;
}
