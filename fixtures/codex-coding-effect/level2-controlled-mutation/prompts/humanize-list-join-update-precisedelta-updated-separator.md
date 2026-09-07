# Python utility task

The team superseded one rule of the accepted list-join policy: because joined items may themselves contain commas, three or more items are now separated by a semicolon and a space, and nothing precedes the conjunction (the Oxford comma is gone). Every other rule of the policy stands. Apply the updated policy to the way precisedelta in src/humanize/time.py joins its unit parts into the final sentence, keeping the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
