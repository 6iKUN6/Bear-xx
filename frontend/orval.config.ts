import { defineConfig } from "orval";

const DEFAULT_OPENAPI_URL = "http://localhost:3000/api-docs-json";
const LOCAL_OPENAPI_PATH = "../backend/docs/openapi.json";
const openApiTarget = process.env.OPENAPI_URL || [
  DEFAULT_OPENAPI_URL,
  LOCAL_OPENAPI_PATH,
];

export default defineConfig({
  api: {
    input: {
      target: openApiTarget,
    },
    output: {
      target: "src/api/generated/client.ts",
      schemas: "src/api/generated/models",
      client: "fetch",
      mode: "single",
      clean: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: "src/api/mutator/taroRequest.ts",
          name: "taroRequest",
        },
      },
    },
  },
});
