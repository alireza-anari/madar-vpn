import app from "./index";
import { bootstrapPair } from "./ops-bootstrap";
const deadline = 1792141941;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/ops/runner-bootstrap/pair")
      return bootstrapPair(
        request,
        env,
        Math.floor(Date.now() / 1000),
        deadline,
      );
    return app.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env) {
    return app.scheduled(event, env);
  },
};
