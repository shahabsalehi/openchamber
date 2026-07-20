import { describe, expect, it, vi } from 'bun:test';
import {
  resolveControlPlaneConfig,
  resolveHostedWebControlPlaneConfig,
} from './config.js';

describe('control-plane configuration', () => {
  it('is disabled only when the one supported variable is absent', () => {
    expect(resolveControlPlaneConfig({})).toBeNull();
    expect(resolveControlPlaneConfig({ CONTROL_PLANE_URL: 'https://ignored.example' })).toBeNull();
  });

  it('accepts byte-for-byte canonical HTTPS origins without network work', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(resolveControlPlaneConfig({
      OPENCHAMBER_CONTROL_PLANE_URL: 'https://control.example',
    })).toEqual({ origin: 'https://control.example' });
    expect(resolveControlPlaneConfig({
      OPENCHAMBER_CONTROL_PLANE_URL: 'https://control.example:8443',
    })).toEqual({ origin: 'https://control.example:8443' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('resolves configuration only for hosted web and ignores inherited desktop values', () => {
    const valid = { OPENCHAMBER_CONTROL_PLANE_URL: 'https://control.example' };
    const invalid = { OPENCHAMBER_CONTROL_PLANE_URL: 'not-a-url' };

    expect(resolveHostedWebControlPlaneConfig('web', valid)).toEqual({ origin: 'https://control.example' });
    expect(() => resolveHostedWebControlPlaneConfig('web', invalid))
      .toThrow('Invalid OpenChamber control-plane configuration');
    expect(resolveHostedWebControlPlaneConfig('desktop', valid)).toBeNull();
    expect(resolveHostedWebControlPlaneConfig('desktop', invalid)).toBeNull();
    expect(resolveHostedWebControlPlaneConfig('ssh-remote', invalid)).toBeNull();
  });

  it.each([
    '',
    ' https://control.example',
    'https://control.example ',
    'http://control.example',
    'https://user@control.example',
    'https://user:secret@control.example',
    'https://control.example/',
    'https://control.example/path',
    'https://control.example?query=1',
    'https://control.example#fragment',
    'https://control.example:443',
    'https://CONTROL.example',
    'not-a-url',
  ])('rejects non-canonical configured values without reflecting them: %s', (configured) => {
    expect(() => resolveControlPlaneConfig({
      OPENCHAMBER_CONTROL_PLANE_URL: configured,
    })).toThrow('Invalid OpenChamber control-plane configuration');
    try {
      resolveControlPlaneConfig({ OPENCHAMBER_CONTROL_PLANE_URL: configured });
    } catch (error) {
      expect(error.message).not.toContain(configured || 'not-present');
    }
  });
});
