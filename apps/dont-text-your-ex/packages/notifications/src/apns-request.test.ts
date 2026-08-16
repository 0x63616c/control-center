import { describe, expect, it } from "vitest";
import { buildApnsRequest } from "./apns-request";

describe("buildApnsRequest", () => {
  it("contains only a generic alert and opaque notification id", () => {
    const request = buildApnsRequest({
      host: "https://api.sandbox.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
      authorization: "bearer provider-jwt",
      deviceToken: "ab".repeat(32),
      notificationId: "ntf_example",
    });

    expect(request).toEqual({
      origin: "https://api.sandbox.push.apple.com",
      path: `/3/device/${"ab".repeat(32)}`,
      headers: {
        authorization: "bearer provider-jwt",
        "apns-collapse-id": "ntf_example",
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": "co.worldwidewebb.textyourex",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {
          alert: { title: "Don’t Text Your Ex", body: "You have an update." },
          sound: "default",
        },
        notificationId: "ntf_example",
      }),
    });
    expect(request.body).not.toContain("reports");
  });
});
