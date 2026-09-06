import { View, Text } from "@tarojs/components";
import type { ThemeColorScheme } from "@litter-bear/theme";
import NavBar from "../../../components/NavBar";
import PageShell from "../../../components/PageShell";
import ThemePicker from "../../../components/ThemePicker";
import AppIcon from "../../../components/AppIcon";
import type { AppIconName } from "../../../components/AppIcon";
import { useThemeStore } from "../../../store/themeStore";
import { appScreenClass } from "../../../utils/style";

const MODE_OPTIONS: { value: ThemeColorScheme; label: string; icon: AppIconName }[] = [
  { value: "light", label: "浅色", icon: "sun" },
  { value: "dark", label: "深色", icon: "moon" },
];

export default function ThemeSettingsPage() {
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);

  return (
    <PageShell>
      <NavBar title="界面主题" showBack capsule="hidden" />

      <View className={appScreenClass}>
        {/* 外观模式：深/浅分段开关 */}
        <View className="mx-[0.875rem] mt-[0.875rem]">
          <View className="flex min-h-[3.25rem] items-center gap-[0.75rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.875rem] py-[0.75rem] shadow-[var(--lb-shadow-card)] box-border">
            <Text className="min-w-0 flex-1 text-[0.875rem] leading-[1.4] text-[var(--lb-text-primary)]">
              外观模式
            </Text>
            <View className="flex shrink-0 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] p-[0.1875rem]">
              {MODE_OPTIONS.map((option) => {
                const active = mode === option.value;
                return (
                  <View
                    key={option.value}
                    className={`box-border flex min-h-[2rem] items-center justify-center gap-[0.25rem] rounded-full px-[0.875rem] ${
                      active
                        ? "bg-[var(--lb-surface-strong)] shadow-[var(--lb-shadow-card)]"
                        : ""
                    }`}
                    onClick={() => setMode(option.value)}
                  >
                    <AppIcon
                      name={option.icon}
                      className={`h-[0.875rem] w-[0.875rem] ${
                        active
                          ? "text-[var(--lb-text-primary)]"
                          : "text-[var(--lb-text-secondary)]"
                      }`}
                    />
                    <Text
                      className={`text-[0.75rem] leading-none ${
                        active
                          ? "text-[var(--lb-text-primary)]"
                          : "text-[var(--lb-text-secondary)]"
                      }`}
                    >
                      {option.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </View>

        <View className="p-[0.875rem]">
          <ThemePicker />
        </View>
      </View>
    </PageShell>
  );
}
