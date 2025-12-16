# 任务完成检查清单

## 代码修改后

1. **TypeScript 类型检查**
   ```bash
   # 后端
   cd server && npm run build
   
   # 前端
   cd client && npm run build
   ```

2. **数据库变更**
   - 如果修改了 `prisma/schema.prisma`，需要运行迁移:
   ```bash
   cd server
   npx prisma migrate dev --name <migration_name>
   ```

3. **依赖变更**
   - 如果添加了新依赖，确保 `package.json` 已更新
   - 运行 `npm install` 安装依赖

## 测试

- 项目目前没有配置测试框架
- 手动测试: 启动前后端服务进行功能验证

## 代码审查要点

1. 确保没有硬编码的敏感信息
2. 检查 Cookie 存储是否加密
3. 爬虫频率控制是否合理
4. 错误处理是否完善
5. TypeScript 类型是否正确
