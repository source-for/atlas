export declare function appliesRemoteMigrations(extraArgs: string[]): boolean;
export declare const PRIVACY_PENDING_MARKER: string;
export declare const PRIVACY_PENDING_MESSAGE: string;
export declare const LEGAL_COPY_FILES: ReadonlyArray<{ path: string; label: string }>;
export declare function deployBlockedReason(target: string, readSource: (path: string) => string): string | undefined;
export declare const ENVIRONMENTS: string[];
export declare const API_TOKEN: string;
export type DeploySpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined>; stdio: unknown },
) => { status: number | null; stdout?: unknown; stderr?: unknown };
export declare function runDeploy(deps: {
  argv: string[];
  env: Record<string, string | undefined>;
  edgeDir: string;
  repoRoot: string;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  spawn: DeploySpawn;
  sleep: (milliseconds: number) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}): number;
