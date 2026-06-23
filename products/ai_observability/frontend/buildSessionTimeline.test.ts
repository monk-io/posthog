import { LLMTrace } from '~/queries/schema/schema-general'

import { IDLE_CAP_MS, buildSessionTimeline } from './buildSessionTimeline'
import { SessionTurn } from './extractSessionTurns'

function turn(offsetMs: number, latencySec: number): SessionTurn {
    return {
        trace: {
            id: `t-${offsetMs}`,
            createdAt: new Date(1_000_000_000_000 + offsetMs).toISOString(),
            totalLatency: latencySec,
        } as LLMTrace,
        isLoaded: true,
        newInputs: [],
        outputs: [],
        tools: [],
        errors: [],
    }
}

describe('buildSessionTimeline', () => {
    it('positions turns by elapsed time and includes latency in duration', () => {
        const { turnStartsMs, durationMs } = buildSessionTimeline([turn(0, 1), turn(2000, 0.5)])
        expect(turnStartsMs).toEqual([0, 2000])
        expect(durationMs).toBe(2500)
    })

    it('caps long idle gaps between turns', () => {
        // 60s real gap collapses to IDLE_CAP_MS
        const { turnStartsMs } = buildSessionTimeline([turn(0, 1), turn(61_000, 1)])
        expect(turnStartsMs[1]).toBe(1000 + IDLE_CAP_MS)
    })

    it('handles a single turn', () => {
        expect(buildSessionTimeline([turn(0, 2)])).toMatchObject({ turnStartsMs: [0], durationMs: 2000 })
    })

    it('returns empty for no turns', () => {
        expect(buildSessionTimeline([])).toEqual({ turnStartsMs: [], durationMs: 0 })
    })
})
