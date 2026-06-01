import { createFileRoute } from "@tanstack/react-router";
import { App } from "../web/App";

export const Route = createFileRoute("/")({
  component: App,
});

