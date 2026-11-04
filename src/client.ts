import type { Highnote } from "@highnote-oss/nodejs-sdk";

/** The part of the Highnote SDK client the tools use (lets tests pass a fake). */
export type HighnoteClient = Pick<Highnote, "cards" | "spendRules" | "financialAccounts" | "test">;
