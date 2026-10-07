import { VisualizationError } from "../../../packages/protocol/src/visualizations";

// Auth routes and private visual operations share the singleton RepositoryAgent.
// Keep their async D1 checks, SQLite effects and response construction ordered;
// synchronous membership/turn fences still protect unrelated coordinator changes.
export class VisualizationAuthorityGate {
  private tail: Promise<void> = Promise.resolve();
  private admitted = 0;
  get pending() {
    return this.admitted;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.admitted >= 16)
      return Promise.reject(new VisualizationError("visualization_authority_busy", 503));
    this.admitted++;
    const next = this.tail.then(operation);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next.finally(() => {
      this.admitted--;
    });
  }
}
