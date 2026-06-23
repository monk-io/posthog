import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { sessionPlaybackLogicType } from './sessionPlaybackLogicType'

export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2, 3, 4, 8, 16]
const TICK_MS = 50

export interface SessionPlaybackLogicProps {
    sessionId: string
}

export const sessionPlaybackLogic = kea<sessionPlaybackLogicType>([
    path(['products', 'ai_observability', 'frontend', 'sessionPlaybackLogic']),
    props({} as SessionPlaybackLogicProps),
    key((props) => props.sessionId),

    actions({
        play: true,
        pause: true,
        togglePlay: true,
        seek: (ms: number) => ({ ms }),
        setSpeed: (speed: number) => ({ speed }),
        setTimeline: (turnStartsMs: number[], durationMs: number) => ({ turnStartsMs, durationMs }),
        tick: (deltaMs: number) => ({ deltaMs }),
        // internal: advance the playhead without pausing (the user-facing `seek` pauses)
        setCurrentMs: (ms: number) => ({ ms }),
    }),

    reducers({
        playing: [false, { play: () => true, pause: () => false, seek: () => false }],
        speed: [1, { setSpeed: (_, { speed }) => speed }],
        durationMs: [0, { setTimeline: (_, { durationMs }) => durationMs }],
        turnStartsMs: [[] as number[], { setTimeline: (_, { turnStartsMs }) => turnStartsMs }],
        currentMs: [
            0,
            {
                seek: (_, { ms }) => Math.max(ms, 0),
                setCurrentMs: (_, { ms }) => Math.max(ms, 0),
                setTimeline: () => 0,
            },
        ],
    }),

    selectors({
        visibleTurnIndex: [
            (s) => [s.turnStartsMs, s.currentMs],
            (turnStartsMs: number[], currentMs: number): number => {
                let idx = 0
                for (let i = 0; i < turnStartsMs.length; i++) {
                    if (turnStartsMs[i] <= currentMs) {
                        idx = i
                    }
                }
                return idx
            },
        ],
        progress: [
            (s) => [s.currentMs, s.durationMs],
            (currentMs: number, durationMs: number): number => (durationMs > 0 ? currentMs / durationMs : 0),
        ],
    }),

    listeners(({ actions, values, cache }) => ({
        togglePlay: () => (values.playing ? actions.pause() : actions.play()),
        // a manual scrub pauses playback and stops the ticker
        seek: () => cache.disposables.dispose('playback-tick'),
        tick: ({ deltaMs }) => {
            const next = Math.min(values.currentMs + deltaMs * values.speed, values.durationMs)
            actions.setCurrentMs(next)
            if (next >= values.durationMs) {
                actions.pause()
            }
        },
        play: () => {
            // restart from the beginning if we're already at the end
            if (values.currentMs >= values.durationMs) {
                actions.setCurrentMs(0)
            }
            cache.disposables.add(() => {
                const id = setInterval(() => actions.tick(TICK_MS), TICK_MS)
                return () => clearInterval(id)
            }, 'playback-tick')
        },
        pause: () => cache.disposables.dispose('playback-tick'),
    })),
])
