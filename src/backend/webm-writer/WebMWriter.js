/**
 * WebM video encoder for Google Chrome. This implementation is suitable for
 * creating very large video files, because it can stream Blobs directly to a
 * FileWriter without buffering the entire video in memory.
 *
 * When FileWriter is not available or not desired, it can buffer the video in
 * memory as a series of Blobs which are eventually returned as one composite
 * Blob.
 *
 * By Nicholas Sherlock.
 *
 * Based on the ideas from Whammy: https://github.com/antimatter15/whammy
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 */
import ArrayBufferDataStream from "./ArrayBufferDataStream";
import BlobBuffer from "./BlobBuffer";

function extend(base, top) {
  let target = {};

  [base, top].forEach(function (obj) {
    for (let prop in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, prop)) {
        target[prop] = obj[prop];
      }
    }
  });

  return target;
}

/**
 * @param {String} string
 * @returns {number}
 */
function byteStringToUint32LE(string) {
  let a = string.charCodeAt(0),
    b = string.charCodeAt(1),
    c = string.charCodeAt(2),
    d = string.charCodeAt(3);

  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

// Just a little utility so we can tag values as floats for the EBML encoder's
// benefit
class EBMLFloat32 {
  constructor(value) {
    this.value = value;
  }
}

class EBMLFloat64 {
  constructor(value) {
    this.value = value;
  }
}

/**
 * Write the given EBML object to the provided ArrayBufferStream.
 *
 * @param buffer
 * @param {Number} bufferFileOffset - The buffer's first byte is at this
 *     position inside the video file.
 *                                    This is used to complete offset and
 * dataOffset fields in each EBML structure, indicating the file offset of the
 * first byte of the EBML element and its data payload.
 * @param {*} ebml
 */
function writeEBML(buffer, bufferFileOffset, ebml) {
  // Is the ebml an array of sibling elements?
  if (Array.isArray(ebml)) {
    for (let i = 0; i < ebml.length; i++) {
      writeEBML(buffer, bufferFileOffset, ebml[i]);
    }
    // Is this some sort of raw data that we want to write directly?
  } else if (typeof ebml === "string") {
    buffer.writeString(ebml);
  } else if (ebml instanceof Uint8Array) {
    buffer.writeBytes(ebml);
  } else if (ebml.id) {
    // We're writing an EBML element
    ebml.offset = buffer.pos + bufferFileOffset;

    buffer.writeUnsignedIntBE(ebml.id); // ID field

    // Now we need to write the size field, so we must know the payload size:

    if (Array.isArray(ebml.data)) {
      // Writing an array of child elements. We won't try to measure the size of
      // the children up-front

      let sizePos, dataBegin, dataEnd;

      if (ebml.size === -1) {
        // Write the reserved all-one-bits marker to note that the size of this
        // element is unknown/unbounded
        buffer.writeByte(0xff);
      } else {
        sizePos = buffer.pos;

        /* Write a dummy size field to overwrite later. 4 bytes allows an
         * element maximum size of 256MB, which should be plenty (we don't want
         * to have to buffer that much data in memory at one time anyway!)
         */
        buffer.writeBytes([0, 0, 0, 0]);
      }

      dataBegin = buffer.pos;

      ebml.dataOffset = dataBegin + bufferFileOffset;
      writeEBML(buffer, bufferFileOffset, ebml.data);

      if (ebml.size !== -1) {
        dataEnd = buffer.pos;

        ebml.size = dataEnd - dataBegin;

        buffer.seek(sizePos);
        buffer.writeEBMLVarIntWidth(ebml.size, 4); // Size field

        buffer.seek(dataEnd);
      }
    } else if (typeof ebml.data === "string") {
      buffer.writeEBMLVarInt(ebml.data.length); // Size field
      ebml.dataOffset = buffer.pos + bufferFileOffset;
      buffer.writeString(ebml.data);
    } else if (typeof ebml.data === "number") {
      // Allow the caller to explicitly choose the size if they wish by
      // supplying a size field
      if (!ebml.size) {
        ebml.size = buffer.measureUnsignedInt(ebml.data);
      }

      buffer.writeEBMLVarInt(ebml.size); // Size field
      ebml.dataOffset = buffer.pos + bufferFileOffset;
      buffer.writeUnsignedIntBE(ebml.data, ebml.size);
    } else if (ebml.data instanceof EBMLFloat64) {
      buffer.writeEBMLVarInt(8); // Size field
      ebml.dataOffset = buffer.pos + bufferFileOffset;
      buffer.writeDoubleBE(ebml.data.value);
    } else if (ebml.data instanceof EBMLFloat32) {
      buffer.writeEBMLVarInt(4); // Size field
      ebml.dataOffset = buffer.pos + bufferFileOffset;
      buffer.writeFloatBE(ebml.data.value);
    } else if (ebml.data instanceof Uint8Array) {
      buffer.writeEBMLVarInt(ebml.data.byteLength); // Size field
      ebml.dataOffset = buffer.pos + bufferFileOffset;
      buffer.writeBytes(ebml.data);
    } else {
      throw new Error("Bad EBML datatype " + typeof ebml.data);
    }
  } else {
    throw new Error("Bad EBML datatype " + typeof ebml.data);
  }
}

/**
 * @typedef {Object} Frame
 * @property {string} frame - Raw VP8 frame data
 * @property {Number} trackNumber - From 1 to 126 (inclusive)
 * @property {Number} timecode
 */

/**
 * @typedef {Object} Cluster
 * @property {Number} timecode - Start time for the cluster
 */

/**
 * @returns WebMWriter
 *
 * @constructor
 */
class WebMWriter {
  constructor(options) {
    let MAX_CLUSTER_DURATION_MSEC = 5000,
      DEFAULT_TRACK_NUMBER = 1,
      writtenHeader = false,
      videoWidth = 0,
      videoHeight = 0,
      firstTimestampEver = true,
      earliestTimestamp = 0,
      /**
       *
       * @type {Frame[]}
       */
      clusterFrameBuffer = [],
      clusterStartTime = 0,
      clusterDuration = 0,
      lastTimeCode = 0,
      optionDefaults = {
        fileWriter: null, // Chrome FileWriter in order to stream to a file

        // instead of buffering to memory (optional)
        fd: null, // Node.JS file descriptor to write to instead of buffering

        // (optional)
        codec: "VP8", // Codec to write to webm file
      },
      seekPoints = {
        Cues: {
          id: new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]),
          positionEBML: null,
        },
        SegmentInfo: {
          id: new Uint8Array([0x15, 0x49, 0xa9, 0x66]),
          positionEBML: null,
        },
        Tracks: {
          id: new Uint8Array([0x16, 0x54, 0xae, 0x6b]),
          positionEBML: null,
        },
      },
      ebmlSegment, // Root element of the EBML document
      segmentDuration = {
        id: 0x4489, // Duration
        data: new EBMLFloat64(0),
      },
      seekHead,
      cues = [],
      blobBuffer = new BlobBuffer(options.fileWriter || options.fd);

    function fileOffsetToSegmentRelative(fileOffset) {
      return fileOffset - ebmlSegment.dataOffset;
    }

    /**
     * Create a SeekHead element with descriptors for the points in the global
     * seekPoints array.
     *
     * 5 bytes of position values are reserved for each node, which lie at the
     * offset point.positionEBML.dataOffset, to be overwritten later.
     */
    function createSeekHead() {
      let seekPositionEBMLTemplate = {
          id: 0x53ac, // SeekPosition
          size: 5, // Allows for 32GB video files
          data: 0, // We'll overwrite this when the file is complete
        },
        result = {
          id: 0x114d9b74, // SeekHead
          data: [],
        };

      for (let name in seekPoints) {
        let seekPoint = seekPoints[name];

        seekPoint.positionEBML = Object.create(seekPositionEBMLTemplate);

        result.data.push({
          id: 0x4dbb, // Seek
          data: [
            {
              id: 0x53ab, // SeekID
              data: seekPoint.id,
            },
            seekPoint.positionEBML,
          ],
        });
      }

      return result;
    }

    /**
     * Write the WebM file header to the stream.
     */
    function writeHeader() {
      seekHead = createSeekHead();

      let ebmlHeader = {
          id: 0x1a45dfa3, // EBML
          data: [
            {
              id: 0x4286, // EBMLVersion
              data: 1,
            },
            {
              id: 0x42f7, // EBMLReadVersion
              data: 1,
            },
            {
              id: 0x42f2, // EBMLMaxIDLength
              data: 4,
            },
            {
              id: 0x42f3, // EBMLMaxSizeLength
              data: 8,
            },
            {
              id: 0x4282, // DocType
              data: "webm",
            },
            {
              id: 0x4287, // DocTypeVersion
              data: 2,
            },
            {
              id: 0x4285, // DocTypeReadVersion
              data: 2,
            },
          ],
        },
        segmentInfo = {
          id: 0x1549a966, // Info
          data: [
            {
              id: 0x2ad7b1, // TimecodeScale
              data: 1e6, // Times will be in microseconds (1e6 nanoseconds
              // per step = 1ms)
            },
            {
              id: 0x4d80, // MuxingApp
              data: "webm-writer-js",
            },
            {
              id: 0x5741, // WritingApp
              data: "webm-writer-js",
            },
            segmentDuration, // To be filled in later
          ],
        },
        videoProperties = [
          {
            id: 0xb0, // PixelWidth
            data: videoWidth,
          },
          {
            id: 0xba, // PixelHeight
            data: videoHeight,
          },
        ];

      let tracks = {
        id: 0x1654ae6b, // Tracks
        data: [
          {
            id: 0xae, // TrackEntry
            data: [
              {
                id: 0xd7, // TrackNumber
                data: DEFAULT_TRACK_NUMBER,
              },
              {
                id: 0x73c5, // TrackUID
                data: DEFAULT_TRACK_NUMBER,
              },
              {
                id: 0x83, // TrackType
                data: 1,
              },
              {
                id: 0xe0, // Video
                data: videoProperties,
              },
              {
                id: 0x9c, // FlagLacing
                data: 0,
              },
              {
                id: 0x22b59c, // Language
                data: "und",
              },
              {
                id: 0xb9, // FlagEnabled
                data: 1,
              },
              {
                id: 0x88, // FlagDefault
                data: 1,
              },
              {
                id: 0x55aa, // FlagForced
                data: 0,
              },

              {
                id: 0x86, // CodecID
                data: "V_" + options.codec,
              } /*
                           (options.codec == 'VP8' ?
                                {
                                  'id': 0x63A2,  // Codec private data
                                  'data': []
                                } :
                                {
                                  'id': 0x63A2,  // Codec private data for vp9
                                  'data': [
                                    {
                                      'id': 1,  // vp9 Profile
                                      'size': 1,
                                      'data': 0
                                    },
                                    {
                                      'id': 2,  // Feature level
                                      'size': 1,
                                      'data': 10
                                    },
                                    {
                                      'id': 3,  // bitdepth level
                                      'size': 1,
                                      'data': 8
                                    },
                                    {
                                      'id': 4,  // color sampling
                                      'size': 1,
                                      'data': 0
                                    }
                                  ]
                                }),
                           {
                             'id': 0x258688,  // CodecName
                             'data': options.codec
                           },*/,
            ],
          },
        ],
      };

      ebmlSegment = {
        id: 0x18538067, // Segment
        size: -1, // Unbounded size
        data: [seekHead, segmentInfo, tracks],
      };

      let bufferStream = new ArrayBufferDataStream(256);

      writeEBML(bufferStream, blobBuffer.pos, [ebmlHeader, ebmlSegment]);
      blobBuffer.write(bufferStream.getAsDataArray());

      // Now we know where these top-level elements lie in the file:
      seekPoints.SegmentInfo.positionEBML.data = fileOffsetToSegmentRelative(
        segmentInfo.offset
      );
      seekPoints.Tracks.positionEBML.data = fileOffsetToSegmentRelative(
        tracks.offset
      );

      writtenHeader = true;
    }

    /**
     * Create a SimpleBlock element to hold the given frame.
     *
     * @param {Frame} frame
     *
     * @return A SimpleBlock EBML element.
     */
    function createSimpleBlockForframe(frame) {
      let bufferStream = new ArrayBufferDataStream(1 + 2 + 1);

      if (!(frame.trackNumber > 0 && frame.trackNumber < 127)) {
        throw new Error("TrackNumber must be > 0 and < 127");
      }

      bufferStream.writeEBMLVarInt(frame.trackNumber); // Always 1 byte since we limit the range of

      // trackNumber
      bufferStream.writeU16BE(frame.timecode);

      // Flags byte
      bufferStream.writeByte(
        (frame.type == "key" ? 1 : 0) << 7 // frame
      );

      return {
        id: 0xa3, // SimpleBlock
        data: [bufferStream.getAsDataArray(), frame.frame],
      };
    }

    /**
     * Create a Cluster EBML node.
     *
     * @param {Cluster} cluster
     *
     * Returns an EBML element.
     */
    function createCluster(cluster) {
      return {
        id: 0x1f43b675,
        data: [
          {
            id: 0xe7, // Timecode
            data: Math.round(cluster.timecode),
          },
        ],
      };
    }

    function addCuePoint(trackIndex, clusterTime, clusterFileOffset) {
      cues.push({
        id: 0xbb, // Cue
        data: [
          {
            id: 0xb3, // CueTime
            data: clusterTime,
          },
          {
            id: 0xb7, // CueTrackPositions
            data: [
              {
                id: 0xf7, // CueTrack
                data: trackIndex,
              },
              {
                id: 0xf1, // CueClusterPosition
                data: fileOffsetToSegmentRelative(clusterFileOffset),
              },
            ],
          },
        ],
      });
    }

    /**
     * Write a Cues element to the blobStream using the global `cues` array of
     * CuePoints (use addCuePoint()). The seek entry for the Cues in the
     * SeekHead is updated.
     */
    let firstCueWritten = false;
    function writeCues() {
      if (firstCueWritten) return;
      firstCueWritten = true;

      let ebml = { id: 0x1c53bb6b, data: cues },
        cuesBuffer = new ArrayBufferDataStream(16 + cues.length * 32); // Pretty crude estimate of the buffer size we'll need

      writeEBML(cuesBuffer, blobBuffer.pos, ebml);
      blobBuffer.write(cuesBuffer.getAsDataArray());

      // Now we know where the Cues element has ended up, we can update the
      // SeekHead
      seekPoints.Cues.positionEBML.data = fileOffsetToSegmentRelative(
        ebml.offset
      );
    }

    /**
     * Flush the frames in the current clusterFrameBuffer out to the stream as a
     * Cluster.
     */
    function flushClusterFrameBuffer() {
      if (clusterFrameBuffer.length === 0) {
        return;
      }

      // First work out how large of a buffer we need to hold the cluster data
      let rawImageSize = 0;

      for (let i = 0; i < clusterFrameBuffer.length; i++) {
        rawImageSize += clusterFrameBuffer[i].frame.byteLength;
      }

      let buffer = new ArrayBufferDataStream(
          rawImageSize + clusterFrameBuffer.length * 64
        ), // Estimate 64 bytes per block header
        cluster = createCluster({
          timecode: Math.round(clusterStartTime),
        });

      for (let i = 0; i < clusterFrameBuffer.length; i++) {
        cluster.data.push(createSimpleBlockForframe(clusterFrameBuffer[i]));
      }

      writeEBML(buffer, blobBuffer.pos, cluster);
      blobBuffer.write(buffer.getAsDataArray());

      addCuePoint(
        DEFAULT_TRACK_NUMBER,
        Math.round(clusterStartTime),
        cluster.offset
      );

      clusterFrameBuffer = [];
      clusterDuration = 0;
    }

    function validateOptions() {}

    /**
     *
     * @param {Frame} frame
     */
    function addFrameToCluster(frame) {
      frame.trackNumber = DEFAULT_TRACK_NUMBER;
      var time = frame.intime / 1000;
      if (firstTimestampEver) {
        earliestTimestamp = time;
        time = 0;
        firstTimestampEver = false;
      } else {
        time = time - earliestTimestamp;
      }
      lastTimeCode = time;
      if (clusterDuration == 0) clusterStartTime = time;

      // Frame timecodes are relative to the start of their cluster:
      // frame.timecode = Math.round(clusterDuration);
      frame.timecode = Math.round(time - clusterStartTime);

      clusterFrameBuffer.push(frame);
      clusterDuration = frame.timecode + 1;

      if (clusterDuration >= MAX_CLUSTER_DURATION_MSEC) {
        flushClusterFrameBuffer();
      }
    }

    /**
     * Rewrites the SeekHead element that was initially written to the stream
     * with the offsets of top level elements.
     *
     * Call once writing is complete (so the offset of all top level elements
     * is known).
     */
    function rewriteSeekHead() {
      let seekHeadBuffer = new ArrayBufferDataStream(seekHead.size),
        oldPos = blobBuffer.pos;

      // Write the rewritten SeekHead element's data payload to the stream
      // (don't need to update the id or size)
      writeEBML(seekHeadBuffer, seekHead.dataOffset, seekHead.data);

      // And write that through to the file
      blobBuffer.seek(seekHead.dataOffset);
      blobBuffer.write(seekHeadBuffer.getAsDataArray());
      blobBuffer.seek(oldPos);
    }

    /**
     * Rewrite the Duration field of the Segment with the newly-discovered
     * video duration.
     */
    function rewriteDuration() {
      let buffer = new ArrayBufferDataStream(8),
        oldPos = blobBuffer.pos;

      // Rewrite the data payload (don't need to update the id or size)
      buffer.writeDoubleBE(lastTimeCode);

      // And write that through to the file
      blobBuffer.seek(segmentDuration.dataOffset);
      blobBuffer.write(buffer.getAsDataArray());

      blobBuffer.seek(oldPos);
    }

    /**
     * Add a frame to the video.
     *
     * @param {HTMLCanvasElement|String} frame - A Canvas element that
     *     contains the frame, or a WebP string you obtained by calling
     * toDataUrl() on an image yourself.
     *
     */
    this.addFrame = function (frame) {
      if (!writtenHeader) {
        videoWidth = options.width;
        videoHeight = options.height;
        writeHeader();
      }
      if (frame.constructor.name == "EncodedVideoChunk") {
        let frameData = new Uint8Array(frame.byteLength);
        frame.copyTo(frameData);
        addFrameToCluster({
          frame: frameData,
          intime: frame.timestamp,
          type: frame.type,
        });
        return;
      }
    };

    /**
     * Finish writing the video and return a Promise to signal completion.
     *
     * If the destination device was memory (i.e. options.fileWriter was not
     * supplied), the Promise is resolved with a Blob with the contents of the
     * entire video.
     */
    this.complete = function () {
      if (!writtenHeader) {
        writeHeader();
      }
      firstTimestampEver = true;

      flushClusterFrameBuffer();

      writeCues();
      rewriteSeekHead();
      rewriteDuration();

      return blobBuffer.complete("video/webm");
    };

    this.getWrittenSize = function () {
      return blobBuffer.length;
    };

    options = extend(optionDefaults, options || {});
    validateOptions();
  }
}

export default WebMWriter;
