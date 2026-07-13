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
  "relative mx-auto flex h-screen min-h-screen w-full max-w-[24.375rem] flex-col items-stretch justify-start overflow-hidden bg-gradient-to-br from-[var(--lb-bg-start)] via-[var(--lb-bg-mid)] to-[var(--lb-bg-end)] shadow-[0_0_2.5rem_rgba(0,0,0,0.08)]";

export const appScreenClass =
  "relative min-h-0 w-full flex-1 overflow-y-auto pb-[6.5rem] box-border";

export const appShellFixedClass =
  "fixed left-1/2 right-auto w-full max-w-[24.375rem] -translate-x-1/2 box-border";

export const appGlassCardClass =
  "rounded-[1.5rem] border border-[rgba(255,255,255,0.72)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-card)]";

export const appGlassCardStrongClass =
  "rounded-[2rem] border border-[rgba(255,255,255,0.8)] bg-[var(--lb-surface-strong)] shadow-[var(--lb-shadow-soft)]";

export const appGradientSurfaceClass =
  "bg-gradient-to-br from-[var(--lb-grad-a)] via-[var(--lb-grad-b)] to-[var(--lb-grad-c)] text-white";

export const appGradientSurfaceWarmClass =
  "bg-gradient-to-br from-[var(--lb-grad-warm-a)] to-[var(--lb-grad-warm-b)] text-white";

export const appGradientTextClass =
  "bg-gradient-to-r from-[var(--lb-grad-a)] via-[var(--lb-grad-b)] to-[var(--lb-grad-c)] bg-clip-text text-transparent";

export const appHeroClass = "px-[1.5rem] pb-[1rem] pt-[1.5rem]";

export const appHeroTitleClass = `${appGradientTextClass} mb-[0.5rem] block text-[2rem] font-bold leading-[1.2]`;

export const appHeroSubtitleClass =
  "block text-[0.9375rem] leading-[1.5] text-[var(--lb-text-secondary)]";

export const appIconTileClass = `${appGradientSurfaceClass} flex items-center justify-center rounded-[1rem] shadow-[0_0.875rem_1.75rem_rgba(124,58,237,0.24)]`;

export const appHairlineClass =
  "h-[0.0625rem] bg-gradient-to-r from-transparent via-[rgba(196,181,253,0.46)] to-transparent";

export const appSoftInputClass =
  "border border-[rgba(196,181,253,0.34)] bg-[rgba(255,255,255,0.96)] shadow-[0_0.5rem_1.5rem_rgba(124,58,237,0.08)]";

export const appSolidNavClass =
  "border-b border-[rgba(17,24,39,0.06)] bg-[rgba(255,255,255,0.96)] shadow-[0_0.25rem_0.75rem_rgba(17,24,39,0.04)]";

export const appTextTruncateClass =
  "overflow-hidden text-ellipsis whitespace-nowrap";

export const appBlurOrbClass =
  "pointer-events-none absolute rounded-full opacity-45 blur-[2.5rem]";

export const appLoadingDotClass =
  "h-[0.625rem] w-[0.625rem] rounded-full animate-app-loading-bounce";
