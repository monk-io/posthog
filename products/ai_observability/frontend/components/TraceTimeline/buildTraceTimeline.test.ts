import { LLMTraceEvent } from '~/queries/schema/schema-general'

import { buildTraceTimeline } from './buildTraceTimeline'

function ev(id: string, isoOffsetMs: number, latencySec: number, extra: Record<string, any> = {}): LLMTraceEvent {
    return {
        id,
        event: '$ai_generation',
        createdAt: new Date(1_000_000_000_000 + isoOffsetMs).toISOString(),
        properties: { $ai_latency: latencySec, ...extra },
    }
}

describe('buildTraceTimeline', () => {
    it('positions bars by timestamp offset and latency', () => {
        const { bars, totalMs } = buildTraceTimeline([ev('a', 0, 1), ev('b', 2000, 0.5)])
        expect(bars).toHaveLength(2)
        expect(bars[0]).toMatchObject({ id: 'a', startMs: 0, durationMs: 1000 })
        expect(bars[1]).toMatchObject({ id: 'b', startMs: 2000, durationMs: 500 })
        expect(totalMs).toBe(2500)
    })

    it('marks error events', () => {
        const { bars } = buildTraceTimeline([ev('a', 0, 1, { $ai_is_error: true })])
        expect(bars[0].isError).toBe(true)
    })

    it('falls back to sequential layout when timestamps have no spread', () => {
        // both events share the same createdAt — lay them out back-to-back by latency
        const { bars, totalMs } = buildTraceTimeline([ev('a', 0, 1), ev('b', 0, 2)])
        expect(bars[0]).toMatchObject({ startMs: 0, durationMs: 1000 })
        expect(bars[1]).toMatchObject({ startMs: 1000, durationMs: 2000 })
        expect(totalMs).toBe(3000)
    })

    it('returns empty for no events', () => {
        expect(buildTraceTimeline([])).toEqual({ bars: [], totalMs: 0 })
    })
})
