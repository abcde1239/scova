// Deliberately synchronous CPU work: only the parent deadline may stop it.
process.stdin.once('data', () => {
    process.stderr.write('CPU_READY\n');
    for (;;) {
        // Exercise a real non-yielding process, rather than an async mock.
    }
});
