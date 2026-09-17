/*
 * ESLint 扁平配置（ESLint 10）。
 *
 * 只为「发现真问题」服务：未定义 / 未使用的变量、重复键、不可达代码、Vue 模板里的错误用法。
 * 刻意不引入缩进 / 引号 / 分号这类格式规则 —— 在 3300 行的 App.vue 上它们只会刷出一屏噪声，
 * 把真问题埋掉（格式交给编辑器）。
 *
 * 本项目有四套运行环境，全局变量差别很大，按目录分块声明，别混在一起：
 *   src/                    浏览器 + Vue 3 + TS（Vite 打包）
 *   public/preload/         CommonJS + Node（`utools` 是 uTools 注入的全局，不 require）
 *   public/floating-page.js 浏览器 IIFE（`window.whale` 由 preload 注入）
 *   scripts/ test/ *.js     Node ESM
 */
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**'] },

  // 所有文件的基础规则 + 本项目约定
  {
    extends: [js.configs.recommended],
    rules: {
      // 空 catch 是本项目的既定写法（只用于预期分支：可选 API 不存在、窗口已销毁、读存储失败回默认值）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 9 起 caughtErrors 默认是 'all'，本项目习惯 `catch (err) {}` 不引用 err
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // 关掉：本项目大量使用「先给变量兜底初值、再在 try / 分支里覆盖」的防御式写法
      // （`let stat = null` + `try { stat = fs.statSync(...) }`），初值确实读不到但无害；
      // 开着会报十几处这种噪声，把真问题埋掉
      'no-useless-assignment': 'off',
    },
  },

  // 设置页（Vue 3 + TS）。
  // 必须用 files 把 typescript-eslint 圈进 ts / vue：它的 recommended 默认对所有文件生效，
  // 落到 preload 的 JS 上会和核心 no-unused-vars 重复报一遍。
  {
    files: ['**/*.{ts,mts,cts,vue}'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // TS 侧未定义标识符交给 vue-tsc（`npm run typecheck`）——它认识 defineProps 这类编译器宏，
      // no-undef 不认识（宏没有 import 来源），开着只会误报
      'no-undef': 'off',
      // 宿主 preload 是 JS，它返回的值与 catch 到的错误在设置页只能是 any
      '@typescript-eslint/no-explicit-any': 'off',
      // `_` 前缀 = 有意不用（回调占位参数）
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },

  // Vue：只开 essential（只查错误，不查风格）。它的 parser 已自带 files: ['**/*.vue']，
  // 放在上面那块之后，保证 .vue 仍由 vue-eslint-parser 解析
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    // vue-eslint-parser 只是外层，<script lang="ts"> 里还得用 TS parser
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },

  // 主窗 / 悬浮窗 preload：CommonJS + Node（`utools` 由 uTools 注入；
  // preload 跑在渲染进程里，`window` 也是现成的）
  {
    files: ['public/preload/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, utools: 'readonly', window: 'readonly' },
    },
  },

  // dsh 的日志要剥掉 ANSI 转义（\x1b[32m 这类控制字符），正则里必须写字面控制字符
  {
    files: ['public/preload/lib/dsh.js'],
    rules: { 'no-control-regex': 'off' },
  },

  // 悬浮窗页面：浏览器 IIFE（不参与 Vite 打包，原样复制到 dist/）
  {
    files: ['public/floating-page.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },

  // 构建脚本 / 单测 / Vite 配置：Node ESM
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
])
