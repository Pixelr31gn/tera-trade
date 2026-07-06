import { BrokerKind } from "../core/config.js";
import { SimulatedBroker } from "./simulatedBroker.js";
import type { BrokerClient } from "./types.js";

export * from "./types.js";
export { SimulatedBroker } from "./simulatedBroker.js";
export { ProjectXGatewayBroker } from "./projectXGatewayBroker.js";
export { BrowserControlBroker } from "./browserControlBroker.js";

export async function getBroker(kind: BrokerKind): Promise<BrokerClient> {
  if (kind === BrokerKind.SIMULATED) return new SimulatedBroker();
  if (kind === BrokerKind.PROJECTX) {
    const { ProjectXGatewayBroker } = await import("./projectXGatewayBroker.js");
    return new ProjectXGatewayBroker();
  }
  if (kind === BrokerKind.BROWSER_CONTROL) {
    const { BrowserControlBroker } = await import("./browserControlBroker.js");
    return new BrowserControlBroker();
  }
  throw new Error(`Unknown broker kind: ${kind}`);
}
