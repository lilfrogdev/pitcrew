import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { createVisualizationPollingFixture } from "./polling-fixture";
import "../src/styles.css";

const fixture = createVisualizationPollingFixture();
const observation = { polls: 0 };
// Observe the actual 15-second App membership interval without changing its cadence.
const interval = window.setInterval.bind(window);
window.setInterval = ((handler: TimerHandler, milliseconds?: number, ...args: unknown[]) => {
  if (milliseconds !== 15000 || typeof handler !== "function")
    return interval(handler, milliseconds, ...args);
  return interval(() => {
    observation.polls++;
    handler(...args);
  }, milliseconds);
}) as typeof window.setInterval;
Object.assign(window, {
  visualizationPollingFixture: fixture,
  visualizationPollingObservation: observation,
});
createRoot(document.getElementById("root")!).render(
  <App api={fixture.api} viewer={fixture.viewer} demo />,
);
