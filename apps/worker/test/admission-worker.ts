import { DurableObject } from "cloudflare:workers";
import { sqliteAdmission } from "../src/infrastructure-admission";
export class AdmissionFixture extends DurableObject {
  async fetch(request: Request) {
    const body = (await request.json()) as { operation: string; id: string };
    const admission = sqliteAdmission(this.ctx.storage);
    if (body.operation === "release") {
      admission.release(body.id, true);
      return Response.json({ released: true });
    }
    return Response.json(admission.reserve(body.id, body.id, true));
  }
}
export default {
  fetch(request: Request, env: { ADMISSION: DurableObjectNamespace }) {
    return env.ADMISSION.get(env.ADMISSION.idFromName("global")).fetch(request);
  },
};
