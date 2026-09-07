# TypeScript utility task

Establish and implement the path-terminal policy for this fork. Project policy: the trailing slash always belongs to the path segment, so it goes before any query string or fragment no matter what the second argument says; an empty input becomes a single slash; a path whose final segment contains a dot is a file name and never receives a trailing slash; a protocol-relative input that starts with two slashes is returned unchanged; an input that consists only of a fragment starting with a hash is returned unchanged; an input whose path already ends with a slash before its query or fragment is returned unchanged. Apply this policy to withTrailingSlash in src/utils.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
