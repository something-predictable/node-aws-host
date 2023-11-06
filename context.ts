/* eslint-disable no-console */
import { ClientInfo, createContext, LogEntry, LogTransport } from '@riddance/host/context'
import { FullConfiguration, Metadata } from '@riddance/host/registry'
import { randomUUID } from 'node:crypto'
import { SnsEventTransport } from './lib/sns.js'

export * from '@riddance/service/context'

export type AwsContext = {
    getRemainingTimeInMillis(): number
    readonly functionName: string
    readonly functionVersion: string
    readonly invokedFunctionArn: string
    readonly memoryLimitInMB: number
    readonly awsRequestId: string
    readonly logGroupName: string
    readonly logStreamName: string
    callbackWaitsForEmptyEventLoop: boolean
}

class ConsoleLogger implements LogTransport {
    sendEntries(entries: LogEntry[]) {
        for (const entry of entries) {
            switch (entry.level) {
                case 'trace':
                case 'debug':
                    console.debug(entry.json)
                    break
                case 'info':
                    console.log(entry.json)
                    break
                case 'warning':
                    console.warn(entry.json)
                    break
                case 'error':
                case 'fatal':
                    console.error(entry.json)
                    break
            }
        }
        return undefined
    }
}

const consoleLogger = new ConsoleLogger()

const hostInfo = {
    instance: {
        id: randomUUID().replaceAll('-', ''),
    },
    nodejs: {
        version: process.version.substring(1),
    },
    function: {
        version: process.env.AWS_LAMBDA_FUNCTION_VERSION,
        executionEnvironment: process.env.AWS_EXECUTION_ENV,
    },
}

export function createAwsContext(
    context: AwsContext,
    stageVariables: { [key: string]: string },
    client: ClientInfo,
    config?: FullConfiguration,
    meta?: Metadata,
) {
    const ctx = createContext(
        client,
        [consoleLogger],
        new SnsEventTransport(),
        { default: 15 },
        new AbortController(),
        config,
        meta,
        {
            ...process.env,
            ...stageVariables,
        } as { [key: string]: string },
    )
    ctx.log.enrichReserved({
        host: hostInfo,
        function: {
            name: context.functionName,
            version: context.functionVersion,
            memoryLimit: context.memoryLimitInMB,
            timeout: context.getRemainingTimeInMillis(),
        },
    })
    return ctx
}
