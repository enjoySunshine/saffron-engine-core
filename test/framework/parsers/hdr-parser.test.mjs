import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';
import { restore, stub } from 'sinon';

import { Debug } from '../../../src/core/debug.js';
import { HdrParser } from '../../../src/framework/parsers/texture/hdr.js';
import { TEXTURETYPE_RGBE } from '../../../src/platform/graphics/constants.js';
import { createApp } from '../../app.mjs';
import { jsdomSetup, jsdomTeardown } from '../../jsdom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HDR_DIR = resolve(__dirname, '../../../examples/assets/hdri');
const HDR_FILES = [
    'st-peters-square.hdr',
    'shanghai-riverside-4k.hdr',
    'wide-street.hdr',
    'empty-room.hdr'
];

// ---- minimal Radiance RGBE file builders, covering the parser's branches ----

const HEADER = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n';

const encodeResolution = (width, height, flipY) => `${flipY ? '-Y' : '+Y'} ${height} +X ${width}\n`;

// encode one scanline channel (width bytes) as RLE run/non-run pairs
const encodeChannel = (channel) => {
    const bytes = [];
    let i = 0;
    while (i < channel.length) {
        let run = 1;
        while (i + run < channel.length && channel[i + run] === channel[i] && run < 127) {
            run++;
        }
        if (run >= 4) {
            bytes.push(128 + run, channel[i]);
            i += run;
        } else {
            const start = i;
            let count = 0;
            while (i < channel.length && count < 128) {
                let nextRun = 1;
                while (i + nextRun < channel.length && channel[i + nextRun] === channel[i]) {
                    nextRun++;
                }
                if (nextRun >= 4) {
                    break;
                }
                count++;
                i++;
            }
            bytes.push(count, ...channel.slice(start, start + count));
        }
    }
    return bytes;
};

// pixels: Uint8Array of width*height RGBA values, row-major top-to-bottom
const buildRleHdr = (pixels, width, height, flipY) => {
    const parts = [Buffer.from(HEADER + encodeResolution(width, height, flipY), 'ascii')];

    for (let y = 0; y < height; y++) {
        const row = pixels.subarray(y * width * 4, (y + 1) * width * 4);
        parts.push(Buffer.from([2, 2, (width >> 8) & 0xff, width & 0xff]));
        for (let c = 0; c < 4; c++) {
            const channel = new Uint8Array(width);
            for (let x = 0; x < width; x++) {
                channel[x] = row[x * 4 + c];
            }
            parts.push(Buffer.from(encodeChannel(channel)));
        }
    }

    return Buffer.concat(parts);
};

const buildFlatHdr = (pixels, width, height, flipY) => Buffer.concat([
    Buffer.from(HEADER + encodeResolution(width, height, flipY), 'ascii'),
    Buffer.from(pixels)
]);

const makePixels = (width, height, seed = 1) => {
    const pixels = new Uint8Array(width * height * 4);
    let state = seed;
    for (let i = 0; i < pixels.length; i++) {
        // deterministic pseudo-random values, biased to create some runs
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        pixels[i] = state % 200;
    }
    return pixels;
};

const toArrayBuffer = (buffer) => {
    // copy into an ArrayBuffer of the current global realm: under jsdom the
    // integration tests swap global.ArrayBuffer, and the parser keys its cache
    // on that realm's ArrayBuffer instances
    const out = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(out).set(buffer);
    return out;
};

describe('HdrParser', function () {

    let parser;
    let errors;

    beforeEach(function () {
        parser = new HdrParser();
        errors = [];
        stub(Debug, 'error').callsFake((...args) => errors.push(args.join(' ')));
    });

    afterEach(function () {
        restore();
    });

    describe('parse and parseAsync produce identical output', function () {

        it('for RLE data with flipY (-Y)', async function () {
            const width = 32;
            const height = 16;
            const pixels = makePixels(width, height);
            const data = toArrayBuffer(buildRleHdr(pixels, width, height, true));

            const sync = parser.parse(data);
            const async = await parser.parseAsync(data);

            expect(async).to.eql(sync);
            expect(Array.from(async.levels[0])).to.eql(Array.from(pixels));
            expect(async.width).to.equal(width);
            expect(async.height).to.equal(height);
        });

        it('for RLE data without flipY (+Y, rows written bottom-to-top)', async function () {
            const width = 32;
            const height = 16;
            const pixels = makePixels(width, height, 7);
            const data = toArrayBuffer(buildRleHdr(pixels, width, height, false));

            const sync = parser.parse(data);
            const async = await parser.parseAsync(data);

            // both code paths agree, and the output is the input flipped vertically
            expect(async).to.eql(sync);
            const expected = new Uint8Array(pixels.length);
            for (let y = 0; y < height; y++) {
                expected.set(
                    pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
                    y * width * 4
                );
            }
            expect(Array.from(async.levels[0])).to.eql(Array.from(expected));
        });

        it('for flat (uncompressed) data', async function () {
            const width = 16;
            const height = 8;
            const pixels = makePixels(width, height, 3);
            const data = toArrayBuffer(buildFlatHdr(pixels, width, height, true));

            const sync = parser.parse(data);
            const async = await parser.parseAsync(data);

            expect(async).to.eql(sync);
            // flat data is returned as a view directly over the file buffer
            expect(async.levels[0]).to.be.an.instanceof(Uint8Array);
            expect(Array.from(async.levels[0])).to.eql(Array.from(pixels));
        });

        it('for all four example 4k images, byte for byte', async function () {
            this.timeout(60000);
            for (const file of HDR_FILES) {
                const data = toArrayBuffer(readFileSync(resolve(HDR_DIR, file)));
                const sync = parser.parse(data);
                // eslint-disable-next-line no-await-in-loop -- the 4k files are checked one at a time, each against its own sync decode
                const async = await parser.parseAsync(data);

                expect(async.width, file).to.equal(sync.width);
                expect(async.height, file).to.equal(sync.height);
                const syncBytes = sync.levels[0];
                const asyncBytes = async.levels[0];
                expect(asyncBytes.length, file).to.equal(syncBytes.length);
                let identical = true;
                for (let i = 0; i < syncBytes.length; i++) {
                    if (syncBytes[i] !== asyncBytes[i]) {
                        identical = false;
                        break;
                    }
                }
                expect(identical, file).to.be.true;
            }
        });

        it('reports every async chunk as a bounded slice of work', async function () {
            const width = 64;
            const height = 64;
            const data = toArrayBuffer(buildRleHdr(makePixels(width, height, 9), width, height, true));

            const chunkTimes = [];
            const result = await parser.parseAsync(data, elapsed => chunkTimes.push(elapsed));

            expect(result).to.not.be.null;
            expect(chunkTimes.length).to.be.greaterThan(0);
            // each reported chunk is a finite, non-negative occupancy
            expect(chunkTimes.every(t => Number.isFinite(t) && t >= 0)).to.be.true;
        });
    });

    describe('branch and error behavior', function () {

        it('rejects a header with invalid magic', async function () {
            const data = toArrayBuffer(Buffer.from('not radiance\n'));
            expect(parser.parse(data)).to.be.null;
            expect(await parser.parseAsync(data)).to.be.null;
            expect(errors[0]).to.include('invalid magic');
        });

        it('rejects a header missing the FORMAT variable', async function () {
            const data = toArrayBuffer(Buffer.from('#?RADIANCE\n\n'));
            expect(parser.parse(data)).to.be.null;
            expect(await parser.parseAsync(data)).to.be.null;
            expect(errors[0]).to.include('missing FORMAT');
        });

        it('rejects an invalid resolution specifier', async function () {
            const data = toArrayBuffer(Buffer.from(`${HEADER}-Y 16\n`));
            expect(parser.parse(data)).to.be.null;
            expect(await parser.parseAsync(data)).to.be.null;
            expect(errors[0]).to.include('invalid resolution');
        });

        it('falls back to flat decoding when the width is out of bounds', async function () {
            const width = 4; // below the minimum RLE width of 8
            const height = 4;
            const pixels = makePixels(width, height);
            const data = toArrayBuffer(buildFlatHdr(pixels, width, height, true));

            const sync = parser.parse(data);
            const async = await parser.parseAsync(data);
            expect(async).to.eql(sync);
            expect(Array.from(async.levels[0])).to.eql(Array.from(pixels));
        });

        it('falls back to flat decoding when the first scanline is not RLE', async function () {
            const width = 16;
            const height = 4;
            const pixels = makePixels(width, height, 11);
            // a flat file with an in-bounds width starts with pixel bytes, not
            // the RLE marker, so the parser rewinds and takes the flat branch
            const data = toArrayBuffer(buildFlatHdr(pixels, width, height, true));

            const sync = parser.parse(data);
            const async = await parser.parseAsync(data);
            expect(async).to.eql(sync);
            expect(Array.from(async.levels[0])).to.eql(Array.from(pixels));
        });

        it('returns null when flat data has an unexpected byte count', async function () {
            const width = 4;
            const height = 4;
            const pixels = makePixels(width, height);
            const truncated = toArrayBuffer(
                Buffer.concat([
                    Buffer.from(HEADER + encodeResolution(width, height, true), 'ascii'),
                    Buffer.from(pixels.subarray(0, pixels.length - 3))
                ])
            );
            expect(parser.parse(truncated)).to.be.null;
            expect(await parser.parseAsync(truncated)).to.be.null;
        });

        it('propagates an out-of-bounds read the same way on both paths', async function () {
            // a valid header/resolution claiming RLE data that is not there makes
            // the stream read past its end
            const data = toArrayBuffer(Buffer.from(`${HEADER}-Y 8 +X 16\n`));

            let syncError;
            try {
                parser.parse(data);
            } catch (err) {
                syncError = err;
            }
            // assert on name/message rather than instanceof: the jsdom integration
            // tests swap the global Error/DataView constructors, so a RangeError
            // thrown here can come from a different realm than global.Error
            expect(syncError).to.exist;
            expect(syncError.name).to.equal('RangeError');

            let asyncError;
            try {
                await parser.parseAsync(data);
            } catch (err) {
                asyncError = err;
            }
            // the async path surfaces the identical failure, as a rejection
            expect(asyncError).to.exist;
            expect(asyncError.name).to.equal('RangeError');
            expect(asyncError.message).to.equal(syncError.message);
        });

        it('rejects an RLE scanline whose width specifier does not match', async function () {
            const width = 16;
            const height = 4;
            const pixels = makePixels(width, height);
            const buffer = buildRleHdr(pixels, width, height, true);

            // find the second scanline's width specifier: after the header, the
            // first scanline header (4 bytes) and its four encoded channels
            const headerBytes = Buffer.from(HEADER + encodeResolution(width, height, true), 'ascii');
            let offset = headerBytes.length + 4;
            const firstRow = pixels.subarray(0, width * 4);
            for (let c = 0; c < 4; c++) {
                const channel = new Uint8Array(width);
                for (let x = 0; x < width; x++) {
                    channel[x] = firstRow[x * 4 + c];
                }
                offset += encodeChannel(channel).length;
            }
            // offset now points at the second scanline header; corrupt its width
            expect(buffer[offset]).to.equal(2);
            buffer[offset + 2] = 0;
            buffer[offset + 3] = 1;

            const data = toArrayBuffer(buffer);
            expect(parser.parse(data)).to.be.null;
            expect(await parser.parseAsync(data)).to.be.null;
            expect(errors.some(e => e.includes('invalid scanline width'))).to.be.true;
        });
    });

    describe('load/open integration', function () {

        let app;

        beforeEach(function () {
            jsdomSetup();
            app = createApp();
            parser.handler = {
                fetch(url, responseType, callback) {
                    callback(null, url.__data);
                }
            };
        });

        afterEach(function () {
            app?.destroy();
            app = null;
            jsdomTeardown();
        });

        // the ResourceLoader always passes the owning asset to load(); the parser
        // records the rgbe type on its data
        const asset = () => ({ data: {} });

        it('sets the rgbe texture type on the asset as loading starts', function () {
            const owningAsset = { data: {} };
            parser.load({ load: 'x.hdr', original: 'x.hdr' }, () => {}, owningAsset);
            expect(owningAsset.data.type).to.equal(TEXTURETYPE_RGBE);
        });

        it('pre-decodes on load and open consumes the cached result', function (done) {
            const width = 32;
            const height = 8;
            const pixels = makePixels(width, height);
            const data = toArrayBuffer(buildRleHdr(pixels, width, height, true));

            parser.load({ load: 'x.hdr', original: 'x.hdr', __data: data }, (err, loaded) => {
                try {
                    expect(err).to.be.null;
                    expect(loaded).to.equal(data);

                    // the decode finished and was cached before the load callback
                    expect(parser._decoded.has(data)).to.be.true;

                    const texture = parser.open('x.hdr', data, app.graphicsDevice);
                    expect(texture).to.exist;
                    expect(texture.width).to.equal(width);
                    expect(texture.height).to.equal(height);

                    // the cached decode is consumed exactly once
                    expect(parser._decoded.has(data)).to.be.false;
                    done();
                } catch (e) {
                    done(e);
                }
            }, asset());
        });

        it('falls back to synchronous parse in open when nothing was cached', function () {
            const width = 32;
            const height = 8;
            const pixels = makePixels(width, height, 5);
            const data = toArrayBuffer(buildRleHdr(pixels, width, height, true));

            const texture = parser.open('x.hdr', data, app.graphicsDevice);
            expect(texture).to.exist;
            expect(texture.width).to.equal(width);
            expect(parser._decoded.has(data)).to.be.false;
        });

        it('open returns null for malformed data that was not pre-decoded', function () {
            const data = toArrayBuffer(Buffer.from('not radiance\n'));
            expect(parser.open('x.hdr', data, app.graphicsDevice)).to.be.null;
        });

        it('reports malformed files through the load callback without throwing', function (done) {
            const data = toArrayBuffer(Buffer.from('not radiance\n'));

            parser.load({ load: 'x.hdr', original: 'x.hdr', __data: data }, (err, loaded) => {
                try {
                    // load still hands the raw bytes back, as the fetch path always
                    // did; the decode failure is logged via Debug.error and recorded as
                    // a null parse result rather than an exception that can crash the page
                    expect(err).to.be.null;
                    expect(loaded).to.equal(data);
                    expect(parser._decoded.has(data)).to.be.false;

                    // open then hits the synchronous fallback and returns the same null
                    // result parse() gives for malformed input
                    expect(parser.open('x.hdr', data, app.graphicsDevice)).to.be.null;
                    done();
                } catch (e) {
                    done(e);
                }
            }, asset());
        });

        it('handles concurrent loads of different buffers independently', function (done) {
            const a = toArrayBuffer(buildRleHdr(makePixels(16, 8, 1), 16, 8, true));
            const b = toArrayBuffer(buildRleHdr(makePixels(16, 8, 2), 16, 8, true));

            let remaining = 2;
            const finish = (err) => {
                if (err) {
                    done(err);
                    return;
                }
                if (--remaining === 0) {
                    try {
                        expect(parser._decoded.has(a)).to.be.true;
                        expect(parser._decoded.has(b)).to.be.true;
                        const textureA = parser.open('a.hdr', a, app.graphicsDevice);
                        const textureB = parser.open('b.hdr', b, app.graphicsDevice);
                        expect(parser._decoded.has(a)).to.be.false;
                        expect(parser._decoded.has(b)).to.be.false;
                        expect(textureA).to.exist;
                        expect(textureB).to.exist;
                        done();
                    } catch (e) {
                        done(e);
                    }
                }
            };

            parser.load({ load: 'a.hdr', original: 'a.hdr', __data: a }, finish, asset());
            parser.load({ load: 'b.hdr', original: 'b.hdr', __data: b }, finish, asset());
        });

        it('repeatedly loading the same buffer replaces rather than duplicates the cache entry', function (done) {
            const data = toArrayBuffer(buildRleHdr(makePixels(16, 8), 16, 8, true));

            parser.load({ load: 'x.hdr', original: 'x.hdr', __data: data }, () => {
                parser.load({ load: 'x.hdr', original: 'x.hdr', __data: data }, (err, loaded) => {
                    try {
                        expect(err).to.be.null;
                        expect(loaded).to.equal(data);
                        // one entry per buffer, no leak of stale results
                        expect(parser._decoded.has(data)).to.be.true;
                        done();
                    } catch (e) {
                        done(e);
                    }
                }, asset());
            }, asset());
        });

        it('does not cache or throw when the fetch itself fails', function (done) {
            const data = new ArrayBuffer(0);
            parser.handler = {
                fetch(url, responseType, callback) {
                    callback(new Error('network down'));
                }
            };

            parser.load({ load: 'x.hdr', original: 'x.hdr', __data: data }, (err) => {
                try {
                    expect(err).to.be.an.instanceof(Error);
                    expect(parser._decoded.has(data)).to.be.false;
                    done();
                } catch (e) {
                    done(e);
                }
            }, asset());
        });
    });
});
