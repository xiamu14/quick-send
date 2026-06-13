import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import "../web/styles.css";

export const Route = createRootRoute({
  component: Root,
});

function Root() {
  return (
    <>
      <Outlet />
      <Toaster position="top-center" richColors />
    </>
  );
}
