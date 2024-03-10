import { useState } from "preact/hooks";
import VideoBackend from "./backend/VideoBackend";
import { App } from "./components/App/App";

export default function AppRoot() {
  const [backend] = useState(() => new VideoBackend());

  return (
    <>
      <App backend={backend} />
    </>
  );
}
