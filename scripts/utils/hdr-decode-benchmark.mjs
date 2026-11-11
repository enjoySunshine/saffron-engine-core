#!/usr/bin/env node
/**
 * Benchmark for the CPU side of .hdr (Radiance RGBE) texture decoding.
 *
 * Reports, for each image:
 *  - total:   wall-clock time from being handed the file bytes to the decoded
 *             texture data being available (median over --runs)
 *  - longest block: the longest single synchronous work chunk a decode causes,
 *             measured directly per chunk. Under heavy machine load the OS can
 *             preempt the process inside a chunk, inflating this wall-clock
 *             number beyond the time the engine itself occupies the thread.
 *  - median block: the typical chunk length across all chunks and runs, which is
 *             insensitive to occasional preemption and shows the real bound.
 *
 * The synchronous HdrParser#parse runs in one chunk, so its block equals the
 * total decode time. HdrParser#parseAsync (when the engine version provides it)
 * splits the same decode into chunks that yield to the event loop; onChunk
 * reports each chunk's real occupancy.
 *
 * Every run is also byte-checked against the first decode, so a regression that
 * changes the decoded pixels fails the benchmark.
 *
 * Usage:
 *   node --expose-gc scripts/utils/hdr-decode-benchmark.mjs [file.hdr ...]
 *   node --expose-gc scripts/utils/hdr-decode-benchmark.mjs --runs 7 [file.hdr ...]
 *
 * Defaults to the four 4k example HDRIs used for regression testing.
 */
import { readFile } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HdrParser } from '../../src/framework/parsers/texture/hdr.js';
import { now } from '../../src/core/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILES = [
    '../../examples/assets/hdri/st-peters-square.hdr',
    '../../examples/assets/hdri/shanghai-riverside-4k.hdr',
    '../../examples/assets/hdri/wide-street.hdr',
    '../../examples/assets/hdri/empty-room.hdr'
];

const args = process.argv.slice(2);
let runs = 7;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') {
        runs = parseInt(args[++i], 10);
    } else {
        files.push(args[i]);
    }
}
if (files.length === 0) {
    files.push(...DEFAULT_FILES.map(f => resolve(__dirname, f)));
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

async function runOne(file) {
    const data = await readFile(file);
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const parser = new HdrParser();

    // reference decode used to byte-check every subsequent run
    const reference = parser.parse(arrayBuffer);
    if (!reference || !reference.levels || !(reference.levels[0] instanceof Uint8Array)) {
        throw new Error(`${basename(file)}: parse returned no pixel data`);
    }
    const refBytes = reference.levels[0];

    // ---- synchronous path: one continuous chunk, so block equals total ----
    const syncTotals = [];
    for (let i = 0; i < runs; i++) {
        const t0 = now();
        const result = parser.parse(arrayBuffer);
        const total = now() - t0;
        if (!sameBytes(result.levels[0], refBytes)) {
            throw new Error(`${basename(file)}: sync decoded pixels differ across runs`);
        }
        syncTotals.push(total);
        global.gc?.();
    }

    const row = {
        file: basename(file),
        width: reference.width,
        height: reference.height,
        sync: {
            total: median(syncTotals).toFixed(1),
            // a synchronous parse occupies the thread for its whole duration
            maxBlock: median(syncTotals).toFixed(1)
        },
        async: null
    };

    // ---- asynchronous cooperative path ----
    if (typeof parser.parseAsync === 'function') {
        const asyncTotals = [];
        const asyncMaxBlocks = [];
        const chunkCounts = [];
        // every chunk time from every run, so the typical chunk size can be
        // reported separately from the single worst (preemption-skewed) one
        const allChunkTimes = [];

        for (let i = 0; i < runs; i++) {
            let maxBlock = 0;
            let chunkCount = 0;
            const t0 = now();
            // eslint-disable-next-line no-await-in-loop -- timed runs must be serial so each median measures one decode at a time
            const result = await parser.parseAsync(arrayBuffer, (elapsed) => {
                chunkCount++;
                allChunkTimes.push(elapsed);
                if (elapsed > maxBlock) {
                    maxBlock = elapsed;
                }
            });
            const total = now() - t0;

            if (result.width !== reference.width || result.height !== reference.height ||
                !sameBytes(result.levels[0], refBytes)) {
                throw new Error(`${basename(file)}: async decoded pixels differ from sync output`);
            }
            asyncTotals.push(total);
            asyncMaxBlocks.push(maxBlock);
            chunkCounts.push(chunkCount);
            global.gc?.();
        }

        const sortedChunkTimes = [...allChunkTimes].sort((a, b) => a - b);
        row.async = {
            total: median(asyncTotals).toFixed(1),
            maxBlock: Math.max(...asyncMaxBlocks).toFixed(1),
            medianBlock: sortedChunkTimes[Math.floor(sortedChunkTimes.length / 2)].toFixed(2),
            chunks: median(chunkCounts)
        };
    }

    return row;
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
    console.log(`HDR decode benchmark (${runs} runs per image, medians; times in ms)`);
    console.log('');
    for (const file of files) {
        // eslint-disable-next-line no-await-in-loop -- report one image at a time to keep the output ordered
        const row = await runOne(resolve(file));
        console.log(`${pad(row.file, 28)} ${row.width}x${row.height}`);
        console.log(`  ${pad('sync parse', 26)} total ${pad(row.sync.total, 10)} longest main-thread block ${row.sync.maxBlock}`);
        if (row.async) {
            console.log(`  ${pad('async parse', 26)} total ${pad(row.async.total, 10)} longest block ${pad(row.async.maxBlock, 8)} median block ${pad(row.async.medianBlock, 7)} (${row.async.chunks} chunks)`);
        } else {
            console.log('  async parse                  (not available in this engine version)');
        }
        console.log('');
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
