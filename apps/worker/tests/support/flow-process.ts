import { ConnectorError } from '@scova/connectors';
import { createWorkerApp } from '../../src/app/index.ts';
import {
    scenarioConnectors,
    type ScenarioName,
    type ScenarioPhase,
} from './acceptance-scenario-fixtures.ts';

const scenario: ScenarioName = 'english';
const phase: ScenarioPhase = 'A';
const fixtureBundle = scenarioConnectors(scenario, phase);
const app = createWorkerApp({
    bundle: {
        ...fixtureBundle,
        reader: {
            async read(...args) {
                // The preferred source outside the fixture catalog is a controlled supplier failure.
                if (!args[0].startsWith('https://acceptance.example.org/english/'))
                    throw new ConnectorError(
                        'extraction_failed',
                        'Controlled preferred source has no readable body',
                    );
                const page = await fixtureBundle.reader.read(...args);
                return { ...page, truncated: true };
            },
        },
    },
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
