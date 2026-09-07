# Python utility task

matmul in more_itertools/recipes.py suffers from the same failure that was recorded for dotproduct in the earlier session. Apply the exact-accumulation rules from that session to matmul: every entry of the product matrix is formed under those rules, and a row of the first matrix whose length differs from the column length of the second matrix is reported the way those rules require. Keep the signature matmul(m1, m2) unchanged; the result stays a matrix of rows.

Keep the implementation dependency-free and run the visible test.
