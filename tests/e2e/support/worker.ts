import { createWorkerApp } from '../../../apps/worker/src/app/index.ts';
import {
    scenarioConnectors,
    scenarioNames,
    type ScenarioName,
    type ScenarioPhase,
} from '../../../apps/worker/tests/support/acceptance-scenario-fixtures.ts';

const scenario = process.env.SCOVA_ACCEPTANCE_SCENARIO as ScenarioName;
const phase = process.env.SCOVA_ACCEPTANCE_PHASE as ScenarioPhase;
if (!scenarioNames.includes(scenario) || !['A', 'B', 'C'].includes(phase))
    throw new Error('Invalid acceptance scenario or phase');

const fixtureBundle = scenarioConnectors(scenario, phase, {
    queryForGoal: process.env.SCOVA_ACCEPTANCE_QUERY_FOR_GOAL === '1',
    browserScenarios: true,
});
const app = createWorkerApp({
    bundle:
        process.env.SCOVA_ACCEPTANCE_TRUNCATED === '1'
            ? {
                  ...fixtureBundle,
                  reader: {
                      async read(...args: Parameters<typeof fixtureBundle.reader.read>) {
                          const page = await fixtureBundle.reader.read(...args);
                          return { ...page, truncated: true };
                      },
                  },
              }
            : fixtureBundle,
});
let stopping: Promise<void> | undefined;
const stop = () => (stopping ??= app.stop().then(() => process.disconnect?.()));
process.on('message', (message) => {
    if (message === 'scova:shutdown') void stop();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
        void stop();
    });
await app.start();
process.send?.({ type: 'ready', pid: process.pid, scenario, phase });
