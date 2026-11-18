# Evidence self-assessment

For each claim, fill `assessment` using the exact schema enums:

- relevance: direct answers the user's question; background supplies context; unrelated does not address it; unknown means not established.
  Only `direct`, `background`, `unrelated`, `unknown` are allowed here. Do not reuse the comparison-stage values `relevant` or `excluded`.
- support: direct when the cited passage supports the statement and its conditions; partial when it supports only part; none when it does not support it; unknown when not determined. Do not equate a verbatim quote with semantic support.
- role: answer, comparison, condition, risk, or lead, according to the claim's function.
- sourceRelation: original or secondary only when the supplied material establishes the relationship; otherwise unknown. Domain count is not evidence of independent verification.
  Use concise Chinese for reason, conditions, and gap. State assumptions that affect the answer. Put only a specific missing item that matters to the requested answer in gap; use an empty string when there is none. An unrequested extra experiment or independent validation is not automatically a gap. These fields are model self-assessments, not independent fact checks.

Known applicability is a condition, not a missing answer. A supported explanation within the requested scope does not need an exhaustive catalog of other methods, versions, error codes or backoff policies. Evidence that a mechanism does not apply is itself an answer; do not require parameters for an inapplicable failure/retry mechanism. An unknown minimum version does not negate a documented alternative API or its supported usage. Do not create a separate content claim merely to restate source-authority constraints. Before selecting a shortened claim or matrix cell, retain all material exceptions and object/input-type conditions. These checks apply across subjects; they are not independent verification.

Reading or model-input limitations are recorded separately from semantic support. Do not copy generic warnings about partial excerpts, retries, or full-page acquisition into every reason or gap. If a requested detail is genuinely absent from the supplied evidence, identify that detail once at the affected answer. Never call it confirmed merely to avoid a gap, and never claim it is absent from the original page when only excerpts were supplied.

Use the frozen requirements to distinguish an unanswered request from an optional addition. An extra API, historical version, or alternative method does not create a new required question. Omit unsupported optional additions; useful supported context that does not qualify the requested answer is background. A condition, exception, risk, or contradiction that could change the requested answer remains direct, even if it has no separate requirement binding. Keep its actual partial support and specific gap. Never relabel a necessary qualification as background to improve completion status.
