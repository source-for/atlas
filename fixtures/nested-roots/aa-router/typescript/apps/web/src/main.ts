import { RouterClient } from "@aa/sdk";

export function start(): string {
  return new RouterClient().send("/");
}
