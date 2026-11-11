import { now } from './time.js';

// Schedules a callback as a macrotask without the minimum-delay clamping that
// setTimeout applies. In Node (where the engine tests run) setImmediate is the
// direct equivalent; in browsers a MessageChannel macrotask is used, created on
// demand and closed again once the work finishes so nothing outlives it.
let schedule;
let dispose;
if (typeof setImmediate === 'function') {
    schedule = callback => setImmediate(callback);
    dispose = () => { };
} else if (typeof MessageChannel !== 'undefined') {
    let channel = null;
    const pending = new Map();
    let nextId = 1;

    schedule = (callback) => {
        if (!channel) {
            channel = new MessageChannel();
            channel.port1.onmessage = (event) => {
                const id = event.data;
                const queued = pending.get(id);
                if (queued) {
                    pending.delete(id);
                    queued();
                }
            };
        }
        const id = nextId++;
        pending.set(id, callback);
        channel.port2.postMessage(id);
    };

    // drop the channel once a task has fully drained, so an idle scheduler does
    // not keep any browser-side resources around
    dispose = () => {
        if (channel && pending.size === 0) {
            channel.port1.close();
            channel.port2.close();
            channel = null;
        }
    };
} else {
    schedule = callback => setTimeout(callback, 0);
    dispose = () => { };
}

/**
 * Drives a generator to completion, yielding back to the event loop whenever
 * the accumulated time spent in the current chunk reaches `timeBudget`. This
 * keeps any single continuous occupancy of the calling thread (the main
 * thread in browsers) bounded, so long-running CPU work such as decoding a
 * large image does not make the page unresponsive.
 *
 * The generator does the work and yields after each independently resumable
 * unit (for example an image scanline). It should return its final result, or
 * `null` to signal failure. Thrown exceptions propagate to the returned
 * promise.
 *
 * @param {Generator} generator - The generator producing the work units.
 * @param {number} [timeBudget] - The maximum number of milliseconds of work
 * done before yielding to the event loop. The actual occupancy of a chunk can
 * slightly exceed this, as the check only runs between work units, so the
 * budget is kept below the target block length.
 * @param {(elapsedMs: number) => void} [onChunk] - Optional observer invoked
 * after each synchronous chunk of work with the time that chunk occupied the
 * thread. Used for measurements; it does not affect scheduling.
 * @returns {Promise<*>} The value the generator returns when finished.
 * @ignore
 */
function runCooperative(generator, timeBudget = 10, onChunk) {
    return new Promise((resolve, reject) => {
        const finish = (settle, value) => {
            dispose();
            settle(value);
        };

        const step = () => {
            const chunkStart = now();
            try {
                let result;
                do {
                    result = generator.next();
                    if (result.done) {
                        onChunk?.(now() - chunkStart);
                        finish(resolve, result.value);
                        return;
                    }
                } while (now() - chunkStart < timeBudget);

                onChunk?.(now() - chunkStart);
                // the time budget for this chunk is spent: let the event loop
                // run before continuing the generator
                schedule(step);
            } catch (err) {
                onChunk?.(now() - chunkStart);
                finish(reject, err);
            }
        };
        step();
    });
}

export { runCooperative };
