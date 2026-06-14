import { useEffect, useState } from "react";

const mobileQuery = "(max-width: 767px)";

export function useMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(mobileQuery).matches
  );

  useEffect(() => {
    const query = window.matchMedia(mobileQuery);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}
