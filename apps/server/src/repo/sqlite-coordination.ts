import type { SqliteState } from '@scova/db/sqlite-state';

export function countLocalAttempts(state: SqliteState, keys: string[], seconds: number) {
    return state.transaction((store, now) =>
        keys.map((key) => {
            const entry = store.get<number>(key, now);
            const value = (entry?.value ?? 0) + 1;
            store.set(key, value, entry?.expiresAt ?? now + seconds * 1000);
            return value;
        }),
    );
}

type Reservation = { input: number; output: number; settled: boolean };

export function reserveLocalDraft(
    state: SqliteState,
    keys: string[],
    reservation: string,
    args: number[],
) {
    return state.transaction((store, now) => {
        const increments = args.slice(0, 4);
        const values = keys.map((key) => {
            const existing = store.get<number[]>(key, now)?.value;
            return increments.map((amount, index) => amount + (existing?.[index] ?? 0));
        });
        if (
            values.some((counts, index) =>
                counts.some((count, field) => count > args[4 + index * 4 + field]),
            )
        )
            return [0];
        const expiresAt = now + args[12] * 1000;
        keys.forEach((key, index) => store.set(key, values[index], expiresAt));
        if (args[1] > 0)
            store.set(reservation, { input: args[2], output: args[3], settled: false }, expiresAt);
        return [1];
    });
}

export function settleLocalDraft(
    state: SqliteState,
    keys: string[],
    reservation: string,
    args: number[],
) {
    return state.transaction((store, now) => {
        const entry = store.get<Reservation>(reservation, now);
        if (
            !entry ||
            entry.value.settled ||
            args[0] > entry.value.input ||
            args[1] > entry.value.output
        )
            return [0];
        const budgets = keys.map((key) => store.get<number[]>(key, now));
        if (budgets.some((budget) => !budget)) return [0];
        for (const [index, key] of keys.entries()) {
            const budget = budgets[index]!;
            const [requests, attempts, input, output] = budget.value;
            store.set(
                key,
                [
                    requests,
                    attempts,
                    input + args[0] - entry.value.input,
                    output + args[1] - entry.value.output,
                ],
                budget.expiresAt,
            );
        }
        store.set(reservation, { ...entry.value, settled: true }, entry.expiresAt);
        return [1];
    });
}
