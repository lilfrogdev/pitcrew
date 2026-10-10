import { Agent } from "agents";
import type { PiEnv } from "./pi-agents";
import type { RepositoryAgent } from "./index";

/** The only component allowed to draft a proposal for a chat mission. */
export class PlanAgent extends Agent<PiEnv> {
  async start(turnId: string) {
    const repository = this.env.REPOSITORY.get(this.env.REPOSITORY.idFromName("pitcrew"));
    return repository.planFromTurn(turnId);
  }
}
