import { createFileRoute } from "@tanstack/react-router";
import { DiscoverPage } from "@/features/rooms/RoomList";

export const Route = createFileRoute("/discover")({
  component: DiscoverPage,
});
