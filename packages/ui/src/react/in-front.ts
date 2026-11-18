import { useEffect, useState } from "react";

const read = (): boolean => document.visibilityState !== "hidden" && document.hasFocus();

/**
 * Whether the app is in front of the person: its window has the focus and is not hidden. What the person is shown
 * counts as seen only then.
 */
export function useInFront(): boolean {
  const [front, setFront] = useState(read);
  useEffect(() => {
    const update = () => setFront(read());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return front;
}

const dayOf = (): string => new Date().toDateString();

/**
 * The local day, as a string that changes at midnight: what depends on "today" is worked out again then, and not only
 * when something else changes.
 */
export function useDay(): string {
  const [day, setDay] = useState(dayOf);
  useEffect(() => {
    // From the day that is shown to the first second of the next.
    const tomorrow = new Date(day);
    tomorrow.setHours(24, 0, 1, 0);
    const timer = setTimeout(
      () => setDay(dayOf()),
      Math.max(1000, tomorrow.getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}
