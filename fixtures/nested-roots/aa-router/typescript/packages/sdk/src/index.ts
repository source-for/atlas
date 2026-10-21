import { routeRequest } from "@aa/core";

export class RouterClient {
  send(path: string): string {
    return routeRequest(path);
  }
}
