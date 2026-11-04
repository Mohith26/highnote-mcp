/**
 * Contract tests: the real Highnote Node SDK talks over HTTP to a local GraphQL server built from
 * Highnote's published schema (tests/fixtures/highnote-schema.graphql). Every request is parsed,
 * validated and executed against that schema, so a tool that sends a field, argument, enum value
 * or input shape Highnote doesn't accept fails here.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { addMocksToSchema, type IMocks, type IMockStore } from "@graphql-tools/mock";
import { Highnote } from "@highnote-oss/nodejs-sdk";
import { buildSchema, graphql, parse, validate, type GraphQLSchema } from "graphql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connect } from "./helpers.js";

const sdl = readFileSync(new URL("./fixtures/highnote-schema.graphql", import.meta.url), "utf8");
const schema = buildSchema(sdl);

interface Received {
  operationName: string | undefined;
  variables: Record<string, any>;
  errors: readonly unknown[];
}

let received: Received[] = [];

function mockedSchema(): GraphQLSchema {
  return addMocksToSchema({
    schema,
    mocks: {
      UnsignedInt: () => 1000,
      SignedInt: () => -1000,
      Date: () => "2027-01-31",
      IdempotencyKey: () => "idempotency-key-0001",
      String: () => "mock",
    } as IMocks,
    resolvers: (store: IMockStore): Record<string, Record<string, unknown>> => ({
      Query: {
        node: (_: unknown, { id }: { id: string }) =>
          store.get(id.startsWith("fa_") ? "FinancialAccount" : "PaymentCard", id),
      },
      Mutation: {
        issuePaymentCardForFinancialAccount: () => store.get("PaymentCard", "pc_new"),
        suspendPaymentCard: (_: unknown, { input }: any) => store.get("PaymentCard", input.paymentCardId),
        closePaymentCard: (_: unknown, { input }: any) => store.get("PaymentCard", input.paymentCardId),
        createAmountLimitSpendRule: () => store.get("AmountLimitSpendRule", "sr_amount", { version: "1" }),
        createMerchantCategorySpendRule: () => store.get("MerchantCategorySpendRule", "sr_mcc", { version: "1" }),
        attachSpendRuleToPaymentCard: (_: unknown, { input }: any) => store.get("PaymentCard", input.paymentCardId),
        simulateAuthorization: () => store.get("AuthorizationEvent", "auth_1"),
      },
    }),
  });
}

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const executable = mockedSchema();
  httpServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const { query, variables, operationName } = JSON.parse(body);
      const document = parse(query);
      const validationErrors = validate(schema, document);
      const result =
        validationErrors.length > 0
          ? { errors: validationErrors.map((e) => ({ message: e.message })) }
          : await graphql({ schema: executable, source: query, variableValues: variables, operationName });
      const name =
        operationName ??
        document.definitions.map((d: any) => d.name?.value).find((n: string | undefined) => n !== undefined);
      received.push({ operationName: name, variables, errors: result.errors ?? [] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/graphql`;
});

afterAll(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

beforeEach(() => {
  received = [];
});

async function session() {
  const client = new Highnote({ apiKey: "sk_test_contract", environment: "test", baseUrl });
  return connect(client);
}

function expectValid(operationNames: string[]) {
  expect(received.map((r) => r.operationName)).toEqual(operationNames);
  for (const request of received) {
    expect(request.errors, `${request.operationName}: ${JSON.stringify(request.errors)}`).toEqual([]);
  }
}

describe("tools against the Highnote schema", () => {
  it("snapshot is the full schema", () => {
    expect(Object.keys(schema.getMutationType()!.getFields()).length).toBeGreaterThan(300);
  });

  it("issue_virtual_card", async () => {
    const { call, close } = await session();
    const result = await call("issue_virtual_card", { financialAccountId: "fa_1", expiresInDays: 30, externalId: "agent-7" });
    await close();
    expect(result.isError, result.text).toBe(false);
    expect(result.data.id).toBe("pc_new");
    expectValid(["IssuePaymentCardForFinancialAccount"]);
    expect(received[0].variables.input.options.activateOnCreate).toBe(true);
  });

  it("set_transaction_limit", async () => {
    const { call, close } = await session();
    const result = await call("set_transaction_limit", { paymentCardId: "pc_1", maximumAmount: 2500 });
    await close();
    expect(result.isError, result.text).toBe(false);
    expectValid(["CreateAmountLimitSpendRule", "AttachSpendRuleToPaymentCard"]);
    expect(received[1].variables.input).toEqual({ paymentCardId: "pc_1", spendRule: { id: "sr_amount", version: "1" } });
  });

  it("restrict_merchant_categories with real MerchantCategory values", async () => {
    const { call, close } = await session();
    const result = await call("restrict_merchant_categories", {
      paymentCardId: "pc_1",
      allowed: ["computer_software_stores", "COMPUTER_NETWORK_SERVICES"],
    });
    await close();
    expect(result.isError, result.text).toBe(false);
    expectValid(["CreateMerchantCategorySpendRule", "AttachSpendRuleToPaymentCard"]);
  });

  it("restrict_merchant_categories rejects a category Highnote doesn't have", async () => {
    const { call, close } = await session();
    const result = await call("restrict_merchant_categories", { paymentCardId: "pc_1", blocked: ["NOT_A_CATEGORY"] });
    await close();
    expect(result.isError).toBe(true);
    expect(received[0].errors.length).toBeGreaterThan(0);
  });

  it("suspend_payment_card and close_payment_card", async () => {
    const { call, close } = await session();
    expect((await call("suspend_payment_card", { paymentCardId: "pc_1" })).isError).toBe(false);
    expect((await call("close_payment_card", { paymentCardId: "pc_1" })).isError).toBe(false);
    await close();
    expectValid(["SuspendPaymentCard", "ClosePaymentCard"]);
  });

  it("get_payment_card and get_financial_account", async () => {
    const { call, close } = await session();
    const card = await call("get_payment_card", { paymentCardId: "pc_1" });
    const account = await call("get_financial_account", { financialAccountId: "fa_1" });
    await close();
    expect(card.isError, card.text).toBe(false);
    expect(card.data.id).toBe("pc_1");
    expect(account.isError, account.text).toBe(false);
    expect(account.data.id).toBe("fa_1");
    expectValid(["FindPaymentCard", "FindFinancialAccount"]);
  });

  it("list_account_activity", async () => {
    const { call, close } = await session();
    const result = await call("list_account_activity", { financialAccountId: "fa_1", limit: 3 });
    await close();
    expect(result.isError, result.text).toBe(false);
    expect(Array.isArray(result.data)).toBe(true);
    expect(received.length).toBeGreaterThanOrEqual(1);
    for (const request of received) {
      expect(request.operationName).toBe("FindFinancialAccountActivities");
      expect(request.errors).toEqual([]);
    }
  });

  it("simulate_authorization", async () => {
    const { call, close } = await session();
    const result = await call("simulate_authorization", {
      paymentCardId: "pc_1",
      amount: 1250,
      merchantName: "Cloud Vendor",
      merchantCategory: "COMPUTER_SOFTWARE_STORES",
    });
    await close();
    expect(result.isError, result.text).toBe(false);
    expectValid(["SimulateAuthorization"]);
  });
});
