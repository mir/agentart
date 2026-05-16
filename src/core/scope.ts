export type InstallScope = 'project' | 'global';
export function parseScope(value: string | undefined): InstallScope {
  if (value === 'project' || value === 'global') return value;
  throw new Error('--scope must be project or global');
}
