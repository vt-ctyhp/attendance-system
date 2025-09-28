# Dashboard Route History

`server/src/routes/dashboard.ts.bak` was kept as a snapshot of the dashboard route prior to the feature work that added timesheet exports, balance overviews, and the extended request enums.

That snapshot is still available in Git history (for example the initial import commit `cce1886095871dc3e5e38cf08a444a38c4549a95`). Retrieve it with:

```
git show cce1886095871dc3e5e38cf08a444a38c4549a95:server/src/routes/dashboard.ts.bak
```

Keeping the duplicate file in the working tree risked edits landing in the wrong copy. With the history note above, the working tree now tracks only the active implementation in `server/src/routes/dashboard.ts`.
