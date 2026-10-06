import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { publishVisualization, type VisualizationContext } from "./visualization-api";
import type { VisualizationStore } from "./visualization-store";

// Caller must capture frozen actor/repository/thread/turn from the admitted run,
// and check current membership + still-active turn/session at both callbacks.
// Model arguments cannot choose owner, destination, URL, script, or provenance.
export function visualizationTools(
  store: VisualizationStore,
  frozen: VisualizationContext & { turnId: string },
  freshAuthority: () => Promise<void>,
  liveFence: () => void,
) {
  const context = Object.freeze({ ...frozen });
  return {
    name: "visualizations",
    tools: [
      defineTool({
        name: "show_visualization",
        description:
          "Create a private visualization in this conversation. Supply bars with label/value points, or document nodes {text} / {tag,children,class,ariaLabel,scope}. Allowed tags are semantic text/table/details elements; no scripts, URLs, style, or arbitrary HTML. Include title, summary and height (160–640). Tool invocation identity and destination are controlled by the runtime.",
        parameters: Type.Object({
          content: Type.Unknown(),
        }),
        replay: "safe",
        executionMode: "sequential" as const,
        execute: async (args, api) => {
          const record = await publishVisualization(
            store,
            { ...context, invocationId: api.callId },
            args.content,
            freshAuthority,
            liveFence,
          );
          await freshAuthority();
          liveFence();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  id: record.id,
                  repositoryId: record.repositoryId,
                  threadId: record.threadId,
                  turnId: record.turnId,
                  invocationId: record.invocationId,
                  revision: record.revision,
                }),
              },
            ],
          };
        },
      }),
    ],
  };
}
