import { routeRequest } from "@aa/core";

export function buildAll(): string {
  return routeRequest("/build");
}
