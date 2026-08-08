import {
    ClientInfo,
    createContext,
    LogEntry,
    LogTransport,
    type EventTransport,
} from '@riddance/host/context'
import { FullConfiguration, Metadata } from '@riddance/host/registry'
import type { Environment } from '@riddance/service/context'
import { randomUUID } from 'node:crypto'
import { SnsEventTransport } from './lib/sns.js'

export { setMeta } from '@riddance/host/registry'
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

/* eslint-disable no-console */
class ConsoleLogger implements LogTransport {
    sendEntries(entries: LogEntry[]) {
        for (const entry of entries) {
            consoleLogEntry(entry)
        }
        return undefined
    }
}

function consoleLogEntry(entry: LogEntry) {
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

const consoleLogger = new ConsoleLogger()

const hostInfo = {
    instance: {
        id: randomUUID().replaceAll('-', ''),
    },
    nodejs: {
        version: process.version.slice(1),
    },
    environment: process.env.AWS_EXECUTION_ENV,
}

export function createAwsContext(
    context: AwsContext,
    timeouts: {
        default: number
        cap?: number
    },
    stageVariables: { [key: string]: string },
    client: ClientInfo,
    config: FullConfiguration | undefined,
    meta: Metadata | undefined,
    functionArn: string,
) {
    const env = {
        ...process.env,
        ...stageVariables,
    }
    const ctx = createContext(
        client,
        [consoleLogger],
        getEventTransport(client, env, meta, functionArn),
        timeouts,
        new AbortController(),
        config,
        meta,
        env,
    )
    ctx.log = ctx.log.enrichReserved({
        host: hostInfo,
        function: {
            name: context.functionName,
            memory: context.memoryLimitInMB,
            timeout: context.getRemainingTimeInMillis(),
        },
    })
    return ctx
}

function getEventTransport(
    client: ClientInfo,
    env: Partial<Environment>,
    meta: Metadata | undefined,
    functionArn: string,
) {
    try {
        return new SnsEventTransport(client, env, meta, functionArn)
    } catch (e) {
        return new ErrorEventTransport(e)
    }
}

class ErrorEventTransport implements EventTransport {
    readonly #error: unknown

    constructor(error: unknown) {
        this.#error = error
    }

    sendEvent() {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(this.#error)
    }
}
