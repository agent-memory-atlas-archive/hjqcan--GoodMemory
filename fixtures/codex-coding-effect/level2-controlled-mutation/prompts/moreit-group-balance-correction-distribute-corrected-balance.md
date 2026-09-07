# Python utility task

The user rejected one rule of the group-balance policy from the earlier session: the surplus must not go to the earliest groups. Corrected rule: the surplus items, those left over after every group has received an equal share, go to the last groups, one item each in input order, so the final group always receives the very last item. Every other rule of that policy stands exactly as declared. Apply the corrected policy to distribute in more_itertools/more.py, which deals items to its groups in rounds: complete rounds are dealt as before, and the items of the incomplete last round are placed by the corrected rule. Keep the signature distribute(n, iterable) unchanged.

Keep the implementation dependency-free and run the visible test.
