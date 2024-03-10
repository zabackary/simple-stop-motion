import ImageResource from "../resources/ImageResource";
import Clip, { ClipProperties } from "./Clip";

const clamp = (num: number, min: number, max: number) =>
  Math.min(Math.max(num, min), max);

export default class ImageSequenceClip extends Clip {
  constructor(properties: ClipProperties, public resources: ImageResource[]) {
    super(properties);
    this.update();
  }

  microsecondsPerClip: number = 0;
  async update(): Promise<void> {
    this.microsecondsPerClip =
      this.properties.renderLength / this.resources.length;
  }

  async simpleRender(
    canvas: CanvasRenderingContext2D,
    time: number,
    width: number,
    height: number
  ) {
    if (this.resources.length < 1) return;
    const resourceIndex = clamp(
      Math.floor(time / this.microsecondsPerClip),
      0,
      this.resources.length - 1
    );
    const resource = this.resources[resourceIndex];
    canvas.drawImage(await resource.asImage(), 0, 0, width, height);
  }
}
