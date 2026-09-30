import { useEffect, useState } from 'react';

/** `Date.now()`, refreshed once a minute: enough for "Tonight" to become "Today" and a countdown to stay honest. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
