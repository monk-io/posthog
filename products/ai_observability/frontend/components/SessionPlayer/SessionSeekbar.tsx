import { useRef } from 'react'

import { cn } from 'lib/utils/css-classes'

// A session-replay-style scrubber: a single track with a progress fill, turn
// ticks, and a draggable playhead. Clicking/dragging seeks; clicking a tick
// jumps to that turn.
export function SessionSeekbar({
    durationMs,
    currentMs,
    turnStartsMs,
    onSeek,
}: {
    durationMs: number
    currentMs: number
    turnStartsMs: number[]
    onSeek: (ms: number) => void
}): JSX.Element {
    const trackRef = useRef<HTMLDivElement>(null)

    const seekFromClientX = (clientX: number): void => {
        const el = trackRef.current
        if (!el || durationMs <= 0) {
            return
        }
        const rect = el.getBoundingClientRect()
        const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
        onSeek(fraction * durationMs)
    }

    const at = (ms: number): number => (durationMs > 0 ? (ms / durationMs) * 100 : 0)
    const progressPct = at(currentMs)

    return (
        <div
            ref={trackRef}
            className="relative h-3 w-full rounded-full bg-border cursor-pointer select-none"
            onPointerDown={(e) => {
                ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
                seekFromClientX(e.clientX)
            }}
            onPointerMove={(e) => {
                if (e.buttons === 1) {
                    seekFromClientX(e.clientX)
                }
            }}
            data-attr="session-seekbar"
        >
            <div
                className="absolute left-0 top-0 h-full rounded-full bg-accent"
                // eslint-disable-next-line react/forbid-dom-props
                style={{ width: `${progressPct}%` }}
            />
            {turnStartsMs.map((startMs, i) => (
                <button
                    key={i}
                    type="button"
                    aria-label={`Jump to turn ${i + 1}`}
                    onClick={(e) => {
                        e.stopPropagation()
                        onSeek(startMs)
                    }}
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-3.5 rounded-full bg-muted hover:bg-default"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ left: `${at(startMs)}%` }}
                />
            ))}
            <div
                className={cn(
                    'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent shadow'
                )}
                // eslint-disable-next-line react/forbid-dom-props
                style={{ left: `${progressPct}%` }}
            />
        </div>
    )
}
