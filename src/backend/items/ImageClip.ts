import ImageResource from "../resources/ImageResource";
import Clip, { ClipProperties } from "./Clip";

export default class ImageClip extends Clip {
  constructor(properties: ClipProperties, public resource: ImageResource) {
    super(properties);
  }

  async simpleRender(
    canvas: CanvasRenderingContext2D,
    _time: number,
    width: number,
    height: number
  ) {
    canvas.drawImage(await this.resource.asImage(), 0, 0, width, height);
  }
}
