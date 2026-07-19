import { ControlPlaneFault } from './errors'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function decodeBase64Url(value: string, maximumBytes: number): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) + 2 ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    if (binary.length > maximumBytes) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (encodeBase64Url(bytes) !== value) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    return bytes
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

export function encodeUtf8Base64Url(value: string): string {
  return encodeBase64Url(new TextEncoder().encode(value))
}

export function decodeUtf8Base64Url(value: string, maximumBytes: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(value, maximumBytes))
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}
