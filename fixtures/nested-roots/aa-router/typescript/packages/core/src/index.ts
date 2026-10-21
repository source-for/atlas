import { allow } from "./policy.js";

export function routeRequest(path: string): string {
  return allow(path) ? `route:${path}` : "denied";
}
