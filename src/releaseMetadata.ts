export type BuildMetadata = { version?: string; commit?: string; built_at?: string };
export type ReleaseMetadata = { version: string; deployed_at: string | null; changes: string[] };
export function releaseStamp(version: string, build: BuildMetadata, release?: ReleaseMetadata): { label: 'Built' | 'Deployed'; at: string } | null {
  const valid = (value?: string | null): value is string => Boolean(value && Number.isFinite(Date.parse(value)));
  if (release?.version === version && valid(release.deployed_at)) return { label: 'Deployed', at: release.deployed_at };
  if (build.version === version && valid(build.built_at)) return { label: 'Built', at: build.built_at };
  return null;
}
