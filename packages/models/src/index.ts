import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * 服务端内部模型的统一入口。所有实体、枚举和 Prisma 类型均由本包 schema 生成，
 * 不另行声明平行模型；浏览器及公开 HTTP 接口应使用 @scova/contracts。
 */
export * from "@prisma/client";
export { captureFeedbackSnapshot } from "./feedback.ts";

/** 创建独立数据库客户端；调用方负责连接配置、事务边界和最终断开连接。 */
export function createDatabaseClient(options?: Prisma.PrismaClientOptions): PrismaClient {
  return new PrismaClient(options);
}
