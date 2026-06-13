import { createFileRoute } from "@tanstack/react-router";
import { RoomPage } from "@/features/chat/RoomScreen";

export const Route = createFileRoute("/rooms/$roomId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { roomId } = Route.useParams();
  return <RoomPage roomId={roomId} />;
}
