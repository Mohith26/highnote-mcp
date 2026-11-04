import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // graphql ships CJS and ESM builds; inline the packages that import it so the test,
    // graphql-tools and the SDK all share one copy (otherwise "Cannot use GraphQLSchema from another module").
    server: { deps: { inline: [/@graphql-tools\//, /@highnote-oss\//, /graphql-request/] } },
  },
});
