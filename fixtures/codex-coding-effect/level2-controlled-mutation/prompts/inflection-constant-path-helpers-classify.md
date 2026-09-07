# Python utility task

Add a classify(table_name) function to inflection/__init__.py, next to dasherize. It turns a table name into a class name: drop any schema prefix up to and including the last dot, pass the remaining name through the existing singularize function, and camelize the result with an uppercase first letter. Do not change the existing functions.

Keep the implementation dependency-free and run the visible test.
