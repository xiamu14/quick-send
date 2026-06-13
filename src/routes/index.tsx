import { createFileRoute } from "@tanstack/react-router";
import { RoomsPage } from "@/features/rooms/RoomList";

export const Route = createFileRoute("/")({
  component: RoomsPage,
});
