import { chooseTrafficLane } from './traffic-lane'

describe('chooseTrafficLane', () => {
    it('uses Flex only on the first of several attempts', () => {
        expect(chooseTrafficLane('flex', 0, false)).toBe('flex')
        expect(chooseTrafficLane('flex', 1, false)).toBe('standard')
        expect(chooseTrafficLane('flex', 2, true)).toBe('standard')
    })

    it('keeps a single attempt on Standard, so a job without retries never depends on Flex', () => {
        expect(chooseTrafficLane('flex', 0, true)).toBe('standard')
    })

    it('never uses Flex when traffic is standard', () => {
        expect(chooseTrafficLane('standard', 0, false)).toBe('standard')
    })
})
