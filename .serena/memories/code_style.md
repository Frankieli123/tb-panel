# 代码风格与约定

## TypeScript 配置

### 后端 (server/tsconfig.json)
- Target: ES2022
- Module: NodeNext
- Strict mode: 启用
- 输出目录: dist/

### 前端 (client/tsconfig.json)
- Target: ES2020
- Module: ESNext
- JSX: react-jsx
- Strict mode: 启用
- noUnusedLocals: true
- noUnusedParameters: true

## 命名约定

### 文件命名
- 组件: PascalCase (如 `ProductCard.tsx`)
- 工具/服务: camelCase (如 `scraper.ts`, `notification.ts`)
- 类型定义: 放在 `types/` 目录

### 变量命名
- 变量/函数: camelCase
- 类/组件: PascalCase
- 常量: UPPER_SNAKE_CASE
- 接口/类型: PascalCase (如 `TaobaoAccount`)

## Prisma 约定
- Model 名: PascalCase (如 `TaobaoAccount`)
- 表名映射: snake_case (使用 `@@map`)
- 字段名: camelCase
- 关系字段: 单数/复数根据关系类型

## 前端约定
- 使用函数组件 + Hooks
- 样式使用 Tailwind CSS
- 路由使用 React Router v7
- 图标使用 Lucide React

## 后端约定
- Express 路由放在 controllers/
- 业务逻辑放在 services/
- 后台任务放在 jobs/
- 数据验证使用 Zod
