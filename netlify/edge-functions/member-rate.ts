export default async () => {};
export const config = {
  path: "/*", excludedPath: ["/api/scan", "/api/alerts/*", "/alerts/confirm/*", "/unsubscribe/*", "/bot/*"],
  method: ["POST"], onError: "bypass",
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
