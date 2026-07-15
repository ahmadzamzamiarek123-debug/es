import { defineConfig } from "vitest/config";

// Konfigurasi test minimal. Test unit murni fungsi (parse/validate) — tidak
// menyentuh DB/jaringan (sesuai CLAUDE.md §6: jangan connect ke layanan nyata).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
