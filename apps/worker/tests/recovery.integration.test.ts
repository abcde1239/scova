import { describe } from 'vite-plus/test';
import { registerFailedUsage } from './recovery/failed-usage.ts';
import { registerApiPages } from './recovery/api-pages.ts';
import { registerSearchBudget } from './recovery/search-budget.ts';
import { registerSynthesisRepair } from './recovery/synthesis-repair.ts';
import { registerOperationReplay } from './recovery/operation-replay.ts';
import { registerLeaseFencing } from './recovery/lease-fencing.ts';
import { registerCheckpoints } from './recovery/checkpoints.ts';
import { registerCancellation } from './recovery/cancellation.ts';
import { registerDrain } from './recovery/drain.ts';
import { registerModelBudget } from './recovery/model-budget.ts';
import { registerDeadline } from './recovery/deadline.ts';
import { registerProcessRecovery } from './recovery/process-recovery.ts';

describe('Agent 工具账本与恢复授权（真实 PostgreSQL，无 Redis）', () => {
    registerFailedUsage();
    registerApiPages();
    registerSearchBudget();
    registerSynthesisRepair();
    registerOperationReplay();
    registerLeaseFencing();
    registerCheckpoints();
    registerCancellation();
    registerDrain();
    registerModelBudget();
    registerDeadline();
});

describe('Agent 真实双进程恢复（PostgresSaver，无 Redis）', () => {
    registerProcessRecovery();
});
