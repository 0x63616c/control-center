export interface DtyeHealthCheckActivityInput {
  readonly iteration: number;
}
export interface DtyeHealthCheckActivityOutput {
  readonly status: "ok";
}

export async function DtyeHealthCheckActivity(
  input: DtyeHealthCheckActivityInput,
): Promise<DtyeHealthCheckActivityOutput> {
  void input;
  return { status: "ok" };
}
