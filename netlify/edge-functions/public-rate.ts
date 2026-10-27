// Anonymous entry points share the public POST rule; GET never spends it.
export default async () => {};
export const config = {
  path: ["/api/scan", "/api/alerts/*", "/alerts/confirm/*", "/unsubscribe/*", "/bot/*"],
  method: ["POST"], onError: "bypass",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
