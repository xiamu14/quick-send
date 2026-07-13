import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Provider } from "jotai";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { getRouter } from "../router";
import { appStore } from "../store/app";

if (debugEnabled()) {
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/eruda";
  script.onload = () => {
    (window as Window & { eruda?: { init: () => void } }).eruda?.init();
  };
  document.head.append(script);
}

function debugEnabled() {
  if (import.meta.env.DEV) {
    return true;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "true") {
      window.localStorage.setItem("quick-send.debug", "true");
      return true;
    }
    return window.localStorage.getItem("quick-send.debug") === "true";
  } catch {
    return false;
  }
}

const router = getRouter();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});
const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element is missing");
}

ReactDOM.createRoot(root).render(
  <StrictMode>
    <Provider store={appStore}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>
  </StrictMode>
);
