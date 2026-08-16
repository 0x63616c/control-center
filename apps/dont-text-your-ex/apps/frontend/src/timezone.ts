import { type IanaTimeZone, IanaTimeZoneSchema } from "../../../contracts";

export function currentDeviceTimeZone(
  resolvedTimeZone: () => unknown = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): IanaTimeZone | null {
  const parsed = IanaTimeZoneSchema.safeParse(resolvedTimeZone());
  return parsed.success ? parsed.data : null;
}

export async function refreshStoredTimeZone(
  update: (input: { readonly timezone: IanaTimeZone }) => Promise<unknown>,
  resolvedTimeZone?: () => unknown,
): Promise<boolean> {
  const timezone = currentDeviceTimeZone(resolvedTimeZone);
  if (!timezone) return false;
  await update({ timezone });
  return true;
}
