// The words shown while a model loads, read from where it really runs: an NPU model loads onto the NPU, a hybrid or CPU
// one never claims the NPU.
import type { ComputeTarget } from "../shared/types";

/** Where the model loads: the measured badge first (a known hybrid or CPU model), else the server's compute target. */
export function loadDevice(badge: ComputeTarget | undefined | null, serverCompute: ComputeTarget | undefined | null): ComputeTarget | null {
  return badge ?? serverCompute ?? null;
}

const PLACE: Record<ComputeTarget, string> = {
  npu: "onto the NPU",
  hybrid: "onto the NPU and the processor",
  gpu: "onto the GPU",
  cpu: "on the processor"
};

/** The line shown while the model loads. */
export function loadingLabel(d: ComputeTarget | null): string {
  return d ? `Loading the model ${PLACE[d]}` : "Loading the model";
}

/** The composer chip while the model warms up. */
export function warmingLabel(d: ComputeTarget | null): string {
  return d === "npu" ? "NPU warming up…" : d === "hybrid" ? "NPU + CPU warming up…" : d === "gpu" ? "GPU warming up…" : d === "cpu" ? "CPU warming up…" : "Warming up…";
}

/** The composer chip when the load failed: says the model could not be loaded and where. */
export function loadFailedLabel(d: ComputeTarget | null): string {
  return d ? `The model could not be loaded ${PLACE[d]}` : "The model could not be loaded";
}

/** The sentences under the loading line: NPU memory words only for a model that uses the NPU. */
export function loadPhrases(d: ComputeTarget | null): string[] {
  if (d === "npu" || d === "hybrid") return ["Reserving memory on the NPU", "Loading the model piece by piece", "A large model can take a minute or two"];
  if (d === "gpu") return ["Reserving memory on the GPU", "Loading the model piece by piece", "A large model can take a minute or two"];
  return ["Reserving memory", "Loading the model piece by piece", "A large model can take a minute or two"];
}
