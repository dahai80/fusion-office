import { defineConfig } from "vite";
import puterLocalhost from "../../dev/puter-localhost.mjs";
import gatewayProxy from "../../dev/gateway-proxy.mjs";
export default defineConfig({
  plugins: [puterLocalhost("presentation"), gatewayProxy()],
  base: "./",
  test: { include: ["tests/**/*.test.js", "lib/**/*.test.ts"] },
});
