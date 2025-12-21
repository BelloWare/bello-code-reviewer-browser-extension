module.exports = {
  root: true,
  env: {
    browser: true,
    webextensions: true,
    es2021: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: "latest"
  },
  plugins: ["@typescript-eslint", "react-refresh"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  rules: {
    "react-refresh/only-export-components": "off"
  },
  ignorePatterns: ["dist", "node_modules"]
};
