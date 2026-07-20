import type { WebV2API, WebV2CredentialMetadata, WebV2RequestOptions } from '@/lib/api/types';

interface CredentialSecretValues {
  createValue: string;
  rotationValues: Record<string, string>;
}

export const emptyCredentialSecretValues = (): CredentialSecretValues => ({ createValue: '', rotationValues: {} });

export const hasWebV2CredentialCapability = (webV2: WebV2API | undefined): webV2 is WebV2API => webV2 !== undefined;

export const requiresCredentialConfirmation = (operation: 'revoke' | 'delete') => operation === 'revoke' || operation === 'delete';

const toSafeCredentialMetadata = (credential: WebV2CredentialMetadata): WebV2CredentialMetadata => ({
  credentialId: credential.credentialId,
  name: credential.name,
  provider: credential.provider,
  generation: credential.generation,
  status: credential.status,
  createdAt: credential.createdAt,
  updatedAt: credential.updatedAt,
});

export const loadCredentialMetadata = async (
  api: WebV2API,
  previous: WebV2CredentialMetadata[] | null,
  options?: WebV2RequestOptions,
): Promise<{ credentials: WebV2CredentialMetadata[] | null; failed: boolean }> => {
  try {
    return { credentials: (await api.listCredentials(options)).map(toSafeCredentialMetadata), failed: false };
  } catch {
    return { credentials: previous, failed: true };
  }
};

export const rotateCredentialValue = (
  api: WebV2API,
  credential: WebV2CredentialMetadata,
  value: string,
  options?: WebV2RequestOptions,
) => api.rotateCredential(credential.credentialId, { expectedGeneration: credential.generation, value }, options);

export const revokeCredentialValue = (api: WebV2API, credential: WebV2CredentialMetadata, options?: WebV2RequestOptions) =>
  api.revokeCredential(credential.credentialId, { expectedGeneration: credential.generation }, options);

export const deleteCredentialValue = (api: WebV2API, credential: WebV2CredentialMetadata, options?: WebV2RequestOptions) =>
  api.deleteCredential(credential.credentialId, { expectedGeneration: credential.generation }, options);

export const createCredentialRequestScope = () => {
  let generation = 0;
  let refreshGeneration = 0;
  const controllers = new Set<AbortController>();

  const start = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return { controller, generation };
  };

  return {
    start,
    startRefresh: () => ({ request: start(), refreshGeneration: ++refreshGeneration }),
    isCurrent: (request: ReturnType<typeof start>) =>
      generation === request.generation && !request.controller.signal.aborted,
    isCurrentRefresh: (refresh: { request: ReturnType<typeof start>; refreshGeneration: number }) =>
      generation === refresh.request.generation
      && refreshGeneration === refresh.refreshGeneration
      && !refresh.request.controller.signal.aborted,
    finish: (request: ReturnType<typeof start>) => controllers.delete(request.controller),
    invalidateRefreshes: () => {
      refreshGeneration += 1;
    },
    invalidate: () => {
      generation += 1;
      refreshGeneration += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
};
