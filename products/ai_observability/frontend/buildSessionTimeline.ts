import { SessionTurn } from './extractSessionTurns'

// Long idle stretches between turns (a user reading a reply, then coming back
// minutes later) are compressed so playback stays watchable — same idea as
// session replay's inactivity skipping.
export const IDLE_CAP_MS = 3000
const MIN_TURN_MS = 400

export interface SessionTimelineData {
    turnStartsMs: number[]
    durationMs: number
}

export function buildSessionTimeline(turns: SessionTurn[]): SessionTimelineData {
    if (!turns.length) {
        return { turnStartsMs: [], durationMs: 0 }
    }

    const rawStarts = turns.map((t) => new Date(t.trace.createdAt).getTime())
    const durations = turns.map((t) => Math.max(Math.round((t.trace.totalLatency ?? 0) * 1000), MIN_TURN_MS))

    const turnStartsMs: number[] = []
    let compressedCursor = 0
    let prevRawEnd = rawStarts[0]

    turns.forEach((_, i) => {
        if (i === 0) {
            turnStartsMs.push(0)
            compressedCursor = durations[0]
            prevRawEnd = rawStarts[0] + durations[0]
            return
        }
        const rawGap = Math.max(rawStarts[i] - prevRawEnd, 0)
        const cappedGap = Math.min(rawGap, IDLE_CAP_MS)
        const start = compressedCursor + cappedGap
        turnStartsMs.push(start)
        compressedCursor = start + durations[i]
        prevRawEnd = rawStarts[i] + durations[i]
    })

    return { turnStartsMs, durationMs: compressedCursor }
}
