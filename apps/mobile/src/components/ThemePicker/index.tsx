import { Text, View } from "@tarojs/components";
import { themes, type ThemeDefinition } from "@litter-bear/theme";
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
      className={`relative box-border flex min-h-[5.75rem] flex-col justify-between rounded-[var(--lb-radius-md)] border px-[0.75rem] py-[0.75rem] transition-colors active:scale-[0.98] ${
        selected
          ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)]"
          : "border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"
      }`}
      onClick={onSelect}
    >
      <View className="flex min-w-0 items-start justify-between gap-[0.5rem]">
        <View className="flex min-w-0 items-center gap-[0.5rem]">
          <Text
            className={`flex h-[1.5rem] w-[1.5rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] text-[0.6875rem] font-bold leading-none ${
              selected
                ? "bg-[var(--lb-accent)] text-[var(--lb-on-accent)]"
                : "bg-[var(--lb-surface-hover)] text-[var(--lb-text-secondary)]"
            }`}
          >
            {theme.shortName}
          </Text>
          <Text className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
            {theme.name}
          </Text>
        </View>

        {selected ? (
          <Text className="at-icon at-icon-check shrink-0 text-[0.875rem] leading-none text-[var(--lb-accent-ink)] [&::before]:block" />
        ) : null}
      </View>

      <View className="mt-[0.75rem] flex items-center gap-[0.375rem]">
        {theme.swatches.map((color) => (
          <View
            key={color}
            className="h-[1rem] flex-1 rounded-[var(--lb-radius-xs)] border border-[var(--lb-line-soft)]"
            style={{ backgroundColor: color }}
          />
        ))}
      </View>
    </View>
  );
}
