import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { HighnoteClient } from "./client.js";
import type { Config } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const id = (what: string) => z.string().min(1).describe(`Highnote ${what} ID`);

const confirm = z
  .boolean()
  .optional()
  .describe("Required in the live environment. Without it the tool only describes what it would do.");

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { errors?: unknown }).errors;
    return details ? `${error.message} ${JSON.stringify(details)}` : error.message;
  }
  return String(error);
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (error) {
    return failure(errorMessage(error));
  }
}

async function take<T>(items: AsyncIterable<T>, limit: number): Promise<T[]> {
  const result: T[] = [];
  if (limit <= 0) return result;
  for await (const item of items) {
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function formatAmount(value: number, currency: string): string {
  return `${(value / 100).toFixed(2)} ${currency}`;
}

/**
 * Registers the Highnote tools on an MCP server.
 *
 * Every tool that changes state goes through the same gate: it is hidden in read-only mode,
 * and in the live environment it only describes the change until it is called with `confirm: true`.
 */
export function registerTools(server: McpServer, client: HighnoteClient, config: Config): void {
  const isLive = config.environment === "live";

  /** Returns a preview when a live write has not been confirmed, otherwise undefined. */
  function gate(confirmed: boolean | undefined, summary: string): CallToolResult | undefined {
    if (isLive && confirmed !== true) {
      return json({ executed: false, wouldDo: summary, howToProceed: "Call again with confirm: true." });
    }
    return undefined;
  }

  function checkLimit(amount: number): string | undefined {
    if (amount > config.maxTransactionLimit) {
      return (
        `Refusing a ${formatAmount(amount, config.currency)} limit: this server allows at most ` +
        `${formatAmount(config.maxTransactionLimit, config.currency)} (HIGHNOTE_MAX_TRANSACTION_LIMIT).`
      );
    }
    return undefined;
  }

  async function attach(paymentCardId: string, rule: { id: string; version?: string | null }) {
    if (!rule.version) {
      throw new Error(`Spend rule ${rule.id} was created but Highnote returned no version, so it was not attached.`);
    }
    return client.spendRules.attachToCard({ paymentCardId, spendRule: { id: rule.id, version: rule.version } });
  }

  // ── Read tools ───────────────────────────────────────────────

  server.registerTool(
    "get_payment_card",
    {
      title: "Get payment card",
      description: "Look up a payment card: status, last 4, network, form factor and expiration. Never returns the card number.",
      inputSchema: { paymentCardId: id("payment card") },
      annotations: { readOnlyHint: true },
    },
    async ({ paymentCardId }) => run(() => client.cards.get(paymentCardId)),
  );

  server.registerTool(
    "get_financial_account",
    {
      title: "Get financial account",
      description: "Look up a financial account with its ledger balances and the payment cards issued on it.",
      inputSchema: { financialAccountId: id("financial account") },
      annotations: { readOnlyHint: true },
    },
    async ({ financialAccountId }) => run(() => client.financialAccounts.get(financialAccountId)),
  );

  server.registerTool(
    "list_account_activity",
    {
      title: "List account activity",
      description:
        "List recent activity on a financial account, newest first: authorizations and clearings with merchant, amount and card.",
      inputSchema: {
        financialAccountId: id("financial account"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of activities (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ financialAccountId, limit }) =>
      run(async () => {
        const pageSize = Math.min(limit ?? 20, 100);
        return take(client.financialAccounts.listActivities(financialAccountId, { pageSize }), limit ?? 20);
      }),
  );

  if (config.environment === "test") {
    server.registerTool(
      "simulate_authorization",
      {
        title: "Simulate authorization (test environment)",
        description:
          "Simulate a card authorization in the Highnote test environment, e.g. to check that a card's spend rules decline what they should.",
        inputSchema: {
          paymentCardId: id("payment card"),
          amount: z.number().int().positive().describe("Amount in minor units, e.g. 1250 = $12.50"),
          merchantName: z.string().min(1).optional(),
          merchantCategory: z.string().min(1).optional().describe("Highnote MerchantCategory, e.g. COMPUTER_SOFTWARE_STORES or BETTING_CASINO_GAMBLING"),
        },
      },
      async ({ paymentCardId, amount, merchantName, merchantCategory }) =>
        run(() =>
          client.test.transactions.authorize({
            cardId: paymentCardId,
            amount: { value: amount, currencyCode: config.currency as never },
            ...(merchantName || merchantCategory
              ? {
                  merchantDetails: {
                    ...(merchantName ? { name: merchantName } : {}),
                    ...(merchantCategory ? { category: merchantCategory.toUpperCase() as never } : {}),
                  },
                }
              : {}),
          }),
        ),
    );
  }

  if (config.readOnly) return;

  // ── Write tools ──────────────────────────────────────────────

  server.registerTool(
    "issue_virtual_card",
    {
      title: "Issue virtual card",
      description:
        "Issue a new active virtual card on a financial account, e.g. one card per agent, workflow or vendor. " +
        "Pair it with set_transaction_limit and restrict_merchant_categories before using it.",
      inputSchema: {
        financialAccountId: id("financial account"),
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Card lifetime in days (default and maximum ${config.maxCardLifetimeDays})`),
        externalId: z.string().min(1).optional().describe("Your own reference, e.g. the agent or workflow ID"),
        idempotencyKey: z
          .string()
          .min(10)
          .max(255)
          .optional()
          .describe("Reuse the same key when retrying so a card is never issued twice"),
        confirm,
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ financialAccountId, expiresInDays, externalId, idempotencyKey, confirm: confirmed }) => {
      const days = expiresInDays ?? config.maxCardLifetimeDays;
      if (days > config.maxCardLifetimeDays) {
        return failure(
          `Refusing a ${days}-day card: this server allows at most ${config.maxCardLifetimeDays} days (HIGHNOTE_MAX_CARD_LIFETIME_DAYS).`,
        );
      }
      const expirationDate = new Date(Date.now() + days * DAY_MS).toISOString();
      const preview = gate(confirmed, `Issue an active virtual card on ${financialAccountId}, expiring ${expirationDate}.`);
      if (preview) return preview;
      return run(() =>
        client.cards.issue({
          financialAccountId,
          options: { activateOnCreate: true, expirationDate, ...(externalId ? { externalId } : {}) },
          idempotencyKey: idempotencyKey ?? randomUUID(),
        }),
      );
    },
  );

  server.registerTool(
    "set_transaction_limit",
    {
      title: "Set per-transaction limit",
      description:
        "Create an amount-limit spend rule and attach it to a card, so any single authorization above the limit is declined. " +
        `Limits above ${formatAmount(config.maxTransactionLimit, config.currency)} are refused by this server.`,
      inputSchema: {
        paymentCardId: id("payment card"),
        maximumAmount: z.number().int().positive().describe("Largest allowed authorization, in minor units"),
        name: z.string().min(1).optional().describe("Spend rule name (default describes the limit)"),
        confirm,
      },
    },
    async ({ paymentCardId, maximumAmount, name, confirm: confirmed }) => {
      const refused = checkLimit(maximumAmount);
      if (refused) return failure(refused);
      const ruleName = name ?? `Max ${formatAmount(maximumAmount, config.currency)} per transaction`;
      const preview = gate(confirmed, `Create spend rule "${ruleName}" and attach it to card ${paymentCardId}.`);
      if (preview) return preview;
      return run(async () => {
        const rule = await client.spendRules.createAmountLimit({
          name: ruleName,
          maximumAmount: { value: maximumAmount, currencyCode: config.currency as never },
        });
        const card = await attach(paymentCardId, rule);
        return { spendRule: rule, paymentCard: card };
      });
    },
  );

  server.registerTool(
    "restrict_merchant_categories",
    {
      title: "Restrict merchant categories",
      description:
        "Create a merchant category spend rule (allow list or block list, by Highnote MerchantCategory name or MCC) and attach it to a card.",
      inputSchema: {
        paymentCardId: id("payment card"),
        allowed: z.array(z.string().min(1)).min(1).max(5000).optional().describe("Only allow these categories, e.g. COMPUTER_SOFTWARE_STORES or BETTING_CASINO_GAMBLING"),
        blocked: z.array(z.string().min(1)).min(1).max(5000).optional().describe("Decline these categories"),
        allowedMcc: z.array(z.string().regex(/^\d{4}$/)).min(1).max(5000).optional().describe("Only allow these 4-digit MCCs"),
        blockedMcc: z.array(z.string().regex(/^\d{4}$/)).min(1).max(5000).optional().describe("Decline these 4-digit MCCs"),
        name: z.string().min(1).optional(),
        confirm,
      },
    },
    async ({ paymentCardId, allowed, blocked, allowedMcc, blockedMcc, name, confirm: confirmed }) => {
      const allowing = Boolean(allowed || allowedMcc);
      const blocking = Boolean(blocked || blockedMcc);
      if (!allowing && !blocking) {
        return failure("Pass at least one of allowed, blocked, allowedMcc or blockedMcc.");
      }
      if (allowing && blocking) {
        return failure("Use either an allow list or a block list in one rule, not both.");
      }
      const ruleName = name ?? (allowing ? "Allowed merchant categories" : "Blocked merchant categories");
      const preview = gate(confirmed, `Create spend rule "${ruleName}" and attach it to card ${paymentCardId}.`);
      if (preview) return preview;
      return run(async () => {
        const rule = await client.spendRules.createMerchantCategory({
          name: ruleName,
          ...(allowed ? { allowed: allowed.map((c) => c.toUpperCase()) as never } : {}),
          ...(blocked ? { blocked: blocked.map((c) => c.toUpperCase()) as never } : {}),
          ...(allowedMcc ? { allowedMcc } : {}),
          ...(blockedMcc ? { blockedMcc } : {}),
        });
        const card = await attach(paymentCardId, rule);
        return { spendRule: rule, paymentCard: card };
      });
    },
  );

  server.registerTool(
    "suspend_payment_card",
    {
      title: "Suspend payment card",
      description: "Temporarily suspend a card so new authorizations are declined. Reversible.",
      inputSchema: { paymentCardId: id("payment card"), confirm },
    },
    async ({ paymentCardId, confirm: confirmed }) => {
      const preview = gate(confirmed, `Suspend card ${paymentCardId}.`);
      if (preview) return preview;
      return run(() => client.cards.suspend({ paymentCardId }));
    },
  );

  server.registerTool(
    "close_payment_card",
    {
      title: "Close payment card",
      description: "Permanently close a card, e.g. when the agent's workflow is finished. Cannot be undone.",
      inputSchema: { paymentCardId: id("payment card"), confirm },
      annotations: { destructiveHint: true },
    },
    async ({ paymentCardId, confirm: confirmed }) => {
      const preview = gate(confirmed, `Permanently close card ${paymentCardId}.`);
      if (preview) return preview;
      return run(() => client.cards.close({ paymentCardId }));
    },
  );
}
