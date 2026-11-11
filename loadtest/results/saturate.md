### Saturation run (no think time)

- Target: `http://127.0.0.1:4000`
- Virtual users: 100 readers + 10 writers, 10s ramp-up then 1m at full load
- Requests: 71388 total, 1012.5 req/s
- Board requests: 68868 (976.7 req/s)
- Writes committed: 2408
- Failed requests: 0.000 %
- Checks passed: 100.000 %
- Thresholds: all passed

| Metric | median | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Board endpoints (all) | 84.2 ms | 151.3 ms | 174.6 ms | 240.3 ms | 682.7 ms |
| Writes (create, update, invite, leave) | 245.1 ms | 412.6 ms | 481.7 ms | 701.0 ms | 1056.5 ms |
| All HTTP requests | 86.1 ms | 161.9 ms | 198.2 ms | 341.1 ms | 1437.2 ms |
