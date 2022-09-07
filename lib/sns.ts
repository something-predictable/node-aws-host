import { BufferedEvent, EventTransport } from '@riddance/host/context'

export class SnsEventTransport implements EventTransport {
    readonly publishRate = 100

    sendEvents(_topic: string, _events: BufferedEvent[]) {
        return Promise.resolve()
    }
}
