import { useCallback, useEffect, useState } from 'react';
import { ArrowDown } from 'lucide-react';

// Scroll-to-latest button, shared by Translation Chat and Meeting Chat.
//
// Render it as a SIBLING of the scroll container, inside a `position: relative` wrapper (.scroll-pane): it floats over the
// wrapper's bottom edge, takes no layout space and pushes nothing. scrollRef is the element that actually scrolls (never the
// window). The button is shown only while the reader is more than AWAY_PX from the bottom, hides again at the bottom, and
// never moves the reader by itself - only a click scrolls (smoothly).
const AWAY_PX = 160;

export default function ScrollToLatest({ scrollRef, hidden = false }) {
  const [away, setAway] = useState(false);

  const update = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setAway(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > AWAY_PX);
  }, [scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    let frame = 0;
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); }); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Content growing or shrinking (messages loaded, a result added, a panel opened) changes the distance without a scroll event.
    const mutations = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    mutations?.observe(scroller, { childList: true, subtree: true, characterData: true });
    const sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    sizes?.observe(scroller);
    update();
    return () => {
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      mutations?.disconnect();
      sizes?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scrollRef, update]);

  if (!away || hidden) return null;
  const jump = () => { const scroller = scrollRef.current; if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); };
  return (
    <button type="button" className="scroll-latest" onClick={jump} aria-label="Scroll to latest" title="Scroll to latest"><ArrowDown size={16} /></button>
  );
}
