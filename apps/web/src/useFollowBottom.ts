import { useEffect, useRef, useState } from 'react';

/**
 * A scrolling list that follows new content only while the reader is at its bottom. Scroll up to read and it stays put,
 * `behind` turns true so a "new activity" button can offer the way back down. `grew` changes when content is added;
 * `resetKey` changes when the list shows something else (it then starts pinned to the bottom again).
 * (scrollIntoView was not used: it drags every scrollable ancestor along, on every update.)
 */
export function useFollowBottom<T extends HTMLElement>(grew: unknown, resetKey: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  /** When the list last scrolled itself, so that scroll event is not mistaken for the reader leaving the bottom. */
  const selfScrolled = useRef(0);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    pinned.current = true;
    setBehind(false);
  }, [resetKey]);
  // Block body on purpose: an effect must return a cleanup function or nothing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pinned.current) {
      selfScrolled.current = Date.now();
      el.scrollTop = el.scrollHeight;
    } else setBehind(true);
  }, [grew, resetKey]);

  const onScroll = () => {
    const el = ref.current;
    if (!el || Date.now() - selfScrolled.current < 150) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (pinned.current) setBehind(false);
  };
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setBehind(false);
    selfScrolled.current = Date.now();
    el.scrollTop = el.scrollHeight;
  };
  return { ref, onScroll, behind, jump };
}
