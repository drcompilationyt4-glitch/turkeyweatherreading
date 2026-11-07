import { createHash } from 'crypto'

/** Deterministic 0..1 generator (mulberry32) seeded from any string: same seed, same sequence. */
export function seededRandom(seed: string): () => number {
    let state = createHash('sha256').update(seed).digest().readUInt32LE(0)
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/**
 * Runs `fn` with Math.random replaced by `rng`, for libraries that take no seed.
 * Synchronous code only: nothing else can run on the event loop before it returns.
 */
export function withMathRandom<T>(rng: () => number, fn: () => T): T {
    const original = Math.random
    Math.random = rng
    try {
        return fn()
    } finally {
        Math.random = original
    }
}
