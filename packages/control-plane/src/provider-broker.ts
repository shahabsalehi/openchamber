import { decryptCredentialValue } from './credential-crypto'
import { ControlPlaneFault } from './errors'
import type {
  ReservedCapability,
  SecretKeyRing,
  SecretValueBinding,
} from './vault-contracts'
import { assertExactObject } from './validation'

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
export const MAX_PROVIDER_REQUEST_BYTES = 1024 * 1024
export const MAX_PROVIDER_JSON_RESPONSE_BYTES = 4 * 1024 * 1024
export const MAX_PROVIDER_STREAM_RESPONSE_BYTES = 8 * 1024 * 1024
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const
const AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com'
const AI_GATEWAY_PATH_PATTERN = /^\/v1\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/openai\/chat\/completions$/

type ChatMessageRole = (typeof MESSAGE_ROLES)[number]

interface ChatMessage {
  role: ChatMessageRole
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: readonly ChatMessage[]
  stream: boolean
  temperature?: number
  max_tokens?: number
}

interface DirectProviderRoute {
  mode: 'direct'
  origin: 'https://api.openai.com'
  path: '/v1/chat/completions'
}

interface AiGatewayProviderRoute {
  mode: 'ai-gateway'
  origin: string
  path: string
  gatewayAuthorization?: SecretValueBinding
  serviceProviderAuthorization?: SecretValueBinding
}

export type ProviderRoute = DirectProviderRoute | AiGatewayProviderRoute

export interface ProviderRouting {
  resolve(): Promise<ProviderRoute>
}

export interface AiGatewayRoutingOptions {
  url: string
  gatewayAuthorization?: SecretValueBinding
  serviceProviderAuthorization?: SecretValueBinding
}

export interface ProviderBrokerOptions {
  routing: ProviderRouting
  fetcher: typeof fetch
  timeoutMs?: number
}

export interface ExecuteBrokerInput {
  body: ChatCompletionRequest
  encryptionKeys: SecretKeyRing
  reservation: ReservedCapability
  signal?: AbortSignal
}

export const directOpenAiRouting: ProviderRouting = {
  async resolve(): Promise<DirectProviderRoute> {
    return {
      mode: 'direct',
      origin: 'https://api.openai.com',
      path: '/v1/chat/completions',
    }
  },
}

function validateFixedGatewayUrl(value: string): { origin: string; path: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.hostname !== AI_GATEWAY_HOST ||
    url.port.length !== 0 ||
    !AI_GATEWAY_PATH_PATTERN.test(url.pathname)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return { origin: url.origin, path: url.pathname }
}

export function createAiGatewayRouting(options: AiGatewayRoutingOptions): ProviderRouting {
  const fixed = validateFixedGatewayUrl(options.url)
  return {
    async resolve(): Promise<AiGatewayProviderRoute> {
      return {
        mode: 'ai-gateway',
        origin: fixed.origin,
        path: fixed.path,
        gatewayAuthorization: options.gatewayAuthorization,
        serviceProviderAuthorization: options.serviceProviderAuthorization,
      }
    },
  }
}

function validateMessageRole(value: unknown): ChatMessageRole {
  for (const role of MESSAGE_ROLES) {
    if (value === role) {
      return role
    }
  }
  throw new ControlPlaneFault('VALIDATION_FAILED')
}

function validateMessage(value: unknown): ChatMessage {
  assertExactObject(value, ['role', 'content'])
  if (
    typeof value.content !== 'string' ||
    value.content.length < 1 ||
    value.content.length > 256 * 1024
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return { role: validateMessageRole(value.role), content: value.content }
}

export function validateChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const keys = Object.keys(value)
  const allowed = ['model', 'messages', 'stream', 'temperature', 'max_tokens']
  if (
    !Object.hasOwn(value, 'model') ||
    !Object.hasOwn(value, 'messages') ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const model = Reflect.get(value, 'model')
  const messagesValue = Reflect.get(value, 'messages')
  const streamValue = Reflect.get(value, 'stream')
  const temperatureValue = Reflect.get(value, 'temperature')
  const maxTokensValue = Reflect.get(value, 'max_tokens')
  if (
    typeof model !== 'string' ||
    !MODEL_PATTERN.test(model) ||
    !Array.isArray(messagesValue) ||
    messagesValue.length < 1 ||
    messagesValue.length > 256 ||
    (streamValue !== undefined && typeof streamValue !== 'boolean') ||
    (temperatureValue !== undefined &&
      (typeof temperatureValue !== 'number' ||
        !Number.isFinite(temperatureValue) ||
        temperatureValue < 0 ||
        temperatureValue > 2)) ||
    (maxTokensValue !== undefined &&
      (typeof maxTokensValue !== 'number' ||
        !Number.isSafeInteger(maxTokensValue) ||
        maxTokensValue < 1 ||
        maxTokensValue > 1_000_000))
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const result: ChatCompletionRequest = {
    model,
    messages: messagesValue.map(validateMessage),
    stream: streamValue ?? false,
  }
  if (temperatureValue !== undefined) {
    result.temperature = temperatureValue
  }
  if (maxTokensValue !== undefined) {
    result.max_tokens = maxTokensValue
  }
  return result
}

function routeUrl(route: ProviderRoute): string {
  const url = new URL(route.path, route.origin)
  if (
    url.protocol !== 'https:' ||
    url.origin !== route.origin ||
    url.pathname !== route.path ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  if (route.mode === 'direct' && url.href !== OPENAI_CHAT_COMPLETIONS_URL) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  if (route.mode === 'ai-gateway') {
    try {
      const fixed = validateFixedGatewayUrl(url.href)
      if (fixed.origin !== route.origin || fixed.path !== route.path) {
        throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
      }
    } catch {
      throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
    }
  }
  return url.href
}

async function readServiceSecret(binding: SecretValueBinding): Promise<string> {
  let value: string
  try {
    value = await binding.get()
  } catch {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  if (
    !/^[\u0021-\u007e]+$/u.test(value) ||
    value.length > 16 * 1024 ||
    new TextEncoder().encode(value).byteLength > 16 * 1024
  ) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  return value
}

async function providerHeaders(
  route: ProviderRoute,
  input: ExecuteBrokerInput,
): Promise<Headers> {
  const headers = new Headers({
    Accept: input.body.stream ? 'text/event-stream' : 'application/json',
    'Content-Type': 'application/json',
  })
  if (route.mode === 'direct') {
    const credential = input.reservation.credential
    const value = await decryptCredentialValue(
      credential.envelope,
      {
        envelopeVersion: 1,
        tenantId: input.reservation.capability.tenantId,
        userId: input.reservation.capability.userId,
        provider: credential.provider,
        credentialId: credential.credentialId,
        credentialName: credential.name,
        credentialGeneration: credential.generation,
      },
      input.encryptionKeys,
    )
    headers.set('Authorization', `Bearer ${value}`)
    return headers
  }
  if (route.serviceProviderAuthorization !== undefined) {
    headers.set(
      'Authorization',
      `Bearer ${await readServiceSecret(route.serviceProviderAuthorization)}`,
    )
  }
  if (route.gatewayAuthorization !== undefined) {
    headers.set(
      'cf-aig-authorization',
      `Bearer ${await readServiceSecret(route.gatewayAuthorization)}`,
    )
  }
  return headers
}

function responseContentType(response: Response): string | null {
  const value = response.headers.get('Content-Type')
  return value === null ? null : value.split(';', 1)[0].trim().toLowerCase()
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function abortFault(timeoutSignal: AbortSignal): ControlPlaneFault {
  return new ControlPlaneFault(timeoutSignal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE')
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortFault(timeoutSignal)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortFault(timeoutSignal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function declaredResponseLength(response: Response, maximum: number): void {
  const value = response.headers.get('Content-Length')
  if (value === null) {
    return
  }
  if (!/^(0|[1-9]\d*)$/u.test(value) || Number(value) > maximum) {
    throw new ControlPlaneFault('PROVIDER_RESPONSE_TOO_LARGE')
  }
}

async function readBoundedResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const result = await withAbort(reader.read(), signal, timeoutSignal)
      if (result.done) {
        complete = true
        break
      }
      total += result.value.byteLength
      if (total > maximum) {
        throw new ControlPlaneFault('PROVIDER_RESPONSE_TOO_LARGE')
      }
      chunks.push(result.value)
    }
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault(signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE')
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function nextSseDelimiter(value: string): { index: number; length: number } | null {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) {
    return null
  }
  if (lf >= 0 && (crlf < 0 || lf < crlf)) {
    return { index: lf, length: 2 }
  }
  return { index: crlf, length: 4 }
}

function sanitizeSseEvent(rawEvent: string): Uint8Array | null {
  const data: string[] = []
  for (const rawLine of rawEvent.replaceAll('\r\n', '\n').split('\n')) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) {
      continue
    }
    const separator = rawLine.indexOf(':')
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator)
    const rawValue = separator < 0 ? '' : rawLine.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') {
      if (value === 'error') {
        throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
      }
      if (value !== 'message') {
        throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
      }
      continue
    }
    if (field !== 'data') {
      throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
    }
    data.push(value)
  }
  if (data.length === 0) {
    return null
  }
  const payload = data.join('\n')
  if (payload === '[DONE]') {
    return new TextEncoder().encode('data: [DONE]\n\n')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
  }
  if (Object.hasOwn(parsed, 'error')) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  return new TextEncoder().encode(`data: ${JSON.stringify(parsed)}\n\n`)
}

function boundedSseStream(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let complete = false
  let released = false
  let total = 0

  function release(): void {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const delimiter = nextSseDelimiter(buffer)
          if (delimiter !== null) {
            const rawEvent = buffer.slice(0, delimiter.index)
            buffer = buffer.slice(delimiter.index + delimiter.length)
            const event = sanitizeSseEvent(rawEvent)
            if (event !== null) {
              controller.enqueue(event)
              return
            }
            continue
          }
          if (complete) {
            if (buffer.trim().length !== 0) {
              throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
            }
            release()
            controller.close()
            return
          }
          const result = await withAbort(reader.read(), signal, timeoutSignal)
          if (result.done) {
            buffer += decoder.decode()
            complete = true
            continue
          }
          total += result.value.byteLength
          if (total > maximum) {
            throw new ControlPlaneFault('PROVIDER_RESPONSE_TOO_LARGE')
          }
          buffer += decoder.decode(result.value, { stream: true })
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        release()
        controller.error(
          error instanceof ControlPlaneFault
            ? error
            : new ControlPlaneFault(
                signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
              ),
        )
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
      release()
    },
  })
}

export async function executeOpenAiBroker(
  input: ExecuteBrokerInput,
  options: ProviderBrokerOptions,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = input.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([input.signal, timeoutSignal])
  let route: ProviderRoute
  let url: string
  try {
    route = await withAbort(options.routing.resolve(), signal, timeoutSignal)
    url = routeUrl(route)
  } catch {
    throw abortFault(timeoutSignal)
  }
  const headers = await withAbort(providerHeaders(route, input), signal, timeoutSignal)
  const body = JSON.stringify(input.body)
  if (new TextEncoder().encode(body).byteLength > MAX_PROVIDER_REQUEST_BYTES) {
    throw new ControlPlaneFault('REQUEST_TOO_LARGE')
  }
  let response: Response
  try {
    response = await withAbort(
      options.fetcher(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal,
      }),
      signal,
      timeoutSignal,
    )
  } catch {
    throw abortFault(timeoutSignal)
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelResponse(response)
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  if (response.status !== 200) {
    await cancelResponse(response)
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  const expectedType = input.body.stream ? 'text/event-stream' : 'application/json'
  if (responseContentType(response) !== expectedType) {
    await cancelResponse(response)
    throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
  }
  const maximum = input.body.stream
    ? MAX_PROVIDER_STREAM_RESPONSE_BYTES
    : MAX_PROVIDER_JSON_RESPONSE_BYTES
  try {
    declaredResponseLength(response, maximum)
  } catch (error) {
    await cancelResponse(response)
    throw error
  }
  const safeHeaders = new Headers({ 'Content-Type': expectedType })
  if (input.body.stream) {
    if (response.body === null) {
      throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
    }
    return new Response(boundedSseStream(response.body, maximum, signal, timeoutSignal), {
      status: 200,
      headers: safeHeaders,
    })
  }
  const bytes = await readBoundedResponse(response, maximum, signal, timeoutSignal)
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
    }
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault('PROVIDER_RESPONSE_INVALID')
  }
  if (Object.hasOwn(parsed, 'error')) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  return new Response(Uint8Array.from(bytes).buffer, { status: 200, headers: safeHeaders })
}
