import { LLMTraceEvent } from '~/queries/schema/schema-general'

export type TraceBarKind = 'generation' | 'span' | 'embedding' | 'other'

export interface TraceTimelineBar {
    id: string
    label: string
    startMs: number
    durationMs: number
    kind: TraceBarKind
    isError: boolean
}

export interface TraceTimelineData {
    bars: TraceTimelineBar[]
    totalMs: number
}

function kindOf(event: string): TraceBarKind {
    if (event.includes('generation')) {
        return 'generation'
    }
    if (event.includes('embedding')) {
        return 'embedding'
    }
    if (event.includes('span')) {
        return 'span'
    }
    return 'other'
}

function labelOf(event: LLMTraceEvent): string {
    const p = event.properties || {}
    return p.$ai_span_name || p.$ai_model || event.event || event.id
}

export function buildTraceTimeline(events: LLMTraceEvent[]): TraceTimelineData {
    if (!events.length) {
        return { bars: [], totalMs: 0 }
    }

    const times = events.map((e) => new Date(e.createdAt).getTime())
    const traceStart = Math.min(...times)
    const hasSpread = Math.max(...times) - traceStart > 0

    let cursor = 0
    const bars: TraceTimelineBar[] = events.map((event, i) => {
        const durationMs = Math.round((event.properties?.$ai_latency ?? 0) * 1000)
        // With real timestamp spread, position by wall-clock; otherwise lay out
        // sequentially so a poorly-instrumented trace still reads as a waterfall.
        const startMs = hasSpread ? times[i] - traceStart : cursor
        cursor = startMs + durationMs
        return {
            id: event.id,
            label: labelOf(event),
            startMs,
            durationMs,
            kind: kindOf(event.event),
            isError: !!event.properties?.$ai_is_error,
        }
    })

    const totalMs = Math.max(...bars.map((b) => b.startMs + b.durationMs), 0)
    return { bars, totalMs }
}
