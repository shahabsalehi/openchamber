// Cross-compatibility: the JS host e2ee must interoperate with the normative TS
// modules in packages/ui/src/lib/relay. bun runs TS directly, so import the TS
// client handshake and drive a full TS-client <-> JS-host exchange both ways.

import { describe, expect, it } from 'bun:test';

import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from './e2ee.js';
import { createClientHandshake } from '../../../../ui/src/lib/relay/handshake.ts';
import { TunnelFrameType as JsFrameType, decodeTunnelFrame as jsDecode, encodeTunnelFrame as jsEncode } from './tunnel-codec.js';
import { decodeTunnelFrame as tsDecode, encodeTunnelFrame as tsEncode } from '../../../../ui/src/lib/relay/tunnel-codec.ts';
import { TunnelFrameType as TsFrameType } from '../../../../ui/src/lib/relay/protocol.ts';

describe('relay JS-host <-> TS-client cross compatibility', () => {
  it('completes a handshake and exchanges frames both ways', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    const jsHost = createHostHandshake(hostKeys.privateKey);
    const tsClient = await createClientHandshake(hostPubJwk);

    // TS client hello -> JS host establishes and replies ready.
    const hostAction = await jsHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    const hostChannel = hostAction.channel;

    // JS host ready -> TS client establishes.
    const clientAction = await tsClient.handleText(hostAction.replyText);
    expect(clientAction.type).toBe('established');
    const clientChannel = clientAction.channel;

    // TS client -> JS host.
    const up = new TextEncoder().encode('ts client speaking');
    const upPlain = await hostChannel.decryptor.decrypt(await clientChannel.encryptor.encrypt(up));
    expect(new TextDecoder().decode(upPlain)).toBe('ts client speaking');

    // JS host -> TS client.
    const down = new TextEncoder().encode('js host replying');
    const downPlain = await clientChannel.decryptor.decrypt(await hostChannel.encryptor.encrypt(down));
    expect(new TextDecoder().decode(downPlain)).toBe('js host replying');
  });

  it('tunnel frames are byte-compatible across TS and JS codecs', () => {
    const payload = new TextEncoder().encode('{"method":"GET"}');
    const tsFrame = tsEncode(TsFrameType.HttpRequest, 5, payload);
    const jsFrame = jsEncode(JsFrameType.HttpRequest, 5, payload);
    expect(Array.from(jsFrame)).toEqual(Array.from(tsFrame));

    const decodedByJs = jsDecode(tsFrame);
    const decodedByTs = tsDecode(jsFrame);
    expect(decodedByJs.streamId).toBe(5);
    expect(decodedByTs.streamId).toBe(5);
    expect(decodedByJs.frameType).toBe(TsFrameType.HttpRequest);
  });
});
