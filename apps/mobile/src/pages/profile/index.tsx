import { View, Text, Image } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { themes } from "@litter-bear/theme";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import AppIcon from "../../components/AppIcon";
import type { AppIconName } from "../../components/AppIcon";
import { useUserStore } from "../../store/userStore";
import { useChatStore } from "../../store/chatStore";
import { useAgentStore } from "../../store/agentStore";
import { useThemeStore } from "../../store/themeStore";
import { STORAGE_KEYS } from "../../utils/constants";
import * as storage from "../../utils/storage";
import { appScreenClass } from "../../utils/style";

/** 设置行右侧的箭头 */
function RowChevron() {
  return (
    <AppIcon
      name="chevronRight"
      className="h-[0.875rem] w-[0.875rem] shrink-0 text-[var(--lb-text-muted)]"
    />
  );
}

interface SettingRowProps {
  /** 图标瓷贴配色（accent/info/warning/danger 软色对） */
  tileClass: string;
  /** 图标名（AppIcon 闭集） */
  icon: AppIconName;
  label: string;
  description?: string;
  /** 右侧值文案（如当前主题名）；不传则只显示箭头 */
  value?: string;
  /** danger 行：标签用危险色、不显示箭头 */
  danger?: boolean;
  /** 无跳转目标的纯展示行：不显示箭头、无点击态 */
  staticRow?: boolean;
  onClick?: () => void;
}

/** 设置分组卡片里的一行（图标瓷贴 + 标签 + 值/箭头） */
function SettingRow({
  icon,
  tileClass,
  label,
  description,
  value,
  danger = false,
  staticRow = false,
  onClick,
}: SettingRowProps) {
  return (
    <View
      className={`box-border flex min-h-[3.25rem] w-full items-center gap-[0.75rem] px-[0.875rem] py-[0.75rem] ${
        staticRow ? "" : "active:bg-[var(--lb-surface-hover)]"
      }`}
      onClick={onClick}
    >
      <View
        className={`flex h-[1.875rem] w-[1.875rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] ${tileClass}`}
      >
        <AppIcon name={icon} className="h-[1rem] w-[1rem]" />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          className={`block text-[0.875rem] leading-[1.4] ${
            danger
              ? "text-[var(--lb-danger)]"
              : "text-[var(--lb-text-primary)]"
          }`}
        >
          {label}
        </Text>
        {description ? (
          <Text className="mt-[0.125rem] block text-[0.6875rem] leading-[1.4] text-[var(--lb-text-muted)]">
            {description}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text className="max-w-[8rem] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]">
          {value}
        </Text>
      ) : null}
      {staticRow || danger ? null : <RowChevron />}
    </View>
  );
}

const cardClass =
  "overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-card)]";
const sectionClass = "mx-[0.875rem] mb-[0.875rem]";
const sectionTitleClass =
  "block px-[0.375rem] pb-[0.5rem] pt-[0.25rem] text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]";
const hairlineClass = "h-[0.0625rem] bg-[var(--lb-line-soft)]";

export default function ProfilePage() {
  const { userInfo, isLoggedIn, logout } = useUserStore();
  const refreshProfile = useUserStore((state) => state.refreshProfile);
  const conversations = useChatStore((state) => state.conversations);
  const agents = useAgentStore((state) => state.agents);
  const ensureAgents = useAgentStore((state) => state.ensureAgents);
  const themeId = useThemeStore((state) => state.themeId);
  const currentThemeName =
    themes.find((theme) => theme.id === themeId)?.name ?? "默认主题";

  useDidShow(() => {
    void refreshProfile();
    void ensureAgents();
  });

  const handleOpenTheme = () => {
    Taro.navigateTo({ url: "/pages/settings/theme/index" });
  };

  const handleOpenOrders = () => {
    Taro.navigateTo({ url: "/pages/orders/index" });
  };

  const handleOpenMcDonaldsAccount = () => {
    Taro.navigateTo({ url: "/pages/settings/mcdonalds-account/index" });
  };

  const handleLoginOrLogout = () => {
    if (isLoggedIn) {
      Taro.showModal({
        title: "提示",
        content: "确定退出登录吗？",
        success(res) {
          if (res.confirm) {
            logout();
          }
        },
      });
      return;
    }

    Taro.redirectTo({ url: "/pages/login/index" });
  };

  const handleClearChat = () => {
    Taro.showModal({
      title: "提示",
      content: "确定清除所有聊天记录吗？此操作不可恢复。",
      success(res) {
        if (res.confirm) {
          storage.remove(STORAGE_KEYS.CONVERSATIONS);
          useChatStore.setState({
            conversations: [],
            currentConversation: null,
          });
          Taro.showToast({ title: "已清除", icon: "success" });
        }
      },
    });
  };

  const stats = [
    { value: String(conversations.length), label: "累计会话" },
    { value: String(agents.length), label: "可用智能体" },
  ];

  return (
    <PageShell>
      <NavBar title="设置" showBack variant="ghost" capsule="hidden" />
      <View className={appScreenClass}>
        {/* 身份卡 */}
        <View className={`${sectionClass} mt-[0.875rem]`}>
          <View
            className={`${cardClass} flex items-center gap-[0.875rem] p-[1rem]`}
          >
            {userInfo?.avatarUrl ? (
              <Image
                className="h-[3.25rem] w-[3.25rem] shrink-0 rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] box-border"
                src={userInfo.avatarUrl}
                mode="aspectFill"
              />
            ) : (
              <View className="flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-md)] bg-[var(--lb-accent-soft)]">
                <Text className="text-[1.25rem] font-semibold leading-none text-[var(--lb-accent-ink)]">
                  {isLoggedIn
                    ? (userInfo?.nickname || "我").slice(0, 1)
                    : "我"}
                </Text>
              </View>
            )}
            <View className="min-w-0 flex-1">
              <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[1.0625rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                {isLoggedIn ? userInfo?.nickname || "办伴用户" : "未登录"}
              </Text>
              {isLoggedIn && (
                <View className="mt-[0.375rem] inline-flex rounded-full bg-[var(--lb-accent-soft)] px-[0.625rem] py-[0.1875rem]">
                  <Text className="text-[0.6875rem] font-semibold leading-[1.4] text-[var(--lb-accent-ink)]">
                    {userInfo?.effectiveMembershipTier ?? "FREE"} 会员
                    {userInfo?.membershipExpired ? " · 已到期" : ""}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* 个性化 */}
        <View className={sectionClass}>
          <Text className={sectionTitleClass}>个性化</Text>
          <View className={cardClass}>
            <SettingRow
              icon="palette"
              tileClass="bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
              label="界面主题"
              value={currentThemeName}
              onClick={handleOpenTheme}
            />
          </View>
        </View>

        {isLoggedIn && (
          <>
            {/* 使用概览 */}
            <View className={sectionClass}>
              <Text className={sectionTitleClass}>使用概览</Text>
              <View className="grid grid-cols-2 gap-[0.625rem]">
                {stats.map((item) => (
                  <View
                    key={item.label}
                    className={`${cardClass} px-[0.875rem] py-[0.75rem]`}
                  >
                    <Text className="block text-[1.125rem] font-semibold leading-[1.3] tabular-nums text-[var(--lb-text-primary)]">
                      {item.value}
                    </Text>
                    <Text className="mt-[0.125rem] block text-[0.6875rem] leading-[1.4] text-[var(--lb-text-muted)]">
                      {item.label}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* 服务 */}
            <View className={sectionClass}>
              <Text className={sectionTitleClass}>服务</Text>
              <View className={cardClass}>
                <SettingRow
                  icon="shoppingBag"
                  tileClass="bg-[var(--lb-info-soft)] text-[var(--lb-info)]"
                  label="我的订单"
                  description="查看麦当劳订单与履约状态"
                  onClick={handleOpenOrders}
                />
                <View className={hairlineClass} />
                <SettingRow
                  icon="link"
                  tileClass="bg-[var(--lb-warning-soft)] text-[var(--lb-warning)]"
                  label="麦当劳账号"
                  description="管理点餐使用的 MCP Token"
                  onClick={handleOpenMcDonaldsAccount}
                />
              </View>
            </View>

            {/* 数据 */}
            <View className={sectionClass}>
              <Text className={sectionTitleClass}>数据</Text>
              <View className={cardClass}>
                <SettingRow
                  icon="broom"
                  tileClass="bg-[var(--lb-info-soft)] text-[var(--lb-info)]"
                  label="清除聊天记录"
                  onClick={handleClearChat}
                />
                <View className={hairlineClass} />
                <SettingRow
                  icon="shield"
                  tileClass="bg-[var(--lb-info-soft)] text-[var(--lb-info)]"
                  label="隐私与数据"
                  description="Token 与会话仅保存在本机"
                  staticRow
                />
                <View className={hairlineClass} />
                <SettingRow
                  icon="logout"
                  tileClass="bg-[var(--lb-danger-soft)] text-[var(--lb-danger)]"
                  label="退出登录"
                  danger
                  onClick={handleLoginOrLogout}
                />
              </View>
            </View>
          </>
        )}

        {!isLoggedIn && (
          <View className={sectionClass}>
            <View className={cardClass}>
              <SettingRow
                icon="login"
                tileClass="bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
                label="立即登录"
                onClick={handleLoginOrLogout}
              />
            </View>
          </View>
        )}

        <View className="pb-[1.25rem] pt-[0.75rem] text-center">
          <Text className="block text-[0.6875rem] leading-[1.5] text-[var(--lb-text-muted)]">
            办伴 Banban v1.0.0 · AI 协作执行工作台
          </Text>
        </View>
      </View>
    </PageShell>
  );
}
