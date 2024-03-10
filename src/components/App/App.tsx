import { useState } from "preact/hooks";
import VideoBackend from "../../backend/VideoBackend";
import ImageSequenceClip from "../../backend/items/ImageSequenceClip";
import ImageResource from "../../backend/resources/ImageResource";
import ResourcesList from "../resources/ResourcesList";
import classes from "./App.module.css";

export function App({ backend }: { backend: VideoBackend }) {
  const [resources, setResources] = useState(() =>
    backend.resources.map((resource) => resource.id)
  );
  const [clips, setClips] = useState(() =>
    backend.clips.map((clip) => clip.id)
  );

  const [exportStatus, setExportStatus] = useState(0);

  const removeResource = (id: number) => {
    setResources(resources.filter((resource) => resource !== id));
    backend.removeResourceById(id);
  };

  const addResource = async () => {
    const handles = await showOpenFilePicker({
      types: [
        {
          accept: { "image/*": [".png", ".gif", ".jpeg", ".jpg", ".webp"] },
          description: "Images",
        },
      ],
      excludeAcceptAllOption: true,
      startIn: "pictures",
      multiple: true,
    });
    await Promise.all(
      handles.map(async (handle) => {
        const file = await handle.getFile();
        const resource = new ImageResource(file);
        const resourceId = resource.id;
        backend.resources.push(resource);
        setResources((oldResources) => [...oldResources, resourceId]);
      })
    );
  };

  const render = async () => {
    const fps = parseInt(prompt("how many frames per second?") ?? "8");

    backend.clips = [
      new ImageSequenceClip(
        {
          posHeight: 1,
          posLeft: 0,
          posTop: 0,
          posWidth: 1,
          renderLength: (backend.resources.length / fps) * 1e6,
          renderStart: 0,
          rotation: Math.PI,
        },
        (backend.resources as ImageResource[]).sort((a, b) =>
          a.getDisplayName().localeCompare(b.getDisplayName())
        )
      ),
    ];

    const fileHandle = await window.showSaveFilePicker({
      startIn: "videos",
      suggestedName: "export.webm",
      types: [
        {
          description: "WebM Video File",
          accept: { "video/webm": [".webm"] },
        },
      ],
    });
    const writable = await fileHandle.createWritable();
    await backend.renderToWritableStream(
      writable,
      {
        start: 0,
        fps: 30,
        length: (backend.resources.length / fps) * 1e6,
        width: 1600,
        height: 900,
      },
      (finishFraction) => {
        setExportStatus(Math.ceil(finishFraction * 100));
      }
    );
    writable.close();
  };

  return (
    <>
      <div class={classes.app}>
        <div class={classes.header}>
          <h1>Stop-motion builder</h1>
          <button onClick={render}>Render and download</button>
          {exportStatus && <>rendering ({exportStatus}% finished)</>}
        </div>
        <div class={[classes.card, classes.resourcesCard].join(" ")}>
          <ResourcesList
            backend={backend}
            resources={resources}
            removeResource={removeResource}
            addResource={addResource}
          />
        </div>
        <div class={[classes.card, classes.previewCard].join(" ")}></div>
        <div class={[classes.card, classes.timelineCard].join(" ")}>
          <div class="list">
            <i>Drag and drop files here.</i>
          </div>
          <div class="properties">
            <i>Hover over an item to view its properties.</i>
          </div>
        </div>
      </div>
    </>
  );
}
