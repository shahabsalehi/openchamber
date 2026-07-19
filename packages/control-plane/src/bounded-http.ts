import { ControlPlaneFault, type ErrorCode } from './errors'

export function parseUnsignedInteger(value: string | null): number {
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return parsed
}

export function assertNoQuery(url: URL): void {
  if (url.search.length !== 0) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

export async function cancelUnreadBody(request: Request): Promise<void> {
  if (request.body !== null && !request.bodyUsed) {
    await request.body.cancel().catch(() => undefined)
  }
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
  oversizedCode: ErrorCode = 'VALIDATION_FAILED',
): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.toLowerCase()
  if (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8') {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const declared = request.headers.get('Content-Length')
  if (declared !== null && parseUnsignedInteger(declared) > maximumBytes) {
    throw new ControlPlaneFault(oversizedCode)
  }
  if (request.body === null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        complete = true
        break
      }
      size += result.value.byteLength
      if (size > maximumBytes) {
        throw new ControlPlaneFault(oversizedCode)
      }
      text += decoder.decode(result.value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault('VALIDATION_FAILED')
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}
