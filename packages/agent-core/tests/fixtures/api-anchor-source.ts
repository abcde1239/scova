// Short Python documentation excerpts, surrounded by synthetic unrelated material.
// Source: https://docs.python.org/3/library/datetime.html#datetime.datetime.now
export const datetimeDefinition = [
    ' classmethod datetime.now(tz=None)¶',
    'Return the current local date and time.',
    'If optional argument tz is None or not specified, this is like today(), but, if possible, supplies more precision than can be gotten from going through a time.time() timestamp.',
    'If tz is not None, it must be an instance of a tzinfo subclass, and the current date and time are converted to tz’s time zone.',
    'This function is preferred over today() and utcnow().',
].join('\n\n');

const background = 'Historical background describes unrelated calendar conventions.\n\n';
const siblingReference =
    'Return an aware UTC datetime object. This timezone example recommends datetime.now(timezone.utc), rather than a naive datetime value, when tz is specified.\n\n';
export const compoundApiBody =
    '# Contents\n\ndatetime.now\ndatetime.utcnow\ndatetime.fromtimestamp\n\n' +
    background.repeat(300) +
    datetimeDefinition +
    '\n\n' +
    Array.from(
        { length: 9 },
        (_, index) =>
            background.repeat(80) +
            ` classmethod datetime.example${index}(tz=None)¶\n\n` +
            siblingReference,
    ).join('') +
    background.repeat(300);
