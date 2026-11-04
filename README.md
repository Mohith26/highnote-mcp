# highnote-mcp

An MCP server that lets an AI agent issue and govern [Highnote](https://highnote.com) virtual cards: one card per agent or workflow, a per-transaction limit and a merchant category rule on it, a look at what it spent, and closing it when the work is done.

I built it on Highnote's own [Node SDK](https://github.com/highnote-oss/nodejs-sdk) (`@highnote-oss/nodejs-sdk`), so every call goes through the SDK's typed GraphQL operations. It is not an official Highnote project.

## Tools

| Tool | What it does |
|---|---|
| `issue_virtual_card` | Issue an active virtual card on a financial account, with a capped lifetime and an idempotency key |
| `set_transaction_limit` | Create an amount-limit spend rule and attach it to the card |
| `restrict_merchant_categories` | Create an allow or block list (Highnote `MerchantCategory` names or 4-digit MCCs) and attach it |
| `suspend_payment_card` | Suspend a card (reversible) |
| `close_payment_card` | Close a card for good |
| `get_payment_card` | Status, last 4, network, expiration (never the card number) |
| `get_financial_account` | Ledger balances and the cards on the account |
| `list_account_activity` | Recent authorizations and clearings with merchant, amount and card |
| `simulate_authorization` | Test environment only: run a fake authorization to check the rules decline what they should |

## Guardrails

An agent holding a card-issuing API key needs limits that don't depend on the model behaving, so the server enforces them itself:

- **Test by default.** The live environment needs both `HIGHNOTE_ENVIRONMENT=live` and `HIGHNOTE_ALLOW_LIVE=true`, or the server refuses to start.
- **Confirmation in live.** Every tool that changes something only describes the change until it is called again with `confirm: true`, so a client can show the user exactly what will happen first.
- **Hard caps.** `set_transaction_limit` refuses limits above `HIGHNOTE_MAX_TRANSACTION_LIMIT` and `issue_virtual_card` refuses lifetimes above `HIGHNOTE_MAX_CARD_LIFETIME_DAYS`, before any request is sent.
- **Read-only mode.** `HIGHNOTE_READ_ONLY=true` hides every write tool.
- Spend rules are enforced by Highnote at authorization time, so the limits hold even if the agent later misuses the card.

## Setup

```bash
npm install
npm run build
```

Claude Desktop / any MCP client:

```json
{
  "mcpServers": {
    "highnote": {
      "command": "node",
      "args": ["/path/to/highnote-mcp/dist/index.js"],
      "env": { "HIGHNOTE_API_KEY": "<test API key>", "HIGHNOTE_MAX_TRANSACTION_LIMIT": "10000" }
    }
  }
}
```

| Variable | Default | |
|---|---|---|
| `HIGHNOTE_API_KEY` | required | API key from the Highnote dashboard |
| `HIGHNOTE_ENVIRONMENT` | `test` | `test` or `live` |
| `HIGHNOTE_ALLOW_LIVE` | unset | must be `true` to use `live` |
| `HIGHNOTE_READ_ONLY` | `false` | hide write tools |
| `HIGHNOTE_MAX_TRANSACTION_LIMIT` | `50000` | largest per-transaction limit, in minor units ($500.00) |
| `HIGHNOTE_MAX_CARD_LIFETIME_DAYS` | `365` | longest card lifetime |
| `HIGHNOTE_CURRENCY` | `USD` | currency for amounts |

## Tests

```bash
npm test        # 38 tests
npm run typecheck
```

- `tests/tools.test.ts` drives the server through a real MCP client (in-memory transport) with a fake SDK: tool lists per mode, arguments sent to the SDK, caps, live confirmation, errors.
- `tests/contract.test.ts` runs the real Highnote SDK over HTTP against a local GraphQL server built from Highnote's published schema (`tests/fixtures/highnote-schema.graphql`, a snapshot from the SDK repo; refresh with `npm run schema:sync`). Every request the tools make is validated and executed against that schema, so a wrong field, enum value or input shape fails the test. It caught one of mine: I had guessed `AIRLINES` as a merchant category, which Highnote doesn't have.

I don't have a Highnote account, so this has not been run against the real test environment yet. The contract tests check the requests against the schema, not Highnote's business rules (for example which card products allow virtual cards).
