import { RouterProvider } from "@tanstack/react-router";
import { Provider } from "jotai";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { getRouter } from "../router";
import { appStore } from "../store/app";

const router = getRouter();
const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element is missing");
}

ReactDOM.createRoot(root).render(
  <StrictMode>
    <Provider store={appStore}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>
);
