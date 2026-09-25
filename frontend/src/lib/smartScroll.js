import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Chat-style smart scrolling for a growing list (Live Meeting host + viewer).
//
//  - New content while the reader is at/near the bottom  -> follow it to the newest line.
//  - Reader scrolled up to reread                        -> never move them; offer "Jump to latest" instead.
//  - Back at the bottom (by scrolling or Jump to latest) -> following resumes.
//
// It scrolls the list's REAL scroll container (the nearest ancestor with overflow-y auto/scroll, found from the
// anchor element) - never the window/document - so it works inside the Meeting Chat panel and the viewer page alike.

const NEAR_BOTTOM_PX = 80;

function findScrollParent(element) {
  for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

// anchorRef: any element rendered INSIDE the list (e.g. its end marker). changeKey: changes whenever content grows.
// enabled: true while the list is mounted/visible (the hook re-attaches when this flips).
export function useSmartScroll(anchorRef, changeKey, enabled = true) {
  const [showJump, setShowJump] = useState(false);
  const containerRef = useRef(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (!enabled) return undefined;
    const container = findScrollParent(anchorRef.current);
    containerRef.current = container;
    if (!container) return undefined;
    const onScroll = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight <= NEAR_BOTTOM_PX;
      atBottomRef.current = near;
      if (near) setShowJump(false);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    atBottomRef.current = true;
    return () => container.removeEventListener('scroll', onScroll);
  }, [anchorRef, enabled]);

  // Runs after the new content is in the DOM but before paint, so following the bottom never flickers.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    if (atBottomRef.current) container.scrollTop = container.scrollHeight;
    else setShowJump(true);
  }, [changeKey, enabled]);

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    atBottomRef.current = true;
    setShowJump(false);
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, []);

  return { showJump, jumpToLatest };
}
