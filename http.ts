import { clientFromHeaders, executeRequest } from '@riddance/host/http'
import { Json, measure } from '@riddance/host/lib/http'
import { getHandlers } from '@riddance/host/registry'
import { AwsContext, createAwsContext } from './context.js'

export * from '@riddance/service/http'

interface HttpResponse {
    statusCode: string | number
    headers?: { [key: string]: string }
    multiValueHeaders?: { [key: string]: string[] }
    body?: string
    isBase64Encoded?: boolean
}

interface CommonRequestEvent {
    pathParameters: { [key: string]: string }
    stageVariables: { [key: string]: string }
    body?: string
    isBase64Encoded: boolean
}

interface RestRequestEvent extends CommonRequestEvent {
    resource: string
    path: string
    httpMethod: string
    requestContext: {
        resourcePath: string
        httpMethod: string
        domainName: string
        path: string
        protocol: string
        stage: string
        requestId: string
        identity: {
            accountId: string
            sourceIp: string
            userAgent: string
        }
    }
    headers: { [key: string]: string }
    multiValueHeaders: { [key: string]: string[] }
    multiValueQueryStringParameters: { [key: string]: string[] }
}

interface HttpRequestEvent extends CommonRequestEvent {
    version: '2.0'
    routeKey: string
    rawPath: string
    rawQueryString: string
    headers: { [key: string]: string }
    cookies: { [key: string]: string }
    queryStringParameters: { [key: string]: string }
    requestContext: {
        accountId: string
        apiId: string
        domainName: string
        domainPrefix: string
        http: {
            method: string
            path: string
            protocol: string
            sourceIp: string
            userAgent: string
        }
        requestId: string
        routeKey: string
        stage: string
        time: string
        timeEpoch: number
    }
}

type RequestEvent = HttpRequestEvent | RestRequestEvent

function isRestRequest(request: RequestEvent): request is RestRequestEvent {
    return !(request as { version: unknown }).version
}

async function asyncIndex(
    req: RequestEvent,
    awsContext: AwsContext,
    callback: (error: unknown, response: HttpResponse | undefined) => void,
) {
    const [handler] = getHandlers('http')
    if (!handler) {
        throw new Error('No http handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        req.stageVariables,
        clientFromHeaders(req.headers),
        handler.meta,
    )

    if (req.body && req.isBase64Encoded) {
        req.body = Buffer.from(req.body, 'base64').toString('utf-8')
    }
    const result = await executeRequest(
        log,
        context,
        handler,
        {
            headers: req.headers,
            uri: isRestRequest(req)
                ? `https://${req.requestContext.domainName}${req.requestContext.path}`
                : `https://${req.requestContext.domainName}${req.rawPath}${
                      req.rawQueryString ? '?' + req.rawQueryString : ''
                  }`,
            json: req.body ? (JSON.parse(req.body) as Json) : undefined,
        },
        success,
    )

    callback(
        undefined,
        Buffer.isBuffer(result.body)
            ? {
                  statusCode: result.status,
                  headers: result.headers,
                  body: result.body.toString('base64'),
              }
            : {
                  statusCode: result.status,
                  headers: result.headers,
                  body: result.body,
              },
    )

    await measure(context.log, 'flush', flush)
}

export function awsHandler(
    req: HttpRequestEvent,
    context: AwsContext,
    callback: (error: unknown, response: HttpResponse | undefined) => void,
) {
    context.callbackWaitsForEmptyEventLoop = false
    asyncIndex(req, context, callback).catch(e => callback(e, undefined))
}
