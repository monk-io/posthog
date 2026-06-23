import { SessionTurn } from './extractSessionTurns'

// Long idle stretches between turns (a user reading a reply, then coming back
// minutes later) are compressed so playback stays watchable — same idea as
// session replay's inactivity skipping.
export const IDLE_CAP_MS = 3000
const MIN_THINK_MS = 600
const THINK_CAP_MS = 12000
// The user's "composing" window before their request appears. Floored so the
// user-side typing indicator is always briefly visible, capped like any idle stretch.
const MIN_USER_THINK_MS = 600

export interface SessionTimelineData {
    // when the turn first appears — the user starts "composing" (shown as a
    // user-side typing indicator before their message lands)
    turnRevealsMs: number[]
    // when the user's request message appears
    turnStartsMs: number[]
    // when the assistant's response appears (= request + the AI "thinking"/latency window)
    turnResponsesMs: number[]
    durationMs: number
}

export function buildSessionTimeline(turns: SessionTurn[]): SessionTimelineData {
    if (!turns.length) {
        return { turnRevealsMs: [], turnStartsMs: [], turnResponsesMs: [], durationMs: 0 }
    }

    const rawStarts = turns.map((t) => new Date(t.trace.createdAt).getTime())
    const latencies = turns.map((t) => Math.round((t.trace.totalLatency ?? 0) * 1000))

    const turnRevealsMs: number[] = []
    const turnStartsMs: number[] = []
    const turnResponsesMs: number[] = []
    let cursor = 0
    turns.forEach((_, i) => {
        // The user's read/think/compose time before the request lands: the real
        // idle gap (for i > 0), floored so the typing indicator shows and capped
        // like any idle stretch. The first turn gets just the floor as a lead-in.
        const rawIdle = i > 0 ? Math.max(rawStarts[i] - (rawStarts[i - 1] + latencies[i - 1]), 0) : 0
        const userThinkMs = Math.min(Math.max(rawIdle, MIN_USER_THINK_MS), IDLE_CAP_MS)
        turnRevealsMs.push(cursor)
        cursor += userThinkMs
        turnStartsMs.push(cursor)
        // the AI "thinking" window — kept real so latency is felt, but floored
        // (always visible) and capped (so a pathologically long call doesn't stall)
        const thinkMs = Math.min(Math.max(latencies[i], MIN_THINK_MS), THINK_CAP_MS)
        cursor += thinkMs
        turnResponsesMs.push(cursor)
    })

    return { turnRevealsMs, turnStartsMs, turnResponsesMs, durationMs: cursor }
}
