import Resource from "./Resource";

export default class ImageResource extends Resource {
  constructor(public file: File) {
    super();
    if (!file.type.startsWith("image/")) {
      throw new Error("a non-image file was used to create an ImageResource.");
    }
  }

  getDisplayName(): string {
    return this.file.name;
  }

  getSize(): number {
    return this.file.size;
  }

  getPreviewUrl(): string | undefined {
    return URL.createObjectURL(this.file);
  }

  #image: HTMLImageElement | null = null;
  async asImage(): Promise<HTMLImageElement> {
    if (!this.#image) {
      const blobUrl = URL.createObjectURL(this.file);
      const image = new Image();
      image.src = blobUrl;
      await new Promise((r, j) => {
        image.onload = r;
        image.onerror = j;
      });
      URL.revokeObjectURL(blobUrl);
      this.#image = image;
    }
    return this.#image;
  }
}
