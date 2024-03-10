export interface ClipProperties {
  /** When the clip should start being rendered, in microseconds, inclusive */
  renderStart: number;
  /** How long the clip should be rendered for, in microseconds, noninclusive */
  renderLength: number;

  /** In the range 0-1, where 1 is the full height and 0 is at the top. */
  posTop: number;
  /** In the range 0-1, where 1 is the full width and 0 is at the left. */
  posLeft: number;
  /** In the range 0-1, where 1 is the full width and 0 is a width of 0 pixels. */
  posWidth: number;
  /** In the range 0-1, where 1 is the full height and 0 is a height of 0 pixels. */
  posHeight: number;

  rotation: number;
}

interface Clip {
  /**
   * renders a frame into the canvas
   *
   * @param canvas the canvas to render to
   * @param time time relative to the start of the clip, in us
   * @param width width of canvas
   * @param height height of canvas
   */
  simpleRender?(
    canvas: CanvasRenderingContext2D,
    time: number,
    width: number,
    height: number
  ): Promise<void>;
}

abstract class Clip {
  constructor(public properties: ClipProperties) {
    this.id = Math.random();
  }

  id: number;

  /**
   * Whether this clip needs to be rendered at that time.
   *
   * @param time the current time, in microseconds
   */
  needsRender(time: number) {
    if (
      time >= this.properties.renderStart &&
      time < this.properties.renderStart + this.properties.renderLength
    ) {
      return true;
    }
    return false;
  }

  /**
   * Renders this clip to the frame.
   *
   * @param canvas The canvas to render to
   * @param time The current time, in microseconds
   * @param width The width of the canvas
   * @param height The height of the canvas
   */
  async render(
    canvas: CanvasRenderingContext2D,
    time: number,
    width: number,
    height: number
  ) {
    if (this.simpleRender !== undefined) {
      // do the transformations here
      const oldTransform = canvas.getTransform();
      canvas.transform(
        this.properties.posWidth,
        0,
        0,
        this.properties.posHeight,
        this.properties.posLeft,
        this.properties.posTop
      );
      canvas.rotate(this.properties.rotation);
      await this.simpleRender(
        canvas,
        time - this.properties.renderStart,
        width,
        height
      );
      canvas.setTransform(oldTransform);
    } else {
      // if simpleRender does not exist, clip types should override render
      throw new Error("clip cannot be rendered");
    }
  }

  /**
   * Must be called after changing a property to recalculate things. Also called
   * when a Clip is initialized
   */
  async update(): Promise<void> {}
}

export default Clip;
