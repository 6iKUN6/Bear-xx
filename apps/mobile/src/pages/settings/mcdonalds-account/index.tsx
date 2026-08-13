import { useState } from "react";
import { Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import {
  bindMcDonaldsCredential,
  getMcDonaldsCredential,
  unbindMcDonaldsCredential,
  type McDonaldsCredential,
} from "../../../api/mcdonaldsCredential";
import NavBar from "../../../components/NavBar";
import PageShell from "../../../components/PageShell";
import {
  appGlassCardClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appScreenClass,
} from "../../../utils/style";
import "./index.scss";

/** 用户绑定和管理自己的麦当劳 MCP Token。 */
export default function McdonaldsAccountSettingsPage() {
  const [credential, setCredential] = useState<McDonaldsCredential | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [unbindSubmitting, setUnbindSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCredential = async () => {
    setLoading(true);
    setError(null);
    try {
      setCredential(await getMcDonaldsCredential());
    } catch (requestError) {
      setError(toDisplayError(requestError, "账号状态加载失败"));
    } finally {
      setLoading(false);
    }
  };

  useDidShow(() => {
    void loadCredential();
  });

  const handleBind = async () => {
    const normalizedToken = token.trim();
    if (!normalizedToken || submitting) {
      if (!normalizedToken) {
        setError("请输入麦当劳 MCP Token");
      }
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const next = await bindMcDonaldsCredential(normalizedToken);
      setCredential(next);
      setToken("");
      void Taro.showToast({ title: "账号已绑定", icon: "success" });
    } catch (requestError) {
      setError(toDisplayError(requestError, "账号绑定失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnbind = () => {
    if (unbindSubmitting || !credential) {
      return;
    }

    void Taro.showModal({
      title: "解绑麦当劳账号",
      content: "解绑后历史订单仍可查看，但不能继续下单、刷新状态或打开支付入口。",
      confirmText: "确认解绑",
      confirmColor: "#C45151",
      success: async (result) => {
        if (!result.confirm) {
          return;
        }
        setUnbindSubmitting(true);
        setError(null);
        try {
          await unbindMcDonaldsCredential();
          setCredential(null);
          setToken("");
          void Taro.showToast({ title: "已解绑", icon: "success" });
        } catch (requestError) {
          setError(toDisplayError(requestError, "账号解绑失败"));
        } finally {
          setUnbindSubmitting(false);
        }
      },
    });
  };

  const isBound = Boolean(credential);
  const canSubmit = token.trim().length > 0 && !submitting;

  return (
    <PageShell>
      <NavBar title="麦当劳账号" showBack capsule="hidden" />
      <View className={appScreenClass}>
        <View className="px-[1rem] pb-[1.5rem] pt-[0.875rem]">
          <View className={`${appGlassCardStrongClass} overflow-hidden`}>
            <View className="bg-[#d7282f] px-[1.125rem] py-[1rem]">
              <View className="flex items-center gap-[0.75rem]">
                <View className="flex h-[2.75rem] w-[2.75rem] items-center justify-center rounded-[var(--lb-radius-sm)] bg-[#ffd928] font-serif text-[1.625rem] font-bold leading-none text-[#d7282f]">
                  <Text>M</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="block text-[1rem] font-semibold leading-[1.3] text-white">
                    麦当劳 MCP
                  </Text>
                  <Text className="mt-[0.1875rem] block text-[0.75rem] leading-[1.4] text-white/80">
                    仅使用你自己绑定的账号完成点餐
                  </Text>
                </View>
              </View>
            </View>

            <View className="px-[1.125rem] py-[1rem]">
              {loading ? (
                <View className="flex min-h-[5rem] items-center justify-center gap-[0.625rem]">
                  <View className="mcd-account-spinner" />
                  <Text className="text-[0.8125rem] leading-[1.4] text-[var(--lb-text-muted)]">
                    正在读取账号状态
                  </Text>
                </View>
              ) : isBound ? (
                <View className="flex items-center gap-[0.75rem]">
                  <View className="flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[var(--lb-radius-sm)] bg-[var(--lb-success-soft)] text-[var(--lb-success)]">
                    <Text className="at-icon at-icon-check-circle text-[1.25rem] leading-none [&::before]:block" />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="block text-[0.9375rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
                      已绑定
                    </Text>
                    <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.4] text-[var(--lb-text-secondary)]">
                      {credential?.hint}
                    </Text>
                  </View>
                  <View className="rounded-[var(--lb-radius-xs)] bg-[var(--lb-success-soft)] px-[0.5rem] py-[0.25rem]">
                    <Text className="text-[0.6875rem] font-semibold leading-none text-[var(--lb-success)]">
                      可用
                    </Text>
                  </View>
                </View>
              ) : (
                <View className="flex items-center gap-[0.75rem]">
                  <View className="flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[var(--lb-radius-sm)] bg-[var(--lb-warning-soft)] text-[var(--lb-warning)]">
                    <Text className="at-icon at-icon-alert-circle text-[1.25rem] leading-none [&::before]:block" />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="block text-[0.9375rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
                      尚未绑定
                    </Text>
                    <Text className="mt-[0.125rem] block text-[0.75rem] leading-[1.4] text-[var(--lb-text-secondary)]">
                      绑定后才会在聊天中启用点餐能力
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </View>

          <View className="mt-[1rem]">
            <Text className="mb-[0.625rem] block px-[0.25rem] text-[0.875rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
              {isBound ? "替换账号" : "绑定账号"}
            </Text>
            <View className={`${appGlassCardClass} p-[0.875rem]`}>
              <View className="flex min-h-[3.25rem] items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface-muted)] px-[0.875rem]">
                <Input
                  className="h-full min-w-0 flex-1 text-[0.875rem] text-[var(--lb-text-primary)]"
                  maxlength={4096}
                  password
                  placeholder="粘贴麦当劳 MCP Token"
                  placeholderClass="text-[var(--lb-text-muted)]"
                  type="text"
                  value={token}
                  onInput={(event) => {
                    setToken(event.detail.value);
                    if (error) {
                      setError(null);
                    }
                  }}
                />
              </View>
              <Text className="mt-[0.625rem] block text-[0.75rem] leading-[1.5] text-[var(--lb-text-muted)]">
                Token 仅用于本次验证和服务端加密保存，不会显示在聊天记录或订单中。
              </Text>
              {error ? (
                <Text className="mt-[0.5rem] block text-[0.75rem] leading-[1.4] text-[var(--lb-danger)]">
                  {error}
                </Text>
              ) : null}
              <View
                className={`mt-[0.875rem] flex min-h-[2.875rem] items-center justify-center rounded-[var(--lb-radius-sm)] ${canSubmit ? appGradientSurfaceClass : "bg-[var(--lb-surface-hover)]"} ${submitting ? "opacity-75" : ""}`}
                onClick={() => void handleBind()}
              >
                <Text className={`text-[0.875rem] font-semibold leading-none ${canSubmit ? "text-[var(--lb-on-accent)]" : "text-[var(--lb-text-muted)]"}`}>
                  {submitting ? "正在验证并绑定" : isBound ? "验证并替换 Token" : "验证并绑定 Token"}
                </Text>
              </View>
            </View>
          </View>

          {isBound ? (
            <View className="mt-[0.75rem]">
              <View
                className={`${appGlassCardClass} flex min-h-[3.125rem] items-center justify-center rounded-[var(--lb-radius-sm)] border-[var(--lb-danger-soft)] bg-[var(--lb-danger-soft)] ${unbindSubmitting ? "opacity-60" : ""}`}
                onClick={handleUnbind}
              >
                <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-danger)]">
                  {unbindSubmitting ? "正在解绑" : "解绑当前账号"}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </PageShell>
  );
}

function toDisplayError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 48)
    : fallback;
}
