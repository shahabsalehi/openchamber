import { describe, expect, test } from 'bun:test';
import { areWorkspaceResourceControlsDisabled } from './webV2WorkspaceViewState';

describe('WebV2WorkspaceView', () => {
  test('disables resource controls for pending projects and in-flight mutations', () => {
    expect(areWorkspaceResourceControlsDisabled('pending', null)).toBe(true);
    expect(areWorkspaceResourceControlsDisabled('active', 'file')).toBe(true);
    expect(areWorkspaceResourceControlsDisabled('active', null)).toBe(false);
  });
});
