import { useCallback, useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";

const PROGRAMMATIC_SCROLL_LOCK_MS = 700;
/**
 * 首屏直达落位后开启滚动动画的延时
 * @description 必须等首屏那次无动画命令发出后再开，否则同批渲染里开动画会把
 * 首屏直达也带上动画，等于没关。
 */
const FIRST_SCROLL_ANIMATION_DELAY_MS = 80;
/**
 * 换会话后补发滚动的时点
 * @description 内容分批布局完成，单次命令会落在半途。两次覆盖「首屏文本」与
 * 「较慢的 markdown / 图片」，再多收益递减。
 */
const CONVERSATION_SETTLE_DELAYS_MS = [120, 400];

interface ScrollDetail {
  deltaY?: number;
  isDrag?: boolean;
  scrollTop: number;
  scrollHeight: number;
}

interface ScrollEvent {
  detail: ScrollDetail;
}

interface UseAutoScrollToBottomOptions {
  enabled?: boolean;
  /** 内容信号：消息内容、状态、trace 展开等变化时触发一次「跟随底部」检查 */
  scrollSignal: string | number;
  /**
   * 消息条数
   * @description 条数变化（发出/收到新消息）时无条件贴底——这是用户明确发起的
   * 新内容；内容信号只在用户本来就贴着底时跟随，trace 展开这类操作不会把人拽走。
   */
  messageCount: number;
  isStreaming?: boolean;
  containerId?: string;
  bottomThreshold?: number;
  throttleMs?: number;
  /**
   * 首屏重置标识（通常传会话 id）
   * @description 变化时把「下一次滚动」重新当作首屏：无动画直达底部。
   * 组件在会话间复用实例，不重置就只有首次挂载能享受直达。
   */
  resetKey?: string;
}

/**
 * 管理聊天列表自动滚动到底部
 * @param enabled 是否启用自动滚动
 * @param scrollSignal 触发滚动检查的外部信号，通常由消息内容、状态和事件数量拼接生成
 * @param messageCount 消息条数，条数增长时无条件贴底
 * @param isStreaming 当前是否处于流式输出中
 * @param containerId ScrollView 容器节点 ID
 * @param bottomThreshold 距离底部多少像素以内视为仍在底部
 * @param throttleMs 自动滚动节流间隔
 * @returns 返回 ScrollView 需要绑定的 scrollTop、事件处理函数、底部状态和回到底部动作
 * @description 用受控 scrollTop 驱动滚动：它是幂等属性，值不变时重渲染不会重新
 * 滚动，天然免疫「页面任意重渲染把列表拽走」这类问题（scroll-into-view 不具备
 * 这个性质：置空会被 weapp 当成无效目标复位到顶部，置值又会被重渲染反复应用）。
 * 相邻两次命令用 ±1 交替保证值必定变化、必定重新生效。是否贴底由用户是否主动
 * 上滑决定。
 */
export function useAutoScrollToBottom({
  enabled = true,
  scrollSignal,
  messageCount,
  isStreaming = false,
  containerId = "chat-message-scroll",
  bottomThreshold = 96,
  throttleMs = 120,
  resetKey,
}: UseAutoScrollToBottomOptions) {
  // 受控滚动目标。undefined 表示尚未发出任何命令，ScrollView 处于自由状态。
  const [scrollTop, setScrollTop] = useState<number>();
  // 当前视口是否处于底部附近，用于控制“回到底部”按钮是否展示。
  const [isAtBottom, setIsAtBottom] = useState(true);
  // ScrollView 可视区域高度，Taro 的 onScroll 不直接提供该值，需要单独测量。
  const viewportHeightRef = useRef(0);
  // 最近一次滚动事件中的内容总高度，保留给调试和后续扩展使用。
  const lastScrollHeightRef = useRef(0);
  // 最近一次滚动事件中的 scrollTop，保留给调试和后续扩展使用。
  const lastScrollTopRef = useRef(0);
  // 是否允许新消息或流式增量触发自动滚动；用户离开底部后会关闭。
  const autoScrollEnabledRef = useRef(true);
  // 最近一次主动触发滚动命令的时间，用于节流自动滚动。
  const lastScrollAtRef = useRef(0);
  // 程序触发滚动后的保护窗口，在窗口内忽略中间态 onScroll 误判。
  const programmaticScrollUntilRef = useRef(0);
  // 用户是否已经表达“我要自己看历史消息”的滚动意图。
  const userScrollIntentRef = useRef(false);
  // 用户当前是否正在触摸或拖动滚动区域。
  const userInteractingRef = useRef(false);
  // 最近一次计算出的底部状态，供 touch end 这类非 scroll 事件读取。
  const lastIsAtBottomRef = useRef(true);
  // 自动滚动节流定时器。
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 相邻命令的 ±1 交替位：内容高度没变时保证 scrollTop 值仍然变化。
  const commandParityRef = useRef(false);
  // 首屏是否已经落位。首屏要求无动画直达底部，之后的流式增量才开启平滑滚动。
  const firstScrollSettledRef = useRef(false);
  // 传给 ScrollView 的 scroll-with-animation；首屏为 false。
  const [scrollWithAnimation, setScrollWithAnimation] = useState(false);

  /**
   * 测量 ScrollView 可视区域高度
   * @returns 无返回值
   * @description onScroll 只提供 scrollTop 和 scrollHeight，判断距离底部时需要额外记录容器高度。
   */
  const measureViewport = useCallback(() => {
    Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select(`#${containerId}`)
        .boundingClientRect((rect) => {
          if (rect && !Array.isArray(rect) && rect.height) {
            viewportHeightRef.current = rect.height;
          }
        })
        .exec();
    });
  }, [containerId]);

  /**
   * 触发一次滚动到底部
   * @returns 无返回值
   * @description 测量内容容器的高度作为滚动目标（设得比最大滚动位置大，weapp 会
   * 自行收敛到底部），并用 ±1 交替保证相邻命令的值必定不同——scrollTop 是幂等
   * 受控属性，值不变时 weapp 不会重新滚动。
   */
  const scrollToBottom = useCallback(() => {
    Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select(`#${containerId}-content`)
        .boundingClientRect((rect) => {
          const contentHeight =
            rect && !Array.isArray(rect) ? rect.height : undefined;
          if (typeof contentHeight !== "number" || contentHeight <= 0) {
            return;
          }

          commandParityRef.current = !commandParityRef.current;
          setScrollTop(contentHeight + (commandParityRef.current ? 1 : 0));
          lastScrollAtRef.current = Date.now();
          programmaticScrollUntilRef.current =
            Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS;

          // 首屏那次命令已经发出，之后再开动画。不能紧跟 setScrollTop：
          // 同一批渲染里开动画，首屏这次滚动就会被带上动画。
          if (!firstScrollSettledRef.current) {
            firstScrollSettledRef.current = true;
            setTimeout(
              () => setScrollWithAnimation(true),
              FIRST_SCROLL_ANIMATION_DELAY_MS,
            );
          }
        })
        .exec();
    });
  }, [containerId]);

  /**
   * 更新底部状态
   * @param nextIsAtBottom 下一次底部状态
   * @returns 无返回值
   * @description 集中同步 React 状态和 ref 状态，避免“按钮展示”和“是否允许自动滚动”出现不一致。
   */
  const updateBottomState = useCallback((nextIsAtBottom: boolean) => {
    lastIsAtBottomRef.current = nextIsAtBottom;
    autoScrollEnabledRef.current = nextIsAtBottom;
    setIsAtBottom((current) =>
      current === nextIsAtBottom ? current : nextIsAtBottom,
    );

    if (nextIsAtBottom) {
      userScrollIntentRef.current = false;
    }
  }, []);

  /**
   * 调度滚动到底部
   * @param force 是否强制滚动到底部
   * @returns 无返回值
   * @description 根据用户是否离开底部和节流时间决定是否立即触发滚动命令。
   */
  const scheduleScrollToBottom = useCallback(
    (force = false) => {
      if (!enabled) {
        return;
      }

      if (
        !force &&
        (!autoScrollEnabledRef.current || userInteractingRef.current)
      ) {
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const elapsed = Date.now() - lastScrollAtRef.current;
      if (force || elapsed >= throttleMs) {
        scrollToBottom();
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        scrollToBottom();
      }, throttleMs - elapsed);
    },
    [enabled, scrollToBottom, throttleMs],
  );

  /**
   * 处理 ScrollView 滚动事件
   * @param event ScrollView 滚动事件
   * @returns 无返回值
   * @description 计算当前距离底部的距离，判断是否展示“回到底部”按钮，并决定后续流式内容是否继续自动贴底。
   */
  const handleScroll = useCallback(
    (event: ScrollEvent) => {
      const viewportHeight = viewportHeightRef.current;

      if (!viewportHeight) {
        measureViewport();
        return;
      }

      const { scrollTop: currentScrollTop, scrollHeight } = event.detail;
      lastScrollTopRef.current = currentScrollTop;
      lastScrollHeightRef.current = scrollHeight;
      const distanceToBottom = Math.max(
        0,
        scrollHeight - currentScrollTop - viewportHeight,
      );
      const nextIsAtBottom = distanceToBottom <= bottomThreshold;
      const isProgrammaticScroll =
        Date.now() < programmaticScrollUntilRef.current;
      const hasUserIntent =
        event.detail.isDrag ||
        userInteractingRef.current ||
        userScrollIntentRef.current;

      if (isProgrammaticScroll && !hasUserIntent) {
        if (nextIsAtBottom) {
          updateBottomState(true);
        }
        return;
      }

      updateBottomState(nextIsAtBottom);
    },
    [bottomThreshold, measureViewport, updateBottomState],
  );

  /**
   * 处理用户开始触摸滚动区域
   * @returns 无返回值
   * @description 只标记用户正在交互并取消待执行的自动滚动，不直接关闭自动贴底，避免轻触导致状态误判。
   */
  const handleUserScrollStart = useCallback(() => {
    userInteractingRef.current = true;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * 处理用户拖动滚动区域
   * @returns 无返回值
   * @description 用户真正拖动时才认为其有查看历史消息的意图，并暂停后续自动贴底。
   */
  const handleUserScrollMove = useCallback(() => {
    userInteractingRef.current = true;
    userScrollIntentRef.current = true;

    autoScrollEnabledRef.current = false;
  }, []);

  /**
   * 处理用户结束触摸或拖动
   * @returns 无返回值
   * @description 如果结束时已经回到底部，则恢复自动贴底状态；否则保持暂停并展示回到底部按钮。
   */
  const handleUserScrollEnd = useCallback(() => {
    userInteractingRef.current = false;

    if (lastIsAtBottomRef.current) {
      autoScrollEnabledRef.current = true;
      userScrollIntentRef.current = false;
      setIsAtBottom(true);
    }
  }, []);

  /**
   * 处理 ScrollView 触底事件
   * @returns 无返回值
   * @description 当平台明确通知已经滚到底部时，直接恢复底部状态和自动贴底能力。
   */
  const handleScrollToLower = useCallback(() => {
    updateBottomState(true);
  }, [updateBottomState]);

  /**
   * 恢复自动贴底并滚动到底部
   * @returns 无返回值
   * @description 点击“回到底部”按钮时调用，重置用户滚动意图并强制触发一次底部滚动。
   */
  const restoreAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    userInteractingRef.current = false;
    lastIsAtBottomRef.current = true;
    setIsAtBottom(true);
    scheduleScrollToBottom(true);
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    measureViewport();
  }, [measureViewport]);

  // 始终持有最新的调度函数：下面换会话的补发是在定时器里跑的，
  // 闭包捕获会取到旧的 enabled（切会话那一刻可能列表还是空的）。
  const scheduleScrollRef = useRef(scheduleScrollToBottom);
  useEffect(() => {
    scheduleScrollRef.current = scheduleScrollToBottom;
  }, [scheduleScrollToBottom]);

  // 换会话：列表整体换了内容，重新按首屏处理——无动画直达底部，
  // 否则会看到从上一个会话位置一路滚下来的过程。
  useEffect(() => {
    firstScrollSettledRef.current = false;
    setScrollWithAnimation(false);
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    lastIsAtBottomRef.current = true;
    setIsAtBottom(true);

    // 只发一次滚动命令会停在半路：切过来的瞬间 markdown、trace 卡、图片都还没
    // 布局完，内容高度还在长。补发几次，±1 交替保证命令必定重新生效。
    // 补发刻意不用 force：上面刚把 autoScrollEnabled 置回 true，正常情况照样触发；
    // 但用户如果在这几百毫秒里已经上滑去看历史，force 会把人硬拽回底部。
    const timers = CONVERSATION_SETTLE_DELAYS_MS.map((delay) =>
      setTimeout(() => scheduleScrollRef.current(false), delay),
    );

    return () => timers.forEach(clearTimeout);
  }, [resetKey]);

  // 内容信号变化（流式增量、trace 展开、图片载入）：只在用户贴着底时跟随，
  // 不 force——用户上滑看历史时展开一条 trace 不该把人拽回底部。
  useEffect(() => {
    if (!enabled) {
      return;
    }

    scheduleScrollToBottom(false);
  }, [enabled, isStreaming, scheduleScrollToBottom, scrollSignal]);

  // 消息条数变化（发出/收到新消息）：无条件贴底，这是用户发起的新内容。
  const prevMessageCountRef = useRef(messageCount);
  useEffect(() => {
    if (prevMessageCountRef.current === messageCount) {
      return;
    }
    prevMessageCountRef.current = messageCount;

    if (enabled) {
      scheduleScrollToBottom(true);
    }
  }, [enabled, messageCount, scheduleScrollToBottom]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    containerId,
    contentId: `${containerId}-content`,
    handleScroll,
    handleScrollToLower,
    handleUserScrollEnd,
    handleUserScrollMove,
    handleUserScrollStart,
    isAtBottom,
    restoreAutoScroll,
    scrollTop,
    scrollWithAnimation,
    showScrollToBottom: enabled && !isAtBottom,
  };
}
