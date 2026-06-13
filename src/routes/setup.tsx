import { createFileRoute } from "@tanstack/react-router";
import { RegisterScreen } from "@/features/identity/IdentityScreen";

export const Route = createFileRoute("/setup")({
  component: RegisterScreen,
});
