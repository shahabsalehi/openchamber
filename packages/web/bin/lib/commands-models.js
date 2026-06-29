import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
import { resolveTargetPort } from './cli-api-target.js';
import { isJsonMode, printJson } from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertOk = (response, body, fallback) => {
  if (response?.ok) return;
  const message = asNonEmptyString(body?.error) || fallback;
  throw new TunnelCliError(message, response?.status === 400 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
};

const formatModelRef = (entry) => {
  const providerID = asNonEmptyString(entry?.providerID) || asNonEmptyString(entry?.providerId);
  const modelID = asNonEmptyString(entry?.modelID) || asNonEmptyString(entry?.modelId) || asNonEmptyString(entry?.id);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const formatDefaultLine = ({ defaultModel, defaultAgent, defaultVariant }) => {
  const model = asNonEmptyString(defaultModel) || 'none';
  const agent = asNonEmptyString(defaultAgent) || 'none';
  const variant = asNonEmptyString(defaultVariant);
  return `Default: \`${model}${variant ? ` (${variant})` : ''}\` / \`${agent}\``;
};

const formatModelsOutput = (settings = {}) => {
  const favorites = Array.isArray(settings.favoriteModels)
    ? settings.favoriteModels.map(formatModelRef).filter(Boolean)
    : [];
  const recent = Array.isArray(settings.recentModels)
    ? settings.recentModels.map(formatModelRef).filter(Boolean)
    : [];
  const lines = [
    formatDefaultLine(settings),
    '',
    'Favorites:',
    ...(favorites.length > 0 ? favorites.map((model) => `- \`${model}\``) : ['- none']),
    '',
    'Recent:',
    ...(recent.length > 0 ? recent.map((model) => `- \`${model}\``) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
};

async function modelsCommand(options = {}, action = 'show') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Models Commands\n\nUSAGE:\n  openchamber models [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'show') {
    throw new TunnelCliError(`Unknown models command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const { response, body } = await requestJson(port, '/api/config/settings', options);
  assertOk(response, body, 'Failed to load model settings');

  const result = {
    defaultModel: asNonEmptyString(body?.defaultModel),
    defaultVariant: asNonEmptyString(body?.defaultVariant),
    defaultAgent: asNonEmptyString(body?.defaultAgent),
    favoriteModels: Array.isArray(body?.favoriteModels) ? body.favoriteModels : [],
    recentModels: Array.isArray(body?.recentModels) ? body.recentModels : [],
  };

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  process.stdout.write(formatModelsOutput(result));
}

export { modelsCommand, formatModelsOutput, formatDefaultLine, formatModelRef };
