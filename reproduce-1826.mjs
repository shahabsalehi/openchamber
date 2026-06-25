// Reproduction script for issue #1826
// "The project path does not support Chinese"
//
// Error: Failed to construct 'Headers': String contains non ISO-8859-1 code point.
//
// This happens when a file path (project directory) containing non-Latin-1
// characters (e.g., Chinese) is passed as a header value in the Headers API.
// The browser's Headers constructor only accepts ISO-8859-1 (Latin-1) characters
// (U+0000 - U+00FF). Characters like Chinese (CJK) fall outside this range.
//
// Fix: sanitizeHeadersForBrowser encodes non-Latin-1 header values using
// encodeURIComponent before passing them to new Headers(), and marks them
// with x-opencode-directory-encoding: uri so the server can decode them.

// Simulate a project path containing Chinese characters
const projectPath = '/Users/xxxx/Desktop/work/中文/skms/skms-web';

console.log('=== Reproduction of issue #1826 ===\n');
console.log('Project path:', projectPath);

// --- PART 1: Demonstrate the bug (without sanitization) ---
console.log('\n--- Part 1: The bug ---');
console.log('Attempting new Headers({ "x-opencode-directory": projectPath })...');
try {
  const headers = new Headers({ 'x-opencode-directory': projectPath });
  console.log('  ✓ No error (unexpected - this environment may allow it)');
  console.log('  Header value:', headers.get('x-opencode-directory'));
} catch (error) {
  console.log('  ✗ ERROR:', error.message);
  // Expected: "Failed to construct 'Headers': String contains non ISO-8859-1 code point."
}

// --- PART 2: Demonstrate the fix (with sanitizeHeadersForBrowser) ---
console.log('\n--- Part 2: The fix (sanitizeHeadersForBrowser) ---');

// Inline the sanitization logic for reproduction clarity
const isLatin1Safe = (value) => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const sanitizeHeadersForBrowser = (init) => {
  if (!init) return undefined;
  const sourceEntries = init instanceof Headers
    ? Array.from(init.entries())
    : Array.isArray(init)
      ? init
      : Object.entries(init);
  if (sourceEntries.length === 0) return undefined;
  const entries = [];
  let dirty = false;
  let encodedDirectoryHint = false;
  for (const [key, value] of sourceEntries) {
    if (!isLatin1Safe(value)) {
      entries.push([key, encodeURIComponent(value)]);
      dirty = true;
      if (key.toLowerCase() === 'x-opencode-directory') encodedDirectoryHint = true;
    } else {
      entries.push([key, value]);
    }
  }
  if (encodedDirectoryHint) {
    entries.push(['x-opencode-directory-encoding', 'uri']);
  }
  return dirty ? entries : undefined;
};

const sanitized = sanitizeHeadersForBrowser({ 'x-opencode-directory': projectPath });
console.log('Sanitized entries:', JSON.stringify(sanitized));

try {
  const headers = new Headers(sanitized);
  const encodedValue = headers.get('x-opencode-directory');
  const encodingMarker = headers.get('x-opencode-directory-encoding');
  const decodedValue = decodeURIComponent(encodedValue);
  console.log('  ✓ new Headers(sanitized) succeeded');
  console.log('  Encoded header value:', encodedValue);
  console.log('  Encoding marker:', encodingMarker);
  console.log('  Decoded round-trips to original:', decodedValue === projectPath ? '✓ YES' : '✗ NO');
} catch (error) {
  console.log('  ✗ ERROR:', error.message);
}

// --- PART 3: Verify the stores that set x-opencode-directory ---
console.log('\n--- Part 3: Verifying store header patterns ---');

// These stores pass raw directory paths to runtimeFetch, which sanitizes via mergeHeaders:
//   - useSnippetsStore, useCommandsStore, usePluginsStore, useAgentsStore, useMcpConfigStore
//   - files.ts (packages/web/src/api/files.ts)

const storesHeaders = {
  'x-opencode-directory': projectPath,
  'content-type': 'application/json',
};

const sanitizedStores = sanitizeHeadersForBrowser(storesHeaders);
console.log('Store header pattern:', JSON.stringify(storesHeaders));
console.log('Sanitized:', JSON.stringify(sanitizedStores));

try {
  const headers = new Headers(sanitizedStores);
  console.log('  ✓ Headers construction succeeded');
  console.log('  Encoded directory:', headers.get('x-opencode-directory'));
  console.log('  Encoding marker:', headers.get('x-opencode-directory-encoding'));
  console.log('  content-type preserved:', headers.get('content-type'));
} catch (error) {
  console.log('  ✗ ERROR:', error.message);
}

// --- Part 4: Summary ---
console.log('\n=== Summary ===');
console.log('Root cause: The browser Headers constructor rejects header values');
console.log('containing non-Latin-1 characters (U+0100 and above).');
console.log('');
console.log('Affected paths: Any code constructing new Headers() with a header');
console.log('value containing a file/directory path that may have non-ASCII characters.');
console.log('The x-opencode-directory header is the primary vector.');
console.log('');
console.log('Fix (in v1.13.3): sanitizeHeadersForBrowser() in runtime-fetch.ts encodes');
console.log('non-Latin-1 header values with encodeURIComponent() and marks them with');
console.log('x-opencode-directory-encoding: uri so the server decodes them.');
console.log('');
console.log('Verification: The existing test suite at');
console.log('packages/ui/src/lib/runtime-fetch.test.ts covers this scenario');
console.log('(see "runtimeFetch header sanitization" describe block).');
