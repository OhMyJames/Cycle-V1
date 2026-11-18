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
