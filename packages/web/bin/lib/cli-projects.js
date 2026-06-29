import path from 'path';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';

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

const normalizeDirectory = (directory) => {
  const normalized = asNonEmptyString(directory);
  return normalized ? path.resolve(normalized) : null;
};

const normalizeProjects = (settings) => {
  const projects = Array.isArray(settings?.projects) ? settings.projects : [];
  return projects
    .map((project) => {
      const id = asNonEmptyString(project?.id);
      const projectPath = normalizeDirectory(project?.path);
      if (!id || !projectPath) return null;
      return {
        id,
        path: projectPath,
        label: asNonEmptyString(project?.label) || path.basename(projectPath) || projectPath,
      };
    })
    .filter(Boolean);
};

const fetchProjects = async (port, options = {}) => {
  const { response, body } = await requestJson(port, '/api/config/settings', options);
  assertOk(response, body, 'Failed to load projects');
  return normalizeProjects(body);
};

const resolveProjectIdForDirectory = async (port, directory, options = {}) => {
  const requested = normalizeDirectory(directory);
  if (!requested) {
    throw new TunnelCliError('Missing required --dir.', EXIT_CODE.USAGE_ERROR);
  }
  const projects = await fetchProjects(port, options);
  const project = projects.find((entry) => entry.path === requested);
  if (!project) {
    throw new TunnelCliError(`Project not found for directory: ${requested}`, EXIT_CODE.USAGE_ERROR);
  }
  return project.id;
};

export { fetchProjects, normalizeProjects, resolveProjectIdForDirectory };
