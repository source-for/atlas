import { routeRequest } from "@aa/core";
import { allow } from "@aa/core/policy";

export default {
  fetch(request: { url: string }): string {
    return allow(request.url) ? routeRequest(request.url) : "blocked";
  },
};
