export type TrafficLane = 'standard' | 'flex'

// Both headers: the second alone means "Provisioned Throughput first, then Flex".
export const FLEX_REQUEST_HEADERS: Record<string, string> = {
    'X-Vertex-AI-LLM-Request-Type': 'shared',
    'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
}

// Flex only on a first attempt that has another after it, so every job keeps a Standard attempt: a refused Flex call
// fails the task and Cloud Run's retry runs on Standard. Local runs have a single attempt and always use Standard.
export const chooseTrafficLane = (traffic: TrafficLane, attempt: number, isLast: boolean): TrafficLane =>
    traffic === 'flex' && attempt === 0 && !isLast ? 'flex' : 'standard'
