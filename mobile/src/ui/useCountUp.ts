// Shows a rising balance counting up to its new value (deposit arrival); decreases, the first value and reduced motion
// jump straight to the value. Driven per animation frame; the arithmetic is countUpAt (bigint, exact last frame).
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import { COUNT_UP_MS, countUpAt } from "./countUp";

export function useCountUp(value: bigint | undefined): bigint | undefined {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (value === undefined || from === undefined || value <= from || reduced) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = Date.now();
    const step = () => {
      const t = Date.now() - start;
      setShown(countUpAt(from, value, t));
      if (t < COUNT_UP_MS) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return shown;
}
