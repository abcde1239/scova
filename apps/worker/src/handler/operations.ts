import { operationConfig, operationPool } from "@/app/operations.ts";
import { createOperationService } from "@/service/operations.ts";
import { parseOperation } from "@/utils/operations.ts";

export async function operations(argv = process.argv.slice(2)) {
  const input = parseOperation(argv);
  const config = operationConfig();
  const pool = operationPool(config);
  try {
    return await createOperationService(pool, config).execute(input);
  } finally {
    await pool.end();
  }
}
