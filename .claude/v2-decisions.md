# V2 implementation decisions

- Task ordering ambiguity: Task 1 says the store should enumerate `cwd-ancestor-md`,
  but Task 3 introduces that protocol type. Implementation will keep Task 1 focused
  on device-only store semantics using the current `CACHE_SCOPES`; Task 3 will extend
  `CACHE_SCOPES` and the store normalization will pick it up.
