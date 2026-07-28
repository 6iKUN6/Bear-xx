import { View, Text } from "@tarojs/components";
import NavBar from "../../../components/NavBar";
import PageShell from "../../../components/PageShell";
import ThemePicker from "../../../components/ThemePicker";
import { appScreenClass } from "../../../utils/style";

export default function ThemeSettingsPage() {
  return (
    <PageShell>
      <NavBar title="界面主题" showBack capsule="hidden" />

      <View className={appScreenClass}>
        <View className="px-[1rem] pb-[0.5rem] pt-[0.875rem]">
          <Text className="mb-[0.375rem] block px-[0.25rem] text-[1.375rem] font-bold leading-[1.25] text-[var(--lb-text-primary)]">
            选择界面主题
          </Text>
          <Text className="mb-[1rem] block px-[0.25rem] text-[0.9375rem] leading-[1.5] text-[var(--lb-text-secondary)]">
            切换后立即生效，并会记住你的选择
          </Text>
          <ThemePicker />
        </View>
      </View>
    </PageShell>
  );
}
