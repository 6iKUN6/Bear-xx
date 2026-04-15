export function px(value: number) {
  return `${value}px`;
}

export function safeAreaBottom(value: number) {
  return `calc(${px(value)} + env(safe-area-inset-bottom))`;
}
