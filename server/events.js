import { EventEmitter } from "node:events";

const dataEvents = new EventEmitter();
dataEvents.setMaxListeners(0);

export function publishDataChange(type) {
  dataEvents.emit("change", { type, at: new Date().toISOString() });
}

export function subscribeToDataChanges(listener) {
  dataEvents.on("change", listener);
  return () => dataEvents.off("change", listener);
}
