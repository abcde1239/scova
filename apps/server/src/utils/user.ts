import type { User as StoredUser } from "@scova/models";
import { parseContract, UserSchema } from "@scova/contracts";

/** 只投影公开字段，密码和持久化会话信息不会进入 DTO。 */
export function serializeUser(user: StoredUser) {
  return parseContract(UserSchema, {
    id: user.id,
    email: user.email,
    preferences: {
      defaultTimezone: user.defaultTimezone,
      notificationPreference: user.notificationPreference,
    },
    createdAt: user.createdAt.toISOString(),
  });
}
