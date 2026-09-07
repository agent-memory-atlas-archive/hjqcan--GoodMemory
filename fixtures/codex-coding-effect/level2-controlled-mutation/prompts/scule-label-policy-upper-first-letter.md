# TypeScript utility task

Implement the first-letter policy for upperFirst in src/index.ts. Project policy: the character that gets uppercased is the first letter that has a case distinction, not necessarily the first character; anything before that letter, such as punctuation, quotes, whitespace, underscores or digits, is kept exactly as it is; an input without any cased letter is returned unchanged; a letter whose uppercase form is longer than one character, such as the sharp s, is left unchanged; nothing after the affected letter changes; an empty input yields an empty string. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
