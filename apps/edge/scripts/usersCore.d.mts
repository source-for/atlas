export declare const ENVIRONMENTS: readonly string[];
export declare const EXPORT_COLUMNS: readonly string[];
export declare const USAGE: string;
export declare function parseUsersArgs(argv: string[]):
  | { command: 'export'; env: string; optedIn: boolean }
  | { command: 'delete'; env: string; githubId: number }
  | { command: 'delete'; env: string; email: string }
  | { command: 'requests'; env: string; all: boolean }
  | { command: 'request-status'; env: string; id: number; status: string }
  | { error: string };
export declare function sqlString(value: string): string;
export declare function exportSql(optedIn: boolean): string;
export declare function deleteSql(target: { githubId: number } | { email: string }): string;
export declare const REQUEST_COLUMNS: string[];
export declare const REQUEST_STATUSES: string[];
export declare function requestsSql(all: boolean): string;
export declare function requestStatusSql(id: number, status: string, at: string): string;
export declare function wranglerRows(stdout: string): Array<Record<string, unknown>>;
export declare function deleteOutputUnreadableMessage(stdout: string): string;
export declare function csvField(value: unknown): string;
export declare function toCsv(rows: Array<Record<string, unknown>>, columns?: readonly string[]): string;
