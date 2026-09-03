import type { PropsWithChildren } from "react";
import { View } from "@tarojs/components";
import { createThemeCssVariables, getTheme } from "@litter-bear/theme";
import { useThemeStore } from "../../store/themeStore";
import { appPageClass } from "../../utils/style";

interface PageShellProps extends PropsWithChildren {
  className?: string;
}

export default function PageShell({
  children,
  className = "",
}: PageShellProps) {
  const themeId = useThemeStore((state) => state.themeId);
  const mode = useThemeStore((state) => state.mode);
  const variables = createThemeCssVariables(getTheme(themeId), mode);
  const themeStyle = Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");

  return (
    <View
      className={`${appPageClass} app-theme-root ${className}`.trim()}
      style={themeStyle}
    >
      {children}
    </View>
  );
}
