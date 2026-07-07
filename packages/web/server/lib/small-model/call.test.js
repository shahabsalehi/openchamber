import { describe, it, expect, vi } from 'bun:test';
import { callSmallModel } from './call.js';

// ---------------------------------------------------------------------------
// Reproduction for issue #2073: MAI-Code-1-Flash (and other Copilot models)
// always routed to /chat/completions, but some models require the /responses
// endpoint.
//
// OpenCode fixed the same bug in v1.17.14:
//   "Fixed GitHub Copilot model routing to honor each model's advertised chat
//    or responses endpoint."
//
// The current code in call.js hardcodes the /chat/completions suffix for ALL
// Copilot models regardless of the model's advertised capabilities.
// ---------------------------------------------------------------------------

/** Returns the URL that callSmallModel would POST to for a Copilot model. */
async function captureCopilotUrl(modelID) {
  let capturedUrl = null;

  // Intercept the global fetch so we can inspect the URL without actually
  // reaching out to the Copilot API.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => {
    capturedUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
    // Return a minimal fake response so the function doesn't crash on JSON parse.
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'mocked' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    await callSmallModel({
      auth: {
        'github-copilot': { type: 'oauth', access: 'test-token', refresh: 'test-token', expires: 0 },
      },
      catalog: {},
      providerID: 'github-copilot',
      modelID,
      prompt: 'test prompt',
      maxOutputTokens: 100,
    });
  } catch {
    // Swallow errors — we only care about the captured URL.
  } finally {
    globalThis.fetch = originalFetch;
  }

  return capturedUrl;
}

describe('github-copilot endpoint routing (issue #2073)', () => {
  it('routes ALL Copilot models to /chat/completions (including MAI-Code-1-Flash)', async () => {
    const url = await captureCopilotUrl('mai-code-1-flash-picker');
    expect(url).toBeTruthy();
    // The URL should be https://api.githubcopilot.com/chat/completions
    expect(url).toContain('api.githubcopilot.com');
    expect(url).toContain('/chat/completions');
  });

  it('never sends Copilot models to /responses endpoint', async () => {
    // This demonstrates the missing routing: no Copilot model ever uses
    // the /responses endpoint, even though the Copilot API advertises it.
    const testModels = [
      'mai-code-1-flash-picker',
      'gpt-5.4-nano',
      'claude-sonnet-4.5',
      'gemini-3.5-flash',
    ];

    for (const modelID of testModels) {
      const url = await captureCopilotUrl(modelID);
      expect(url).toContain('/chat/completions');
      expect(url).not.toContain('/responses');
    }
  });

  it('has no per-model endpoint selection logic for Copilot', async () => {
    // The fix needs to teach the call path about which Copilot models use
    // /chat/completions vs /responses.  Currently there is zero branching:
    // ALL go through callOpenaiCompatible → /chat/completions.
    //
    // To verify this, we check that even models that are known to use the
    // /responses endpoint in OpenCode (like gpt-5.3-codex and other non-OpenAI
    // models through Copilot) are not routed differently.
    const urls = await Promise.all([
      captureCopilotUrl('gpt-5.4-nano'),   // OpenAI model, should use chat
      captureCopilotUrl('mai-code-1-flash-picker'),  // MS model, may need responses
      captureCopilotUrl('claude-sonnet-4.5'), // Anthropic model, may need responses
      captureCopilotUrl('gpt-5.3-codex'),  // Codex model, may need responses
    ]);

    // All models go through the exact same endpoint
    const baseUrlPrefix = 'https://api.githubcopilot.com/chat/completions';
    for (const url of urls) {
      expect(url.startsWith(baseUrlPrefix)).toBe(true);
    }
  });
});

describe('Copilot utility models also go through /chat/completions', () => {
  it('gpt-5.4-nano (copilot utility) uses /chat/completions', async () => {
    const url = await captureCopilotUrl('gpt-5.4-nano');
    expect(url).toContain('/chat/completions');
  });

  it('gpt-4.1 (copilot utility) uses /chat/completions', async () => {
    const url = await captureCopilotUrl('gpt-4.1');
    expect(url).toContain('/chat/completions');
  });

  it('gpt-4o-mini (copilot utility) uses /chat/completions', async () => {
    const url = await captureCopilotUrl('gpt-4o-mini');
    expect(url).toContain('/chat/completions');
  });

  it('gpt-5.4 (not in utility list but available in Copilot) also uses /chat/completions', async () => {
    const url = await captureCopilotUrl('gpt-5.4');
    expect(url).toContain('/chat/completions');
  });
});
