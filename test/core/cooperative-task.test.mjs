import { expect } from 'chai';

import { runCooperative } from '../../src/core/cooperative-task.js';

describe('runCooperative', function () {

    it('resolves with the return value of a generator that yields', async function () {
        function *generator() {
            let sum = 0;
            for (let i = 0; i < 100; i++) {
                sum += i;
                yield;
            }
            return sum;
        }

        const result = await runCooperative(generator());
        expect(result).to.equal(4950);
    });

    it('resolves with the return value of a generator that never yields', async function () {
        // eslint-disable-next-line require-yield -- the point is a generator with no work units
        function *generator() {
            return 'done';
        }

        const result = await runCooperative(generator());
        expect(result).to.equal('done');
    });

    it('resolves with null when the generator returns null', async function () {
        function *generator() {
            yield;
            return null;
        }

        const result = await runCooperative(generator());
        expect(result).to.be.null;
    });

    it('rejects when the generator throws', async function () {
        function *generator() {
            yield;
            throw new Error('boom');
        }

        let rejection;
        try {
            await runCooperative(generator());
        } catch (err) {
            rejection = err;
        }
        expect(rejection).to.be.an.instanceof(Error);
        expect(rejection.message).to.equal('boom');
    });

    it('lets the event loop run between chunks while work is in progress', async function () {
        // A generator that yields many times with a small time budget must not
        // run to completion inside a single macrotask: watchers scheduled with
        // setImmediate get to run before it finishes.
        let watcherTicks = 0;
        const watcher = () => {
            watcherTicks++;
        };

        function *generator() {
            for (let i = 0; i < 50; i++) {
                // schedule a watcher each iteration and burn a little time so
                // the time-budget check forces a yield
                setImmediate(watcher);
                const until = Date.now() + 2;
                while (Date.now() < until) {
                    // busy wait
                }
                yield;
            }
            return true;
        }

        await runCooperative(generator(), 1);
        expect(watcherTicks).to.be.greaterThan(1);
    });

    it('completes work spread over many chunks', async function () {
        // many more yields than could fit in one chunk even on a fast machine
        function *generator() {
            const values = [];
            for (let i = 0; i < 500; i++) {
                values.push(i);
                yield;
            }
            return values;
        }

        const result = await runCooperative(generator(), 1);
        expect(result).to.have.length(500);
        expect(result[499]).to.equal(499);
    });
});
