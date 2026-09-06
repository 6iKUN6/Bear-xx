import { Text, View } from "@tarojs/components";
import { themes, type ThemeDefinition } from "@litter-bear/theme";
import AppIcon from "../AppIcon";
import { useThemeStore } from "../../store/themeStore";

export default function ThemePicker() {
  const themeId = useThemeStore((state) => state.themeId);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <View className="grid grid-cols-2 gap-[0.625rem]">
      {themes.map((theme) => (
        <ThemeOption
          key={theme.id}
          theme={theme}
          selected={theme.id === themeId}
          onSelect={() => setTheme(theme.id)}
        />
      ))}
    </View>
  );
}

function ThemeOption({
  theme,
  selected,
  onSelect,
}: {
  theme: ThemeDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <View
      className={`box-border flex min-h-[5.5rem] flex-col gap-[0.5rem] rounded-[var(--lb-radius-md)] border bg-[var(--lb-surface)] p-[0.875rem] text-left transition-colors active:scale-[0.98] ${
        selected
          ? "border-[var(--lb-accent)] shadow-[0_0_0_0.0625rem_var(--lb-accent)]"
          : "border-[var(--lb-line-soft)]"
      }`}
      onClick={onSelect}
    >
      <View className="flex min-w-0 items-center gap-[0.375rem]">
        <Text
          className={`flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] text-[0.6875rem] font-bold leading-none ${
            selected
              ? "bg-[var(--lb-accent)] text-[var(--lb-on-accent)]"
              : "bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
          }`}
        >
          {theme.shortName}
        </Text>
        <Text className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
          {theme.name}
        </Text>
        {selected ? (
          <AppIcon name="check" className="ml-auto h-[0.875rem] w-[0.875rem] shrink-0 text-[var(--lb-accent)]" />
        ) : null}
      </View>

      <View className="flex items-center gap-[0.25rem]">
        {theme.swatches.map((color) => (
          <View
            key={color}
            className="h-[0.5rem] w-[1.25rem] rounded-full"
            style={{ backgroundColor: color }}
          />
        ))}
      </View>

      <Text className="block text-[0.6875rem] leading-[1.5] text-[var(--lb-text-muted)]">
        {theme.description}
      </Text>
    </View>
  );
}
