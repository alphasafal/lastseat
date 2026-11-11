### Steady run (realistic think time)

- Target: `http://127.0.0.1:4000`
- Virtual users: 100 readers + 10 writers, 10s ramp-up then 2m at full load
- Requests: 15062 total, 110.0 req/s
- Board requests: 12738 (93.0 req/s)
- Writes committed: 2212
- Failed requests: 0.000 %
- Checks passed: 100.000 %
- Thresholds: all passed

| Metric | median | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Board endpoints (all) | 2.8 ms | 5.6 ms | 7.7 ms | 15.6 ms | 73.3 ms |
| Writes (create, update, invite, leave) | 11.6 ms | 18.9 ms | 24.7 ms | 36.0 ms | 172.0 ms |
| All HTTP requests | 3.1 ms | 11.5 ms | 15.0 ms | 34.5 ms | 361.6 ms |
