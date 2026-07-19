const REQUIRED_PROVIDER_METHODS = ['create', 'get', 'getEndpoint', 'destroy'];

export function createSandboxProviderRegistry(initialProviders = []) {
  const providers = new Map();
  let sealed = false;

  const register = (provider) => {
    if (sealed) {
      throw new Error('Sandbox provider registry is sealed; no further registrations allowed');
    }
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error('Sandbox provider must define a non-empty id');
    }
    for (const method of REQUIRED_PROVIDER_METHODS) {
      if (typeof provider[method] !== 'function') {
        throw new Error(`Sandbox provider '${provider.id}' must implement ${method}()`);
      }
    }
    const key = provider.id.trim().toLowerCase();
    if (providers.has(key)) {
      throw new Error(`Sandbox provider '${key}' is already registered`);
    }
    providers.set(key, provider);
    return provider;
  };

  const get = (providerId) => {
    if (typeof providerId !== 'string' || providerId.trim().length === 0) {
      return null;
    }
    return providers.get(providerId.trim().toLowerCase()) ?? null;
  };

  const list = () => Array.from(providers.values());

  for (const provider of initialProviders) {
    register(provider);
  }

  const seal = () => { sealed = true; };

  return {
    register,
    get,
    list,
    seal,
  };
}
