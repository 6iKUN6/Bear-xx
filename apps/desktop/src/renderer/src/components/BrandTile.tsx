interface BrandTileProps {
  size?: number;
}

/** Sola 品牌瓷贴：accent 面 + 字母 S，侧边栏 / 空状态 / 登录页共用 */
export function BrandTile({ size = 32 }: BrandTileProps) {
  return (
    <span
      className="lb-accent-surface inline-flex shrink-0 items-center justify-center rounded-[var(--lb-radius-sm)] font-bold text-[var(--lb-on-accent)]"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      S
    </span>
  );
}
