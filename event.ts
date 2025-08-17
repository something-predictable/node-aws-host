import type { ClientInfo } from '@riddance/host/context'
import { handle } from '@riddance/host/event'
import { measure, type Json } from '@riddance/host/lib/event'
import { getHandlers } from '@riddance/host/registry'
import { AwsContext, createAwsContext } from './context.js'

export { setMeta } from '@riddance/host/registry'
export * from '@riddance/service/event'

// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/b969f890000ff95740fd7b879cdf3b73e1ea0fe8/types/aws-lambda/trigger/sns.d.ts

type SNSMessageAttribute = {
    Type: string
    Value: string
}

type SNSMessageAttributes = {
    [name: string]: SNSMessageAttribute
}

type SNSMessage = {
    SignatureVersion: string
    Timestamp: string
    Signature: string
    SigningCertUrl: string
    MessageId: string
    Message: string
    MessageAttributes: SNSMessageAttributes
    Type: string
    UnsubscribeUrl: string
    TopicArn: string
    Subject?: string
    Token?: string
}

type SNSEventRecord = {
    EventVersion: string
    EventSubscriptionArn: string
    EventSource: string
    Sns: SNSMessage
}

type SNSEvent = {
    Records: SNSEventRecord[]
}

async function asyncIndex(
    event: SNSEvent,
    awsContext: AwsContext,
    callback: (error: unknown) => void,
) {
    const [handler] = getHandlers('event')
    if (!handler) {
        throw new Error('No event handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        {},
        clientFromAttributes(event.Records[0]?.Sns.MessageAttributes),
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn.split(':')[4],
    )

    try {
        await Promise.all(
            event.Records.map(r =>
                handle(
                    log,
                    context,
                    handler,
                    {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        subject: r.Sns.Subject!,
                        timestamp: new Date(r.Sns.Timestamp),
                        messageId: r.Sns.MessageId,
                        event: eventFromMessage(r.Sns.Message),
                    },
                    success,
                ),
            ),
        )
        try {
            callback(undefined)
        } catch (e) {
            log.fatal('Error success result to Lambda.', e)
        }
    } catch (e) {
        try {
            callback(e)
        } catch (ex) {
            log.fatal('Error sending error result to Lambda.', ex)
        }
    }

    await measure(log, 'flush', flush)
}

function clientFromAttributes(attributes: SNSMessageAttributes | undefined): ClientInfo {
    if (!attributes) {
        return {}
    }
    return {
        clientId: attributes.clientId?.Value,
        clientIp: attributes.clientIp?.Value,
        clientPort: Number(attributes.clientPort?.Value) || undefined,
        operationId: attributes.operationId?.Value,
        userAgent: attributes.userAgent?.Value,
    }
}

function eventFromMessage(message: string) {
    if (!message) {
        return undefined
    }
    return JSON.parse(message) as {
        readonly [key: string]: Json
    }
}

export function awsHandler(
    event: SNSEvent,
    context: AwsContext,
    callback: (error: unknown) => void,
) {
    context.callbackWaitsForEmptyEventLoop = false
    asyncIndex(event, context, callback).catch((e: unknown) => setImmediate(callback, e))
}
