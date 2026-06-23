import { expectLogic } from 'kea-test-utils'

import { initKeaTests } from '~/test/init'

import { sessionPlaybackLogic } from './sessionPlaybackLogic'

describe('sessionPlaybackLogic', () => {
    let logic: ReturnType<typeof sessionPlaybackLogic.build>

    beforeEach(() => {
        initKeaTests()
        jest.useFakeTimers()
        logic = sessionPlaybackLogic({ sessionId: 's1' })
        logic.mount()
        logic.actions.setTimeline([0, 2000, 5000], 6000)
    })

    afterEach(() => {
        logic.unmount()
        jest.useRealTimers()
    })

    it('seeks to an absolute position and pauses', async () => {
        await expectLogic(logic, () => logic.actions.seek(2500)).toMatchValues({ currentMs: 2500, playing: false })
    })

    it('tracks the visible turn index from the playhead', async () => {
        logic.actions.seek(2100)
        await expectLogic(logic).toMatchValues({ visibleTurnIndex: 1 })
        logic.actions.seek(5000)
        await expectLogic(logic).toMatchValues({ visibleTurnIndex: 2 })
    })

    it('advances on tick scaled by speed and stops at the end', async () => {
        logic.actions.setSpeed(2)
        logic.actions.play()
        logic.actions.tick(1000) // 1000ms * 2x = 2000ms
        await expectLogic(logic).toMatchValues({ currentMs: 2000, playing: true })
        logic.actions.tick(10_000) // clamps to duration, then pauses
        await expectLogic(logic).toMatchValues({ currentMs: 6000, playing: false })
    })
})
