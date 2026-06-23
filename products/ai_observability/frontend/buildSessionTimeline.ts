import { SessionTurn } from './extractSessionTurns'

// Long idle stretches between turns (a user reading a reply, then coming back
// minutes later) are compressed so playback stays watchable — same idea as
// session replay's inactivity skipping.
export const IDLE_CAP_MS = 3000
const MIN_THINK_MS = 600
const THINK_CAP_MS = 12000

export interface SessionTimelineData {
    // when the user's request appears (turn start; long idle gaps between turns are compressed)
    turnStartsMs: number[]
    // when the assistant's response appears (= request + the AI "thinking"/latency window)
    turnResponsesMs: number[]
    durationMs: number
}

export function buildSessionTimeline(turns: SessionTurn[]): SessionTimelineData {
    if (!turns.length) {
        return { turnStartsMs: [], turnResponsesMs: [], durationMs: 0 }
    }

    const rawStarts = turns.map((t) => new Date(t.trace.createdAt).getTime())
    const latencies = turns.map((t) => Math.round((t.trace.totalLatency ?? 0) * 1000))

    const turnStartsMs: number[] = []
    const turnResponsesMs: number[] = []
    let cursor = 0
    turns.forEach((_, i) => {
        if (i > 0) {
            // user read/think/type time between the previous response and this request, capped
            const rawIdle = Math.max(rawStarts[i] - (rawStarts[i - 1] + latencies[i - 1]), 0)
            cursor += Math.min(rawIdle, IDLE_CAP_MS)
        }
        const userMs = cursor
        // the AI "thinking" window — kept real so latency is felt, but floored (always visible)
        // and capped (so a pathologically long call doesn't stall playback)
        const thinkMs = Math.min(Math.max(latencies[i], MIN_THINK_MS), THINK_CAP_MS)
        turnStartsMs.push(userMs)
        turnResponsesMs.push(userMs + thinkMs)
        cursor = userMs + thinkMs
    })

    return { turnStartsMs, turnResponsesMs, durationMs: cursor }
}
