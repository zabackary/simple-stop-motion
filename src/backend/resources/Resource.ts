export default abstract class Resource {
  constructor() {
    this.id = Math.random();
  }

  id: number;

  /** gets the displayed name of the resource, usually the filename */
  abstract getDisplayName(): string;
  /** gets the size of the resource in bytes */
  abstract getSize(): number;
  /** gets the preview of the resource as url */
  abstract getPreviewUrl(): string | undefined;
}
