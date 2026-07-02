import { useCallback, useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";

const BOTTOM_ELEMENT_ID = "bottomEl";
const PROGRAMMATIC_SCROLL_LOCK_MS = 700;
const SCROLL_INTO_VIEW_RESET_MS = 80;

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
  scrollSignal: string | number;
  isStreaming?: boolean;
  containerId?: string;
  bottomElementId?: string;
  bottomThreshold?: number;
  throttleMs?: number;
}

/**
 * 管理聊天列表自动滚动到底部
 * @param enabled 是否启用自动滚动
 * @param scrollSignal 触发滚动检查的外部信号，通常由消息内容、状态和事件数量拼接生成
 * @param isStreaming 当前是否处于流式输出中
 * @param containerId ScrollView 容器节点 ID
 * @param bottomElementId 底部锚点基础 ID
 * @param bottomThreshold 距离底部多少像素以内视为仍在底部
 * @param throttleMs 自动滚动节流间隔
 * @returns 返回 ScrollView 需要绑定的锚点、事件处理函数、底部状态和回到底部动作
 * @description 通过 scroll-into-view 驱动小程序和 H5 滚动到底，并根据用户是否主动上滑决定是否暂停流式自动贴底。
 */
export function useAutoScrollToBottom({
  enabled = true,
  scrollSignal,
  isStreaming = false,
  containerId = "chat-message-scroll",
  bottomElementId = BOTTOM_ELEMENT_ID,
  bottomThreshold = 96,
  throttleMs = 120,
}: UseAutoScrollToBottomOptions) {
  // 底部放两个零高度锚点，滚动时在两者间交替，保证 scroll-into-view
  // 每次都是有效且不同的 id；命令触发后会移除该 prop，避免后续 onScroll
  // 引起的重渲染反复把 ScrollView 拉回底部。这里不能清成空串，weapp 会
  // 把空串当作无效目标并可能复位到顶部。
  const bottomAnchorAId = `${bottomElementId}-a`;
  const bottomAnchorBId = `${bottomElementId}-b`;
  // 当前需要滚入可视区的底部锚点。undefined 表示没有正在执行的一次性滚动命令。
  const [scrollIntoView, setScrollIntoView] = useState<string>();
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
  // 最近一次主动触发 scroll-into-view 的时间，用于节流自动滚动命令。
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
  // scroll-into-view 一次性命令的重置定时器。
  const resetScrollIntoViewTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // 在两个底部锚点之间交替，保证每次滚动命令的目标值都会变化。
  const anchorToggleRef = useRef(false);
  // 当前滚动命令序号，用于避免较早的重置定时器清掉较新的滚动命令。
  const scrollCommandIdRef = useRef(0);

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
   * @description 通过交替设置底部锚点触发 scroll-into-view，并在短时间后移除命令，避免后续重渲染重复拉回底部。
   */
  const scrollToBottom = useCallback(() => {
    anchorToggleRef.current = !anchorToggleRef.current;
    const target = anchorToggleRef.current ? bottomAnchorAId : bottomAnchorBId;
    const commandId = scrollCommandIdRef.current + 1;

    scrollCommandIdRef.current = commandId;
    setScrollIntoView(target);
    lastScrollAtRef.current = Date.now();
    programmaticScrollUntilRef.current =
      Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS;

    if (resetScrollIntoViewTimerRef.current) {
      clearTimeout(resetScrollIntoViewTimerRef.current);
    }

    resetScrollIntoViewTimerRef.current = setTimeout(() => {
      if (scrollCommandIdRef.current === commandId) {
        setScrollIntoView(undefined);
      }

      resetScrollIntoViewTimerRef.current = null;
    }, SCROLL_INTO_VIEW_RESET_MS);
  }, [bottomAnchorAId, bottomAnchorBId]);

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
   * @description 根据用户是否离开底部和节流时间决定是否立即触发 scroll-into-view。
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

      const { scrollTop, scrollHeight } = event.detail;
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = scrollHeight;
      const distanceToBottom = Math.max(
        0,
        scrollHeight - scrollTop - viewportHeight,
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

  useEffect(() => {
    if (!enabled) {
      return;
    }

    scheduleScrollToBottom(!isStreaming);
  }, [enabled, isStreaming, scheduleScrollToBottom, scrollSignal]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      if (resetScrollIntoViewTimerRef.current) {
        clearTimeout(resetScrollIntoViewTimerRef.current);
      }
    };
  }, []);

  return {
    bottomAnchorAId,
    bottomAnchorBId,
    containerId,
    handleScroll,
    handleScrollToLower,
    handleUserScrollEnd,
    handleUserScrollMove,
    handleUserScrollStart,
    isAtBottom,
    restoreAutoScroll,
    scrollIntoView,
    showScrollToBottom: enabled && !isAtBottom,
  };
}
