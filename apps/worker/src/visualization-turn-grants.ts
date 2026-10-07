import type { VisualizationSql } from "./visualization-store";
import type { VisualizationGrant } from "./visualization-auth";
import { VisualizationError } from "../../../packages/protocol/src/visualizations";
export type VisualizationTurnGrant = VisualizationGrant & {
  repositoryId: string;
  threadId: string;
  turnId: string;
};
export class VisualizationTurnGrants {
  constructor(private sql: VisualizationSql) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS visualization_turn_grants(turn_id TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
  }
  get(turnId: string): VisualizationTurnGrant | undefined {
    const row = this.sql
      .exec("SELECT value FROM visualization_turn_grants WHERE turn_id=?", turnId)
      .toArray()[0];
    return row ? JSON.parse(row.value as string) : undefined;
  }
  bind(grant: VisualizationTurnGrant) {
    const existing = this.get(grant.turnId);
    // A retried request cannot change the admitted creator/session/destination.
    if (existing) {
      if (
        [
          "actor",
          "userId",
          "sessionId",
          "accessActor",
          "email",
          "repositoryId",
          "threadId",
          "turnId",
        ].some(
          (key) =>
            existing[key as keyof VisualizationTurnGrant] !==
            grant[key as keyof VisualizationTurnGrant],
        )
      )
        throw new VisualizationError("visualization_authority_conflict", 409);
      return;
    }
    this.sql.exec(
      "INSERT INTO visualization_turn_grants VALUES(?,?)",
      grant.turnId,
      JSON.stringify(grant),
    );
  }
}
