import { useState } from 'react'

import { IconChevronDown } from '@posthog/icons'
import { LemonButton, Tooltip } from '@posthog/lemon-ui'

import { cn } from 'lib/utils/css-classes'
import { humanFriendlyMilliseconds } from 'lib/utils/durations'

import { LLMTraceEvent } from '~/queries/schema/schema-general'

import { TraceBarKind, buildTraceTimeline } from './buildTraceTimeline'

const KIND_CLASS: Record<TraceBarKind, string> = {
    generation: 'bg-success',
    span: 'bg-primary',
    embedding: 'bg-warning',
    other: 'bg-muted',
}

export function TraceTimeline({
    events,
    selectedEventId,
    onSelectEvent,
}: {
    events: LLMTraceEvent[]
    selectedEventId: string | null
    onSelectEvent: (id: string) => void
}): JSX.Element | null {
    const [collapsed, setCollapsed] = useState(false)
    const { bars, totalMs } = buildTraceTimeline(events)

    if (!bars.length || totalMs <= 0) {
        return null
    }

    return (
        <div className="border rounded bg-surface-primary">
            <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-xs font-semibold text-muted">Timeline</span>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">{humanFriendlyMilliseconds(totalMs)}</span>
                    <LemonButton
                        size="xsmall"
                        icon={<IconChevronDown className={cn('transition-transform', collapsed && '-rotate-90')} />}
                        onClick={() => setCollapsed((c) => !c)}
                        aria-label={collapsed ? 'Expand timeline' : 'Collapse timeline'}
                    />
                </div>
            </div>
            {!collapsed && (
                <div className="relative h-12 mx-3 mb-3">
                    {bars.map((bar) => {
                        const leftPct = (bar.startMs / totalMs) * 100
                        const widthPct = Math.max((bar.durationMs / totalMs) * 100, 0.5)
                        return (
                            <Tooltip key={bar.id} title={`${bar.label} · ${humanFriendlyMilliseconds(bar.durationMs)}`}>
                                <button
                                    type="button"
                                    onClick={() => onSelectEvent(bar.id)}
                                    className={cn(
                                        'absolute top-1/2 -translate-y-1/2 h-4 rounded-sm cursor-pointer',
                                        KIND_CLASS[bar.kind],
                                        bar.isError && 'ring-1 ring-danger',
                                        selectedEventId === bar.id && 'ring-2 ring-accent'
                                    )}
                                    // eslint-disable-next-line react/forbid-dom-props
                                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                                    data-attr="trace-timeline-bar"
                                />
                            </Tooltip>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
