import { hostname } from "node:os";

export interface DtyeHealthCheckActivityInput {
  readonly iteration: number;
}
export interface DtyeHealthCheckActivityOutput {
  readonly iteration: number;
  readonly observedAt: string;
  readonly workerHost: string;
}

export async function DtyeHealthCheckActivity(
  input: DtyeHealthCheckActivityInput,
): Promise<DtyeHealthCheckActivityOutput> {
  return {
    iteration: input.iteration,
    observedAt: new Date().toISOString(),
    workerHost: hostname(),
  };
}
