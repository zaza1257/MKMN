import { STATE_MACHINES, type MachineId, type MachineState } from "./stateMachines.generated";

export { STATE_MACHINES };
export type { MachineId, MachineState };

/** The definition of one machine, for a screen that shows what is possible. */
export function machineDefinition<M extends MachineId>(id: M) {
  return STATE_MACHINES[id];
}

/** Whether a saved or received string is one of the machine's states. */
export function isMachineState<M extends MachineId>(id: M, value: string): value is MachineState<M> {
  const machine = STATE_MACHINES[id] as { states: readonly { id: string }[] };
  return machine.states.some((state) => state.id === value);
}

/** Whether the registry allows one move. Staying in the same state is always allowed. */
export function canTransition<M extends MachineId>(id: M, from: MachineState<M>, to: MachineState<M>): boolean {
  if (from === to) return true;
  const machine = STATE_MACHINES[id] as { transitions: readonly { from: string; to: string }[] };
  return machine.transitions.some((transition) => transition.from === from && transition.to === to);
}

/** The state one named event leads to, or undefined when the event does not apply here. */
export function nextState<M extends MachineId>(id: M, from: MachineState<M>, event: string): MachineState<M> | undefined {
  const machine = STATE_MACHINES[id] as { transitions: readonly { from: string; to: string; event: string }[] };
  return machine.transitions.find((transition) => transition.from === from && transition.event === event)?.to as MachineState<M> | undefined;
}
