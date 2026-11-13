import { useEffect, useRef, useState } from 'react';
import { EventStream, type StreamMessage } from '@ih/client';
import { api } from './api.ts';

/**
 * Subscribes to the daemon's live event stream. After a drop the daemon replays what was missed; when it cannot
 * (the gap was too long), the page reloads to show the truth.
 */
export function useEventStream(onEvent: (e: StreamMessage) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const stream = new EventStream(() => api.wsUrl('/ws'), (m) => handler.current(m), setConnected, () => location.reload());
    return () => stream.dispose();
  }, []);

  return connected;
}
