# Gap kind

Also fill `assessment.gapKind` for every claim:

- `none`: the cited passages support the stated answer and its conditions; `gap` is empty.
- `missing_core`: the passages do not establish the core proposition the requested field or question asks for. Only this kind blocks the answer.
- `missing_detail`: the core answer is supported, but a secondary detail (an exact figure, version, example or parameter) is not in the passages.
- `condition`: the answer holds within a stated scope, exception or prerequisite; record it in `conditions`.

Classify by what the requested answer needs, not by what an exhaustive survey would include. Never mark a missing core proposition as a detail or condition to improve completion; never invent a core gap merely because a passage is short.
