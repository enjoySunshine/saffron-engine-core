import { Debug } from '../../../core/debug.js';
import { ReadStream } from '../../../core/read-stream.js';
import { runCooperative } from '../../../core/cooperative-task.js';

import {
    TEXHINT_ASSET,
    ADDRESS_REPEAT, ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    TEXTURETYPE_RGBE
} from '../../../platform/graphics/constants.js';
import { Texture } from '../../../platform/graphics/texture.js';
import { Http } from '../../../platform/net/http.js';

import { TextureParser } from './texture.js';

/**
 * Texture parser for hdr files.
 */
class HdrParser extends TextureParser {
    constructor() {
        super();

        // texture data decoded incrementally by load(), keyed on the fetched
        // ArrayBuffer and consumed (once) by open(). Entries whose load is
        // abandoned before open() are collected once the buffer is unreferenced.
        this._decoded = new WeakMap();
    }

    canParse(context) {
        return context.ext === 'hdr';
    }

    load(url, callback, asset) {
        this.handler.fetch(url, Http.ResponseType.ARRAY_BUFFER, (err, data) => {
            if (err || !(data instanceof ArrayBuffer)) {
                callback(err, data);
                return;
            }

            // decode the pixels incrementally, yielding to the event loop between
            // scanlines, so a single decode never occupies the main thread for the
            // whole duration; open() then consumes the cached result synchronously.
            // a null decode result is the same failure signal parse() returns (the
            // reason has already been logged), not an exception that can crash the page
            this.parseAsync(data).then((textureData) => {
                if (textureData) {
                    this._decoded.set(data, textureData);
                }
                callback(null, data);
            }, (decodeError) => {
                callback(decodeError);
            });
        }, asset);

        // .hdr assets should be loaded with 'rgbe' type, but historically they were not, so set a default type here
        if (asset.data && !asset.data.type) {
            asset.data.type = TEXTURETYPE_RGBE;
        }
    }

    open(url, data, device, textureOptions = {}) {
        let textureData;
        if (data instanceof ArrayBuffer) {
            textureData = this._decoded.get(data);
            if (textureData !== undefined) {
                // the decoded result is consumed exactly once
                this._decoded.delete(data);
            }
        }

        if (textureData === undefined) {
            // synchronous fallback for data that load() did not pre-decode, such
            // as direct callers of parse() and data supplied by bundles
            textureData = this.parse(data);
        }

        if (!textureData) {
            return null;
        }

        const texture = new Texture(device, {
            name: url,
            // #if _PROFILER
            profilerHint: TEXHINT_ASSET,
            // #endif
            addressU: ADDRESS_REPEAT,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            width: textureData.width,
            height: textureData.height,
            levels: textureData.levels,
            format: PIXELFORMAT_RGBA8,
            type: TEXTURETYPE_RGBE,

            ...textureOptions,

            // requirements of RGBE encoded data, which override any asset-provided options: it
            // must stay in a linear format, and as it can't be filtered, it cannot use mipmaps
            srgb: false,
            mipmaps: false
        });

        texture.upload();

        return texture;
    }

    // https://floyd.lbl.gov/radiance/refer/filefmts.pdf with help from http://www.graphics.cornell.edu/~bjw/rgbe/rgbe.c
    parse(data) {
        const header = this._readHeader(data);
        if (!header) {
            return null;
        }

        const { readStream, width, height, flipY } = header;
        const pixels = this._readPixels(readStream, width, height, flipY);

        if (!pixels) {
            return null;
        }

        // create texture
        return {
            width: width,
            height: height,
            levels: [pixels]
        };
    }

    /**
     * Asynchronous counterpart of {@link HdrParser#parse}: decodes the same data
     * to byte-identical pixels, but yields the thread back to the event loop
     * between scanlines so the main thread is never occupied for the whole
     * decode at once.
     *
     * @param {ArrayBuffer} data - The raw .hdr file bytes.
     * @param {(elapsedMs: number) => void} [onChunk] - Optional observer invoked
     * after each synchronous chunk of decode work with the time it occupied the
     * thread. Intended for measurements, for example benchmarking the longest
     * continuous main-thread occupancy.
     * @returns {Promise<{width: number, height: number, levels: Uint8Array[]}|null>}
     * The decoded texture data, or null for the same malformed inputs that make
     * parse() return null.
     * @ignore
     */
    parseAsync(data, onChunk) {
        const header = this._readHeader(data);
        if (!header) {
            return Promise.resolve(null);
        }

        const { readStream, width, height, flipY } = header;
        return this._readPixelsAsync(readStream, width, height, flipY, onChunk).then((pixels) => {
            if (!pixels) {
                return null;
            }

            return {
                width: width,
                height: height,
                levels: [pixels]
            };
        });
    }

    _readHeader(data) {
        const readStream = new ReadStream(data);

        // require magic
        const magic = readStream.readLine();
        if (!magic.startsWith('#?RADIANCE')) {
            Debug.error('radiance header has invalid magic');
            return null;
        }

        // read header variables
        const variables = { };
        while (true) {
            const line = readStream.readLine();
            if (line.length === 0) {
                // empty line signals end of header
                break;
            } else {
                const parts = line.split('=');
                if (parts.length === 2) {
                    variables[parts[0]] = parts[1];
                }
            }
        }

        // we require FORMAT variable
        if (!variables.hasOwnProperty('FORMAT')) {
            Debug.error('radiance header missing FORMAT variable');
            return null;
        }

        // read the resolution specifier
        const resolution = readStream.readLine().split(' ');
        if (resolution.length !== 4) {
            Debug.error('radiance header has invalid resolution');
            return null;
        }

        const height = parseInt(resolution[1], 10);
        const width = parseInt(resolution[3], 10);

        return {
            readStream,
            width,
            height,
            flipY: resolution[0] === '-Y'
        };
    }

    _readPixels(readStream, width, height, flipY) {
        // out of bounds
        if (width < 8 || width > 0x7fff) {
            return this._readPixelsFlat(readStream, width, height);
        }

        return this._drainGenerator(this._decodeRlePixels(readStream, width, height, flipY));
    }

    _readPixelsAsync(readStream, width, height, flipY, onChunk) {
        // out of bounds
        if (width < 8 || width > 0x7fff) {
            return Promise.resolve(this._readPixelsFlat(readStream, width, height));
        }

        return runCooperative(this._decodeRlePixels(readStream, width, height, flipY), undefined, onChunk);
    }

    // Runs a decode generator to completion without ever yielding the thread.
    _drainGenerator(generator) {
        let result;
        do {
            result = generator.next();
        } while (!result.done);
        return result.value;
    }

    // Generator implementing pixel decoding. A yield marks the end of a
    // scanline, so the async driver can return to the event loop between
    // scanlines while the sync driver simply ignores the yields. Both parse()
    // and parseAsync() run this exact code, so their output cannot diverge.
    *_decodeRlePixels(readStream, width, height, flipY) {
        const rgbe = [0, 0, 0, 0];

        // check first scanline width to determine whether the file is RLE
        readStream.readArray(rgbe);
        if ((rgbe[0] !== 2 || rgbe[1] !== 2 || (rgbe[2] & 0x80) !== 0)) {
            // not RLE
            readStream.skip(-4);
            return this._readPixelsFlat(readStream, width, height);
        }

        // allocate texture buffer
        const buffer = new ArrayBuffer(width * height * 4);
        const view = new Uint8Array(buffer);
        let scanstart = flipY ? 0 : width * 4 * (height - 1);
        let x, y, i, channel, count, value;

        for (y = 0; y < height; ++y) {
            // read scanline width specifier
            if (y) {
                readStream.readArray(rgbe);
            }

            // sanity check it
            if ((rgbe[2] << 8) + rgbe[3] !== width) {
                Debug.error('radiance has invalid scanline width');
                return null;
            }

            // each scanline is stored by channel
            for (channel = 0; channel < 4; ++channel) {
                x = 0;
                while (x < width) {
                    count = readStream.readU8();
                    if (count > 128) {
                        // run of the same value
                        count -= 128;
                        if (x + count > width) {
                            Debug.error('radiance has invalid scanline data');
                            return null;
                        }
                        value = readStream.readU8();
                        for (i = 0; i < count; ++i) {
                            view[scanstart + channel + 4 * x++] = value;
                        }
                    } else {
                        // non-run
                        if (count === 0 || x + count > width) {
                            Debug.error('radiance has invalid scanline data');
                            return null;
                        }
                        for (i = 0; i < count; ++i) {
                            view[scanstart + channel + 4 * x++] = readStream.readU8();
                        }
                    }
                }
            }

            scanstart += width * 4 * (flipY ? 1 : -1);
            yield;
        }

        return view;
    }

    _readPixelsFlat(readStream, width, height) {
        return readStream.remainingBytes === width * height * 4 ? new Uint8Array(readStream.arraybuffer, readStream.offset) : null;
    }
}

export { HdrParser };
