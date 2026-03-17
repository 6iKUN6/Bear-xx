declare const process: {
  env: {
    TARO_ENV?: string;
  };
};

function formatUnit(value: number) {
  const normalized = Number((value / 7.5).toFixed(6));
  return `${normalized}vw`;
}

export function rpx(value: number) {
  return process.env.TARO_ENV === "h5" ? formatUnit(value) : `${value}rpx`;
}

export function safeAreaBottom(value: number) {
  return `calc(${rpx(value)} + env(safe-area-inset-bottom))`;
}
