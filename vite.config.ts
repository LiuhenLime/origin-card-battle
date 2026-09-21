import { defineConfig } from "vite";

// base 使用相对路径：同时兼容 用户名.github.io/<仓库名>/ 子路径托管
export default defineConfig({
  base: "./",
});
