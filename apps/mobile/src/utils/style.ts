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

export const appPageClass =
  "relative mx-auto flex h-screen min-h-screen w-full max-w-[24.375rem] flex-col items-stretch justify-start overflow-hidden shadow-[var(--lb-shadow-card)]";

export const appScreenClass =
  "relative min-h-0 w-full flex-1 overflow-y-auto pb-[6.5rem] box-border";

export const appShellFixedClass =
  "fixed left-1/2 right-auto w-full max-w-[24.375rem] -translate-x-1/2 box-border";

export const appGlassCardClass =
  "rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-card)]";

export const appGlassCardStrongClass =
  "rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-strong)] shadow-[var(--lb-shadow-card)]";

export const appGradientSurfaceClass =
  "app-accent-surface text-[var(--lb-on-accent)]";

export const appGradientSurfaceWarmClass =
  "app-accent-surface text-[var(--lb-on-accent)]";

export const appGradientTextClass = "text-[var(--lb-text-primary)]";

export const appHeroClass = "px-[1rem] pb-[0.75rem] pt-[1.25rem]";

export const appHeroTitleClass = `${appGradientTextClass} mb-[0.375rem] block text-[1.5rem] font-bold leading-[1.25]`;

export const appHeroSubtitleClass =
  "block text-[0.9375rem] leading-[1.5] text-[var(--lb-text-secondary)]";

export const appIconTileClass = `${appGradientSurfaceClass} flex items-center justify-center rounded-[var(--lb-radius-sm)] shadow-[var(--lb-shadow-card)]`;

export const appHairlineClass = "h-[0.0625rem] bg-[var(--lb-line-soft)]";

export const appSoftInputClass =
  "border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-card)]";

export const appSolidNavClass =
  "border-b border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-none";

export const appTextTruncateClass =
  "overflow-hidden text-ellipsis whitespace-nowrap";

export const appLoadingDotClass =
  "h-[0.625rem] w-[0.625rem] rounded-full animate-app-loading-bounce";
