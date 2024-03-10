import Clip from "./items/Clip";
import Resource from "./resources/Resource";
import WebMWriter from "./webm-writer";

const MAX_ENCODER_QUEUE_SIZE = 30;
const KEYFRAME_FREQUENCY = 150;

export interface RenderOptions {
  start: number;
  length: number;
  width: number;
  height: number;
  fps: number;
}

export default class VideoBackend {
  public resources: Resource[] = [];
  public clips: Clip[] = [];

  resourceFromId(id: number): Resource | null {
    return this.resources.find((resource) => resource.id === id) ?? null;
  }

  removeResourceById(id: number) {
    this.resources.splice(
      this.resources.findIndex((resource) => resource.id === id),
      1
    );
  }

  clipFromId(id: number): Clip | null {
    return this.clips.find((clip) => clip.id === id) ?? null;
  }

  removeClipById(id: number) {
    this.clips.splice(
      this.clips.findIndex((clip) => clip.id === id),
      1
    );
  }

  async renderFrame(
    time: number,
    width: number,
    height: number
  ): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("failed to get rendering context for frame");
    await Promise.all(
      this.clips.map(async (clip) => {
        if (clip.needsRender(time)) {
          await clip.render(ctx, time, width, height);
        }
      })
    );
    return canvas;
  }

  async renderToWritableStream(
    writableStream: FileSystemWritableFileStream,
    options: RenderOptions,
    statusCallback: (fraction: number) => void = () => {}
  ): Promise<void> {
    const totalFrames = options.fps * (options.length / 1e6);
    const frameLength = options.length / totalFrames;

    const webmWriter = new WebMWriter({
      fileWriter: writableStream,
      codec: "VP9",
      width: options.width,
      height: options.height,
      frameRate: options.fps,
    });

    const config = {
      codec: "vp09.00.10.08",
      width: options.width,
      height: options.height,
      bitrate: 10e6,
    };
    let framesEncoded = 0;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        webmWriter.addFrame(chunk);
        framesEncoded++;
        if (framesEncoded % options.fps === 0)
          statusCallback(framesEncoded / totalFrames);
      },
      error: (e) => {
        console.error(e.message);
        webmWriter.complete();
      },
    });
    const support = await VideoEncoder.isConfigSupported(config);
    console.assert(support.supported);
    encoder.configure(config);

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      // render the frame
      const frameStart = options.start + frameIndex * frameLength;
      const frameCanvas = await this.renderFrame(
        frameStart,
        options.width,
        options.height
      );
      const frame = new VideoFrame(frameCanvas, {
        timestamp: frameStart,
        duration: frameLength,
      });

      // wait for the encoder to have capacity
      while (encoder.encodeQueueSize > MAX_ENCODER_QUEUE_SIZE) {
        await new Promise<void>((r) => {
          const callback = () => {
            encoder.removeEventListener("dequeue", callback);
            r();
          };
          encoder.addEventListener("dequeue", callback);
        });
      }

      // encode the frame
      const keyFrame = frameIndex % KEYFRAME_FREQUENCY === 0;
      encoder.encode(frame, { keyFrame });
      frame.close();
    }

    // finish up processing
    await encoder.flush();
    await webmWriter.complete();
    encoder.close();
  }
}
