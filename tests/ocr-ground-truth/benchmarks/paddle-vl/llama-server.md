# Parallel Benchmark: llama-server

| Concurrency | Avg p95 ms | Avg throughput req/s | Best throughput req/s |
| ---: | ---: | ---: | ---: |
| 1 | 143.83 | 7.824 | 10.454 |
| 2 | 169.52 | 11.672 | 14.736 |
| 3 | 247.49 | 10.793 | 10.854 |

- Baseline p95 ms: `143.83`
- Knee @ 1.25x baseline: `2`
- Knee @ 1.50x baseline: `2`
