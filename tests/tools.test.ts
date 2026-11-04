import { afterEach, describe, expect, it, vi } from "vitest";

import type { HighnoteClient } from "../src/server.js";
import { connect } from "./helpers.js";

function fakeClient() {
  const card = { __typename: "PaymentCard", id: "pc_1", last4: "4242", status: "ACTIVE" };
  return {
    cards: {
      get: vi.fn(async (id: string) => ({ ...card, id })),
      issue: vi.fn(async (_input: unknown) => card),
      suspend: vi.fn(async () => ({ ...card, status: "SUSPENDED" })),
      close: vi.fn(async () => ({ ...card, status: "CLOSED" })),
    },
    spendRules: {
      createAmountLimit: vi.fn(async () => ({ id: "sr_amount", version: "v1", name: "limit" })),
      createMerchantCategory: vi.fn(async () => ({ id: "sr_mcc", version: "v3", name: "mcc" })),
      attachToCard: vi.fn(async () => card),
    },
    financialAccounts: {
      get: vi.fn(async (id: string) => ({ id, ledgers: [] })),
      listActivities: vi.fn((_id: string, _opts?: { pageSize?: number }) =>
        (async function* () {
          for (let i = 0; i < 50; i++) yield { sign: "NEGATIVE", n: i };
        })(),
      ),
    },
    test: {
      transactions: {
        authorize: vi.fn(async () => ({ __typename: "AuthorizationEvent", id: "auth_1", responseCode: "APPROVED" })),
      },
    },
  };
}

type Fake = ReturnType<typeof fakeClient>;
const asClient = (fake: Fake) => fake as unknown as HighnoteClient;

let session: Awaited<ReturnType<typeof connect>> | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
});

async function start(fake: Fake, config = {}) {
  session = await connect(asClient(fake), config);
  return session;
}

const READ_TOOLS = ["get_financial_account", "get_payment_card", "list_account_activity"];
const WRITE_TOOLS = [
  "close_payment_card",
  "issue_virtual_card",
  "restrict_merchant_categories",
  "set_transaction_limit",
  "suspend_payment_card",
];

describe("tool list", () => {
  it("exposes read, write and simulation tools in the test environment", async () => {
    const { mcp } = await start(fakeClient());
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS, "simulate_authorization"].sort());
  });

  it("hides every write tool in read-only mode", async () => {
    const { mcp } = await start(fakeClient(), { readOnly: true });
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, "simulate_authorization"].sort());
  });

  it("drops the simulation tool in the live environment", async () => {
    const { mcp } = await start(fakeClient(), { environment: "live" });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("simulate_authorization");
    expect(names).toContain("issue_virtual_card");
  });

  it("marks close_payment_card destructive and read tools read-only", async () => {
    const { mcp } = await start(fakeClient());
    const tools = (await mcp.listTools()).tools;
    expect(tools.find((t) => t.name === "close_payment_card")?.annotations?.destructiveHint).toBe(true);
    for (const name of READ_TOOLS) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("issue_virtual_card", () => {
  it("issues an active card that expires within the requested lifetime", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const before = Date.now();

    const result = await call("issue_virtual_card", {
      financialAccountId: "fa_1",
      expiresInDays: 30,
      externalId: "agent-7",
      idempotencyKey: "invoice-2026-001",
    });

    expect(result.isError).toBe(false);
    expect(result.data.id).toBe("pc_1");
    const input = fake.cards.issue.mock.calls[0][0] as any;
    expect(input).toMatchObject({
      financialAccountId: "fa_1",
      idempotencyKey: "invoice-2026-001",
      options: { activateOnCreate: true, externalId: "agent-7" },
    });
    const expires = Date.parse(input.options.expirationDate);
    expect(expires - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(30 * 86_400_000 + 5000);
  });

  it("generates an idempotency key when none is given", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    await call("issue_virtual_card", { financialAccountId: "fa_1" });
    const key = (fake.cards.issue.mock.calls[0][0] as any).idempotencyKey;
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThanOrEqual(10);
  });

  it("refuses a lifetime above the configured maximum", async () => {
    const fake = fakeClient();
    const { call } = await start(fake, { maxCardLifetimeDays: 90 });
    const result = await call("issue_virtual_card", { financialAccountId: "fa_1", expiresInDays: 91 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("at most 90 days");
    expect(fake.cards.issue).not.toHaveBeenCalled();
  });
});

describe("set_transaction_limit", () => {
  it("creates an amount-limit rule and attaches it with its version", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);

    const result = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 2500 });

    expect(result.isError).toBe(false);
    expect(fake.spendRules.createAmountLimit).toHaveBeenCalledWith({
      name: "Max 25.00 USD per transaction",
      maximumAmount: { value: 2500, currencyCode: "USD" },
    });
    expect(fake.spendRules.attachToCard).toHaveBeenCalledWith({
      paymentCardId: "pc_1",
      spendRule: { id: "sr_amount", version: "v1" },
    });
    expect(result.data.spendRule.id).toBe("sr_amount");
  });

  it("refuses a limit above the server's cap without calling Highnote", async () => {
    const fake = fakeClient();
    const { call } = await start(fake, { maxTransactionLimit: 10_000 });
    const result = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 10_001 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("at most 100.00 USD");
    expect(fake.spendRules.createAmountLimit).not.toHaveBeenCalled();
  });

  it("does not attach a rule that came back without a version", async () => {
    const fake = fakeClient();
    fake.spendRules.createAmountLimit.mockResolvedValueOnce({ id: "sr_x", version: undefined as never, name: "x" });
    const { call } = await start(fake);
    const result = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 100 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no version");
    expect(fake.spendRules.attachToCard).not.toHaveBeenCalled();
  });
});

describe("restrict_merchant_categories", () => {
  it("creates an allow list (normalized to upper case) and attaches it", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("restrict_merchant_categories", {
      paymentCardId: "pc_1",
      allowed: ["computer_software_stores"],
      allowedMcc: ["5734"],
    });
    expect(result.isError).toBe(false);
    expect(fake.spendRules.createMerchantCategory).toHaveBeenCalledWith({
      name: "Allowed merchant categories",
      allowed: ["COMPUTER_SOFTWARE_STORES"],
      allowedMcc: ["5734"],
    });
    expect(fake.spendRules.attachToCard).toHaveBeenCalledWith({
      paymentCardId: "pc_1",
      spendRule: { id: "sr_mcc", version: "v3" },
    });
  });

  it("rejects mixing an allow list with a block list", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("restrict_merchant_categories", {
      paymentCardId: "pc_1",
      allowed: ["ADVERTISING_SERVICES"],
      blockedMcc: ["7995"],
    });
    expect(result.isError).toBe(true);
    expect(fake.spendRules.createMerchantCategory).not.toHaveBeenCalled();
  });

  it("requires at least one list", async () => {
    const { call } = await start(fakeClient());
    const result = await call("restrict_merchant_categories", { paymentCardId: "pc_1" });
    expect(result.isError).toBe(true);
  });

  it("validates MCC format before calling Highnote", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("restrict_merchant_categories", { paymentCardId: "pc_1", blockedMcc: ["79"] });
    expect(result.isError).toBe(true);
    expect(fake.spendRules.createMerchantCategory).not.toHaveBeenCalled();
  });
});

describe("live environment confirmation", () => {
  it.each([
    ["issue_virtual_card", { financialAccountId: "fa_1" }, "issue"],
    ["suspend_payment_card", { paymentCardId: "pc_1" }, "suspend"],
    ["close_payment_card", { paymentCardId: "pc_1" }, "close"],
  ] as const)("%s only previews the change without confirm: true", async (tool, args, method) => {
    const fake = fakeClient();
    const { call } = await start(fake, { environment: "live" });

    const preview = await call(tool, args);
    expect(preview.isError).toBe(false);
    expect(preview.data.executed).toBe(false);
    expect(fake.cards[method]).not.toHaveBeenCalled();

    const done = await call(tool, { ...args, confirm: true });
    expect(done.isError).toBe(false);
    expect(fake.cards[method]).toHaveBeenCalledTimes(1);
  });

  it("previews spend rules without creating them", async () => {
    const fake = fakeClient();
    const { call } = await start(fake, { environment: "live" });
    const preview = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 500 });
    expect(preview.data.executed).toBe(false);
    expect(preview.data.wouldDo).toContain("Max 5.00 USD per transaction");
    expect(fake.spendRules.createAmountLimit).not.toHaveBeenCalled();
  });

  it("still enforces the limit cap before asking for confirmation", async () => {
    const fake = fakeClient();
    const { call } = await start(fake, { environment: "live", maxTransactionLimit: 1000 });
    const result = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 5000, confirm: true });
    expect(result.isError).toBe(true);
    expect(fake.spendRules.createAmountLimit).not.toHaveBeenCalled();
  });
});

describe("read tools", () => {
  it("get_payment_card returns the SDK result", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("get_payment_card", { paymentCardId: "pc_9" });
    expect(result.data).toMatchObject({ id: "pc_9", last4: "4242" });
  });

  it("list_account_activity stops at the requested limit", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("list_account_activity", { financialAccountId: "fa_1", limit: 5 });
    expect(result.data).toHaveLength(5);
    expect(fake.financialAccounts.listActivities).toHaveBeenCalledWith("fa_1", { pageSize: 5 });
  });

  it("list_account_activity rejects limits above 100", async () => {
    const { call } = await start(fakeClient());
    const result = await call("list_account_activity", { financialAccountId: "fa_1", limit: 500 });
    expect(result.isError).toBe(true);
  });
});

describe("simulate_authorization", () => {
  it("sends the amount, currency and merchant details", async () => {
    const fake = fakeClient();
    const { call } = await start(fake);
    const result = await call("simulate_authorization", {
      paymentCardId: "pc_1",
      amount: 1250,
      merchantName: "Cloud Vendor",
      merchantCategory: "computer_software_stores",
    });
    expect(result.data.responseCode).toBe("APPROVED");
    expect(fake.test.transactions.authorize).toHaveBeenCalledWith({
      cardId: "pc_1",
      amount: { value: 1250, currencyCode: "USD" },
      merchantDetails: { name: "Cloud Vendor", category: "COMPUTER_SOFTWARE_STORES" },
    });
  });
});

describe("errors", () => {
  it("returns Highnote errors as tool errors with their details", async () => {
    const fake = fakeClient();
    const error = Object.assign(new Error("User error from issuePaymentCardForFinancialAccount"), {
      errors: [{ code: "INVALID", errorPath: ["financialAccountId"], description: "not found" }],
    });
    fake.cards.issue.mockRejectedValueOnce(error);
    const { call } = await start(fake);
    const result = await call("issue_virtual_card", { financialAccountId: "fa_missing" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("User error from issuePaymentCardForFinancialAccount");
    expect(result.text).toContain("not found");
  });
});
