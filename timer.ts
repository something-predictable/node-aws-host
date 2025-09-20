import { measure } from '@riddance/host/lib/timer'
import { getHandlers } from '@riddance/host/registry'
import { triggerTimer } from '@riddance/host/timer'
import { AwsContext, createAwsContext } from './context.js'

export * from '@riddance/service/timer'

// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/b969f890000ff95740fd7b879cdf3b73e1ea0fe8/types/aws-lambda/trigger/eventbridge.d.ts

type EventBridgeEvent = {
    version: '0'
    id: string
    account: string
    time: string
    region: string
    resources: string[]
    source: string
}

async function asyncIndex(
    event: EventBridgeEvent,
    awsContext: AwsContext,
    callback: (error: unknown) => void,
) {
    const [handler] = getHandlers('timer')
    if (!handler) {
        throw new Error('No timer handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        { default: 300 },
        {},
        {
            operationId: event.id,
        },
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn.split(':')[4],
    )

    await triggerTimer(
        log,
        context,
        handler,
        {
            triggerTime: new Date(event.time),
        },
        success,
    )

    try {
        callback(undefined)
    } catch (e) {
        log.fatal('Error sending result to Lambda.', e)
    }

    await measure(log.enrichReserved({ meta: handler.meta }), 'flush', flush)
}

export function awsHandler(
    event: EventBridgeEvent,
    context: AwsContext,
    callback: (error: unknown) => void,
) {
    context.callbackWaitsForEmptyEventLoop = false
    asyncIndex(event, context, callback).catch((e: unknown) => setImmediate(callback, e))
}
