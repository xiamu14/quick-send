import { createFileRoute } from "@tanstack/react-router";
import { RecoverScreen } from "@/features/identity/IdentityScreen";

export const Route = createFileRoute("/recover")({
  component: RecoverScreen,
});
