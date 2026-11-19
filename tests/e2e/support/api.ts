import { startServer } from '../../../apps/server/src/app/runtime.ts';
import { createDefaultServices } from '../../../apps/server/src/app/services.ts';
import { acceptanceQuestionModel } from '../../../apps/server/tests/support/acceptance-question-model.ts';

// An isolated test entry, never imported by the production server. All session,
// budget, evidence validation and persistence still run through the real services.
const schema = new URL(process.env.DATABASE_URL ?? '').searchParams.get('schema');
if (!schema || !/^scova_acceptance_[a-f0-9]{32}$/.test(schema))
    throw new Error('Browser question supplier requires an isolated acceptance schema');
if (process.env.MODEL_API_KEY || process.env.TAVILY_API_KEY)
    throw new Error('Browser supplier must not use remote provider credentials');

startServer('bun', {
    runControl: true,
    services: createDefaultServices({ reportQuestionModel: () => acceptanceQuestionModel }),
});
