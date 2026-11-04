export type Environment = "test" | "live";

export interface Config {
  apiKey: string;
  environment: Environment;
  /** Hide every tool that changes state. */
  readOnly: boolean;
  /** Largest per-transaction limit (minor units) the agent may put on a card. */
  maxTransactionLimit: number;
  /** Longest card lifetime the agent may request, in days. */
  maxCardLifetimeDays: number;
  currency: string;
}

const DEFAULT_MAX_TRANSACTION_LIMIT = 50_000; // $500.00
const DEFAULT_MAX_CARD_LIFETIME_DAYS = 365;

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Reads the server configuration from environment variables.
 *
 * The live environment is opt-in twice: HIGHNOTE_ENVIRONMENT=live and HIGHNOTE_ALLOW_LIVE=true.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.HIGHNOTE_API_KEY;
  if (!apiKey) {
    throw new Error("HIGHNOTE_API_KEY is required");
  }

  const environment = (env.HIGHNOTE_ENVIRONMENT ?? "test").toLowerCase();
  if (environment !== "test" && environment !== "live") {
    throw new Error(`HIGHNOTE_ENVIRONMENT must be "test" or "live", got "${environment}"`);
  }
  if (environment === "live" && env.HIGHNOTE_ALLOW_LIVE !== "true") {
    throw new Error("Refusing to start against the live environment without HIGHNOTE_ALLOW_LIVE=true");
  }

  return {
    apiKey,
    environment,
    readOnly: env.HIGHNOTE_READ_ONLY === "true",
    maxTransactionLimit: positiveInt(
      "HIGHNOTE_MAX_TRANSACTION_LIMIT",
      env.HIGHNOTE_MAX_TRANSACTION_LIMIT,
      DEFAULT_MAX_TRANSACTION_LIMIT,
    ),
    maxCardLifetimeDays: positiveInt(
      "HIGHNOTE_MAX_CARD_LIFETIME_DAYS",
      env.HIGHNOTE_MAX_CARD_LIFETIME_DAYS,
      DEFAULT_MAX_CARD_LIFETIME_DAYS,
    ),
    currency: (env.HIGHNOTE_CURRENCY ?? "USD").toUpperCase(),
  };
}
