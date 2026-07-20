const CONTROL_PLANE_ENV_NAME = 'OPENCHAMBER_CONTROL_PLANE_URL';
const INVALID_CONFIG_MESSAGE = 'Invalid OpenChamber control-plane configuration';

export const resolveControlPlaneConfig = (env = process.env) => {
  const configured = env?.[CONTROL_PLANE_ENV_NAME];
  if (configured === undefined) {
    return null;
  }
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error(INVALID_CONFIG_MESSAGE);
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(INVALID_CONFIG_MESSAGE);
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || configured !== parsed.origin
  ) {
    throw new Error(INVALID_CONFIG_MESSAGE);
  }

  return Object.freeze({ origin: parsed.origin });
};

export const resolveHostedWebControlPlaneConfig = (runtimeName, env = process.env) => {
  if (runtimeName !== 'web') return null;
  return resolveControlPlaneConfig(env);
};
