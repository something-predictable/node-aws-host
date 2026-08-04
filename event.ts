import type { ClientInfo } from '@riddance/host/context'
import { handle } from '@riddance/host/event'
import { measure, type Json } from '@riddance/host/lib/event'
import { getHandlers } from '@riddance/host/registry'
import { brotliDecompress } from 'node:zlib'
import { AwsContext, createAwsContext, missing } from './context.js'

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

export async function awsHandler(event: SNSEvent, awsContext: AwsContext) {
    const [handler] = getHandlers('event')
    if (!handler) {
        throw new Error('No event handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        { default: 150 },
        {},
        clientFromAttributes(event.Records[0]?.Sns.MessageAttributes),
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn.split(':', 5)[4],
    )

    const events = await Promise.allSettled(
        event.Records.map(async r => ({
            subject: r.Sns.Subject ?? missing('subject'),
            timestamp: new Date(r.Sns.Timestamp),
            messageId: r.Sns.MessageId,
            event: await eventFromMessage(r.Sns.Message, r.Sns.MessageAttributes),
        })),
    )
    const malformedEvents = events.filter(e => e.status === 'rejected')
    for (const failed of malformedEvents) {
        log.fatal('Error parsing event.', failed.reason)
    }

    const sent = await Promise.allSettled(
        events
            .filter(e => e.status === 'fulfilled')
            .map(e => handle(log, context, handler, e.value, success)),
    )
    const notSent = sent.filter(e => e.status === 'rejected')
    for (const failed of notSent) {
        log.fatal('Error sending event.', failed.reason)
    }
    if (
        malformedEvents.length !== 0 ||
        notSent.length !== 0 ||
        sent.some(e => e.status === 'fulfilled' && !e.value)
    ) {
        await measure(log, 'flush', flush)
        throw new AggregateError([...malformedEvents, ...notSent], 'Error handling event.')
    }

    await measure(log.enrichReserved({ meta: handler.meta }), 'flush', flush)
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

async function eventFromMessage(message: string, attributes?: SNSMessageAttributes) {
    if (!message) {
        return undefined
    }

    const messageToParse = await getMessageToParse(message, attributes)
    return JSON.parse(messageToParse) as {
        readonly [key: string]: Json
    }
}

async function getMessageToParse(message: string, attributes?: SNSMessageAttributes) {
    const isCompressed = attributes?.['content-encoding']?.Value === 'br'
    if (!isCompressed) {
        return message
    }
    const decompressed = await decompress(Buffer.from(message, 'base64'))
    return decompressed.toString('utf-8')
}

function decompress(data: Buffer) {
    return new Promise<Buffer>((resolve, reject) => {
        brotliDecompress(data, (err, result) => {
            if (err) {
                reject(err)
                return
            }
            resolve(result)
        })
    })
}
