import { EventTransport } from '@riddance/host/context'

export class SnsEventTransport implements EventTransport {
    sendEvent() {
        return Promise.resolve()
    }
}
