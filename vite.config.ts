import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["scripts/vendor/**"] },
  lint: {
    ignorePatterns: ["scripts/vendor/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["{apps,packages}/*/{src,tests}/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/artifacts/**", "**/coverage/**", "**/e2e/**"],
  },
  run: {
    // 治理入口读取 Git index，必须每次执行；需要缓存的构建另用显式 task 配置。
    cache: { scripts: false, tasks: true },
  },
});
