import VideoBackend from "../../backend/VideoBackend";
import styles from "./ResourcesList.module.css";

/**
 * Format bytes as human-readable text.
 *
 * @param bytes Number of bytes.
 * @param si True to use metric (SI) units, aka powers of 1000. False to use
 *           binary (IEC), aka powers of 1024.
 * @param dp Number of decimal places to display.
 *
 * @return Formatted string.
 */
function humanFileSize(bytes: number, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + " B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  );

  return bytes.toFixed(dp) + " " + units[u];
}

export interface ResourcesListProps {
  backend: VideoBackend;
  resources: number[];
  removeResource: (id: number) => void;
  addResource: () => Promise<void>;
}

export default function ResourcesList({
  backend,
  resources,
  removeResource,
  addResource,
}: ResourcesListProps) {
  return (
    <>
      {resources.map((resourceId, i) => {
        const resource = backend.resourceFromId(resourceId);
        // skip rendering, probably stale data
        if (!resource) return;
        return (
          <div class={styles.item} key={resourceId}>
            <div
              class={styles.itemPreviewContainer}
              style={{ backgroundImage: `url("${resource.getPreviewUrl()}")` }}
            >
              <button
                class={styles.deleteButton}
                onClick={() => {
                  removeResource(i);
                }}
              >
                &times;
              </button>
            </div>
            <div class={styles.itemText}>
              <div class={styles.name}>{resource.getDisplayName()}</div>
              <div class={styles.description}>
                {humanFileSize(resource.getSize())}
              </div>
            </div>
          </div>
        );
      })}
      <button onClick={addResource}>Add resource</button>
    </>
  );
}
