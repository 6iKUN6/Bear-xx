import { View } from "@tarojs/components";

export default function PageBackdrop() {
  return (
    <>
      <View className="pointer-events-none absolute left-[-40px] top-8 z-0 h-48 w-48 rounded-full bg-[rgba(168,85,247,0.2)] blur-[40px]" />
      <View className="pointer-events-none absolute bottom-24 right-[-48px] z-0 h-56 w-56 rounded-full bg-[rgba(244,114,182,0.18)] blur-[40px]" />
    </>
  );
}
