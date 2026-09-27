# agent-run-metrics

Наблюдаемость прогонов coding-агентов: **сколько токенов, денег и ретраев
стоит одна задача** и где именно они сгорают. Self-hosted: данные не покидают
машину (PushGateway/OTLP ставится у вас).

Работает с OpenCode (первый адаптер), дальше — Claude Code, Codex CLI и другие
популярные агенты (адаптеры добавляются по мере).

## Состав

| Путь | Что |
|---|---|
| `analyzers/opencode/opencode_run_timeline.py` | анализатор прогона по локальной базе OpenCode: таймлайн «ход модели → вызов инструмента → замечание гейта», токены от правки до замечания, проверка «план раньше кода» |
| `plugin/opencode/metrics.js` | OpenCode-плагин: realtime-счётчики токенов/инструментов → PushGateway (текстовый формат Prometheus) |
| `dashboards/agent-run-cost.json` | Grafana-дашборд: токены, стоимость, tool calls, context window, edit→gate |
| `alerts/vmalert.yml` | базовые правила аномалий: всплеск токенов, всплеск ретраев гейтов, медленный фидбек |

## Quickstart — анализатор (1 минута)

Ничего не устанавливает, база читается только на чтение:

```bash
python3 analyzers/opencode/opencode_run_timeline.py --list
python3 analyzers/opencode/opencode_run_timeline.py \
    --session <id> \
    --gate-regex 'gate:|verifier|гейт' \
    --watch 'Logging|logback' \
    --push-gateway http://pushgateway.monitoring:9091 \
    --label user=vasche --label task=BLK-15397
```

Итог сессии уходит в PushGateway как batch-job: `agent_session_tokens_total`,
`agent_session_cost_total`, `agent_session_duration_seconds`,
`agent_edit_to_gate_seconds`.

## Quickstart — realtime-плагин OpenCode

```bash
mkdir -p <project>/.opencode/plugin
cp plugin/opencode/metrics.js <project>/.opencode/plugin/metrics.js

AGENT_METRICS_PUSHGATEWAY=http://pushgateway.monitoring:9091 \
AGENT_METRICS_LABELS="user=vasche,profile=test" opencode
```

Счётчики: `opencode_agent_tokens_total{kind}`, `opencode_agent_tool_calls_total{tool}`,
`opencode_agent_context_max_tokens`. Push раз в 15 с при активности и сразу
по `session.idle`. Ошибки пуша никогда не ломают агента.

## Стек

```text
OpenCode (плагин) ──▶ PushGateway ──vmagent──▶ VictoriaMetrics ──▶ Grafana
```

Готовый дашборд — `dashboards/agent-run-cost.json` (импорт в Grafana,
datasource = ваш Prometheus/VictoriaMetrics). Правила аномалий —
`alerts/vmalert.yml` (vmalert из пакета VictoriaMetrics).

## Лицензия

Apache-2.0. Продукт self-hosted: данные не покидают вашу инфраструктуру.

## Дорожная карта

- [x] Анализатор OpenCode (таймлайн, токены, гейты, план-до-кода)
- [x] Пуш итога сессии в PushGateway
- [x] Базовый плагин OpenCode (realtime-счётчики)
- [x] Дашборд Grafana + vmalert-правила
- [ ] Поддержка Claude Code (JSONL-сессии)
- [ ] Поддержка Codex CLI, Cursor
- [ ] Token-helper (short-lived identity) для OpenCode/Claude Code
- [ ] Multi-agent dashboard (несколько агентов на одной панели)
