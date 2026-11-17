import { useEffect, useState } from 'react'

/** The whole seconds left before `until` (a time of `Date.now()`), drawn again as they pass; 0 once it is reached. The clock stops by itself then. */
export function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= until) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [until])
  return Math.max(0, Math.ceil((until - now) / 1000))
}
