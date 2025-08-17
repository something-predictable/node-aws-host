import { fetchOK, missing } from '@riddance/fetch'
import { EventTransport, type ClientInfo } from '@riddance/host/context'
import type { Metadata } from '@riddance/host/registry'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac, randomUUID, type Hash } from 'node:crypto'
import type { Environment, Json } from '../context.js'

export class SnsEventTransport implements EventTransport {
    readonly #attributes: { [key: string]: string }
    readonly #env: Environment
    readonly #baseUrl: string
    readonly #baseArn: string

    constructor(
        client: ClientInfo,
        context: { env: Environment; meta?: Metadata },
        account: string,
    ) {
        this.#attributes = asMessageAttributes(client)
        this.#env = context.env
        const region = context.env.AWS_REGION ?? 'us-east-1'
        this.#baseUrl = `https://sns.${region}.amazonaws.com`
        const prefix =
            context.env.AWS_LAMBDA_FUNCTION_NAME?.slice(
                0,
                -(context.meta?.packageName.length ?? 0) - (context.meta?.fileName.length ?? 0) - 2,
            ) ?? 'AWS_LAMBDA_FUNCTION_NAME-missing'
        this.#baseArn = `arn:aws:sns:${region}:${account}:${prefix}-`
    }

    async sendEvent(
        topic: string,
        type: string,
        subject: string,
        data:
            | {
                  readonly [key: string]: Json
              }
            | undefined,
        messageId: string | undefined,
        signal: AbortSignal,
    ) {
        try {
            await awsFetchOK(
                this.#env,
                this.#baseUrl,
                {
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded',
                        'x-amz-date': new Date().toISOString(),
                    },
                    method: 'POST',
                    body: new URLSearchParams({
                        Version: '2010-03-31',
                        Action: 'Publish',
                        TopicArn: `${this.#baseArn}${topic}-${type}`,
                        Message: JSON.stringify(data),
                        Subject: subject,
                        MessageId: messageId ?? randomUUID().replaceAll('-', ''),
                        Type: type,
                        ...this.#attributes,
                    }).toString(),
                    signal,
                },
                'Error publishing SNS message.',
                { topic, type, data },
            )
        } catch (e) {
            if ((e as { status?: unknown }).status !== 404) {
                throw e
            }
        }
    }
}

function asMessageAttributes(obj: { [key: string]: string | number | undefined }) {
    return Object.fromEntries(
        Object.entries(obj)
            .filter(withoutUndefinedValue)
            .flatMap(([k, v], ix) => [
                [`MessageAttributes.entry.${ix + 1}.Name`, k],
                [
                    `MessageAttributes.entry.${ix + 1}.Value.DataType`,
                    typeof v === 'number' ? 'Number' : 'String',
                ],
                [`MessageAttributes.entry.${ix + 1}.Value.StringValue`, v.toString()],
            ]),
    )
}

function withoutUndefinedValue(
    kvp: [string, string | number | undefined],
): kvp is [string, string | number] {
    return kvp[1] !== undefined
}

type RequestInit = {
    method: string
    headers?: { [key: string]: string }
    body?: string
    signal: AbortSignal
}

async function awsFetchOK(
    env: { [key: string]: string },
    url: string,
    init: RequestInit | undefined,
    errorMessage: string,
    errorData?: {
        [key: string]: unknown
    },
) {
    return fetchOK(
        url,
        {
            ...init,
            headers: await awsHeaders(
                env,
                'sns',
                url,
                init?.method ?? 'GET',
                init?.headers ?? {},
                init?.body ?? '',
            ),
        },
        errorMessage,
        errorData,
    )
}

async function awsHeaders(
    env: { [key: string]: string },
    service: string,
    url: string,
    method: string,
    headers: { [key: string]: string },
    body: string,
) {
    const signer = new SignatureV4({
        service,
        region: env.AWS_REGION ?? 'us-east-1',
        sha256: AwsHash,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID ?? missing('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? missing('AWS_SECRET_ACCESS_KEY'),
            sessionToken: env.AWS_SESSION_TOKEN,
        },
    })
    const uri = new URL(url)
    const query: { [key: string]: string } = {}
    uri.searchParams.forEach((value, key) => {
        query[key] = value
    })
    const signed = await signer.sign({
        method,
        protocol: 'https:',
        hostname: uri.hostname,
        path: uri.pathname,
        query,
        headers: {
            host: uri.hostname,
            ...headers,
        },
        body,
    })
    return signed.headers
}

type SourceData = string | ArrayBuffer | ArrayBufferView

class AwsHash {
    readonly #secret?: SourceData
    #hash: Hash | ReturnType<typeof createHmac>

    constructor(secret?: SourceData) {
        this.#secret = secret
        this.#hash = makeHash(this.#secret)
    }

    digest() {
        return Promise.resolve(this.#hash.digest())
    }

    reset() {
        this.#hash = makeHash(this.#secret)
    }

    update(chunk: Uint8Array) {
        this.#hash.update(new Uint8Array(Buffer.from(chunk)))
    }
}

function makeHash(secret?: SourceData) {
    return secret ? createHmac('sha256', castSourceData(secret)) : createHash('sha256')
}

function castSourceData(data: SourceData) {
    if (Buffer.isBuffer(data)) {
        return data
    }
    if (typeof data === 'string') {
        return Buffer.from(data)
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    return Buffer.from(data)
}
