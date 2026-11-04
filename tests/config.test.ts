import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the test environment with conservative limits", () => {
    expect(loadConfig({ HIGHNOTE_API_KEY: "sk_test" })).toEqual({
      apiKey: "sk_test",
      environment: "test",
      readOnly: false,
      maxTransactionLimit: 50_000,
      maxCardLifetimeDays: 365,
      currency: "USD",
    });
  });

  it("requires an API key", () => {
    expect(() => loadConfig({})).toThrow("HIGHNOTE_API_KEY is required");
  });

  it("refuses the live environment unless it is explicitly allowed", () => {
    expect(() => loadConfig({ HIGHNOTE_API_KEY: "k", HIGHNOTE_ENVIRONMENT: "live" })).toThrow("HIGHNOTE_ALLOW_LIVE");
    expect(loadConfig({ HIGHNOTE_API_KEY: "k", HIGHNOTE_ENVIRONMENT: "LIVE", HIGHNOTE_ALLOW_LIVE: "true" }).environment).toBe(
      "live",
    );
  });

  it("rejects unknown environments and bad numbers", () => {
    expect(() => loadConfig({ HIGHNOTE_API_KEY: "k", HIGHNOTE_ENVIRONMENT: "prod" })).toThrow('"test" or "live"');
    expect(() => loadConfig({ HIGHNOTE_API_KEY: "k", HIGHNOTE_MAX_TRANSACTION_LIMIT: "12.5" })).toThrow("positive integer");
    expect(() => loadConfig({ HIGHNOTE_API_KEY: "k", HIGHNOTE_MAX_CARD_LIFETIME_DAYS: "0" })).toThrow("positive integer");
  });

  it("reads read-only mode, limits and currency", () => {
    const config = loadConfig({
      HIGHNOTE_API_KEY: "k",
      HIGHNOTE_READ_ONLY: "true",
      HIGHNOTE_MAX_TRANSACTION_LIMIT: "2500",
      HIGHNOTE_MAX_CARD_LIFETIME_DAYS: "30",
      HIGHNOTE_CURRENCY: "eur",
    });
    expect(config).toMatchObject({ readOnly: true, maxTransactionLimit: 2500, maxCardLifetimeDays: 30, currency: "EUR" });
  });
});
