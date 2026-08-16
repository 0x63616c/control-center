export interface ApnsRequestInput {
  readonly host: string;
  readonly topic: string;
  readonly authorization: string;
  readonly deviceToken: string;
  readonly notificationId: string;
  readonly expiration: number;
}

export interface ApnsHttpRequest {
  readonly origin: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function buildApnsRequest(input: ApnsRequestInput): ApnsHttpRequest {
  return {
    origin: input.host,
    path: `/3/device/${input.deviceToken}`,
    headers: {
      authorization: input.authorization,
      "apns-collapse-id": input.notificationId,
      "apns-expiration": String(input.expiration),
      "apns-priority": "10",
      "apns-push-type": "alert",
      "apns-topic": input.topic,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: "Don’t Text Your Ex", body: "You have an update." },
        sound: "default",
      },
      notificationId: input.notificationId,
    }),
  };
}
