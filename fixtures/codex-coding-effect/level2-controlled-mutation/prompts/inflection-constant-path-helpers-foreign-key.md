# Python utility task

Add a foreign_key(word, separate_class_name_and_id_with_underscore=True) function to inflection/__init__.py, next to humanize. It builds a foreign key column name: drop any double-colon namespace prefix, convert the remaining class name with underscore, and append the letters id, separated from the name by an underscore when the flag is true and joined directly when it is false. Do not change the existing functions.

Keep the implementation dependency-free and run the visible test.
