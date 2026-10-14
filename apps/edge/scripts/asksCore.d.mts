export declare const ASK_TARGETS: readonly string[];
export declare const ASK_ACTIONS: { readonly show: 'ask-show'; readonly reset: 'ask-reset' };
export declare const ASK_ORIGINS: { readonly staging: string; readonly production: string };
export declare const DEFAULT_LOCAL_PORT: number;
export declare const OPERATOR_ASK_USAGE_PATH: string;
export declare const GRANT_TTL_MS: number;
export declare const DAILY_ASKS: number;
export declare const ASKS_USAGE: string;
export type AsksArgs = { command: 'show' | 'reset'; env: string; githubId: string; port?: number };
export declare function parseAsksArgs(argv: string[]): AsksArgs | { error: string };
export declare function operatorOrigin(env: string, port?: number): string;
export declare function newGrantToken(): string;
export declare function sha256Hex(text: string): Promise<string>;
export declare function grantSql(grant: { tokenHash: string; action: string; accountId: string; createdAt: string; expiresAt: string }): string;
export declare function wranglerD1Args(env: string, sql: string): string[];
export declare const WRANGLER_ENV_DROPPED: readonly string[];
export declare function wranglerEnv(snapshot: Record<string, string | undefined>): { env: Record<string, string | undefined>; droppedApiToken: boolean };
export declare function askUsageRequest(request: { token: string; action: string; accountId: string }): { headers: { authorization: string; 'content-type': string }; body: string };
export declare function readAskUsageResult(
  args: { command: 'show' | 'reset'; env: string; githubId: string },
  status: number,
  text: string,
): { ok: true; lines: string[] } | { ok: false; message: string };
