import { useCallback, useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";

const BOTTOM_ELEMENT_ID = "bottomEl";

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

export function useAutoScrollToBottom({
  enabled = true,
  scrollSignal,
  isStreaming = false,
  containerId = "chat-message-scroll",
  bottomElementId = BOTTOM_ELEMENT_ID,
  bottomThreshold = 96,
  throttleMs = 120,
}: UseAutoScrollToBottomOptions) {
  // 底部放两个零高度锚点，滚动时在两者间交替，保证 scroll-into-view 的值
  // 始终是「有效且不同」的 id，从而每次都能重新触发滚动，又永远不会出现空串
  // （空串会让 weapp 的 scroll-view 复位到顶部，正是之前弹回顶部的原因）。
  const bottomAnchorAId = `${bottomElementId}-a`;
  const bottomAnchorBId = `${bottomElementId}-b`;
  const [scrollIntoView, setScrollIntoView] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const viewportHeightRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const autoScrollEnabledRef = useRef(true);
  const lastScrollAtRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const userInteractingRef = useRef(false);
  const lastIsAtBottomRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorToggleRef = useRef(false);

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

  const scrollToBottom = useCallback(() => {
    // 交替选用两个底部锚点：属性值必然变化，触发一次滚动到底；不做任何「清空
    // 重置」，因此不会闪空串，也不会在流式/到底时把列表弹回顶部。
    anchorToggleRef.current = !anchorToggleRef.current;
    const target = anchorToggleRef.current ? bottomAnchorAId : bottomAnchorBId;
    setScrollIntoView(target);
    lastScrollAtRef.current = Date.now();
    programmaticScrollUntilRef.current = Date.now() + 600;
  }, [bottomAnchorAId, bottomAnchorBId]);

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
      const distanceToBottom = scrollHeight - scrollTop - viewportHeight;
      const nextIsAtBottom = distanceToBottom <= bottomThreshold;
      const isProgrammaticScroll =
        Date.now() < programmaticScrollUntilRef.current;
      const hasUserIntent =
        event.detail.isDrag ||
        userInteractingRef.current ||
        userScrollIntentRef.current ||
        (event.detail.deltaY ?? 0) < 0;

      if (!nextIsAtBottom && isProgrammaticScroll && !hasUserIntent) {
        return;
      }

      lastIsAtBottomRef.current = nextIsAtBottom;
      autoScrollEnabledRef.current = nextIsAtBottom;
      setIsAtBottom(nextIsAtBottom);

      if (nextIsAtBottom) {
        userScrollIntentRef.current = false;
      }
    },
    [bottomThreshold, measureViewport],
  );

  const handleUserScrollStart = useCallback(() => {
    userInteractingRef.current = true;
    userScrollIntentRef.current = true;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    autoScrollEnabledRef.current = false;
  }, []);

  const handleUserScrollEnd = useCallback(() => {
    userInteractingRef.current = false;

    if (lastIsAtBottomRef.current) {
      autoScrollEnabledRef.current = true;
      userScrollIntentRef.current = false;
      setIsAtBottom(true);
    }
  }, []);

  const handleScrollToLower = useCallback(() => {
    lastIsAtBottomRef.current = true;

    if (userInteractingRef.current) {
      setIsAtBottom(true);
      return;
    }

    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    setIsAtBottom(true);
  }, []);

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
    };
  }, []);

  return {
    bottomAnchorAId,
    bottomAnchorBId,
    containerId,
    handleScroll,
    handleScrollToLower,
    handleUserScrollEnd,
    handleUserScrollStart,
    isAtBottom,
    restoreAutoScroll,
    scrollIntoView,
    showScrollToBottom: enabled && !isAtBottom,
  };
}
