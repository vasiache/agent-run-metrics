# Плагины для метрик AI-копилотов

Подборка для **coding copilots**: GitHub Copilot, Cursor, Claude Code, OpenCode и других помощников разработчика. Дата проверки публичных описаний — **12 ноября 2026 года**. Проверены документация и страницы проектов; установка и совместимость с конкретными версиями IDE не тестировались.

## Сбор в собственный backend

Эта группа интересна, если нужен не только экран со статистикой, но и источник событий для собственной системы наблюдаемости.

| Плагин | Для чего | Что собирает | Интеграция и ограничения |
|---|---|---|---|
| **[opentelemetry-hooks](https://pypi.org/project/opentelemetry-hooks/)** | Cursor, Claude Code, Codex, Gemini CLI, Copilot CLI/cloud agent, OpenCode, Windsurf | Сессии, вызовы инструментов и MCP, ошибки, subagents; токены — при наличии в событиях | Экспортирует **traces и logs** по OTLP; отдельный набор Metrics не документирован. Покрытие зависит от агента.[^1] |
| **[opencode-otel-plugin — felixti](https://github.com/felixti/opencode-otel-plugin)** | OpenCode | Токены, latency LLM, число запросов, compaction, изменённые строки, tool calls, Git/PR-операции | **Metrics + traces**, OTLP/HTTP protobuf; получает из Git email, remote URL и рабочие пути.[^2] |
| **[@gcornut/opencode-otel](https://github.com/gcornut/opencode-otel)** | OpenCode | Сессии, активное время, токены, стоимость, LOC, коммиты, PR, решения по инструментам | **Metrics + logs**, OTLP; есть профиль имён Claude Code. LOC и активное время приблизительные.[^3][^4] |
| **[OpenCode Telemetry Plugin — pai4451](https://github.com/pai4451/opencode-telemetry-plugin)** | OpenCode | Добавленные/удалённые строки, число и длительность tool calls, ошибки, ответы на permission requests | OTLP; атрибуты включают язык, файл и сессию. `accept/reject` относится к разрешениям, не к сохранению кода.[^5] |

**Конкретные имена метрик** для оценки интеграции:

- **felixti:** `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `opencode.session.request.count`, `opencode.session.compaction.count`, `opencode.file.changes`, `opencode.tool.invocations`, `opencode.vcs.operations`.[^2]
- **gcornut:** `session.count`, `active_time.total`, `token.usage`, `cost.usage`, `lines_of_code.count`, `commit.count`, `pull_request.count`, `tool.decision`, с префиксом выбранного профиля.[^3]
- **pai4451:** `opencode.tool.loc.added`, `opencode.tool.loc.deleted`, `opencode.tool.executions`, `opencode.tool.duration`, `opencode.permission.requests`.[^5]

## Расширения со статистикой

| Расширение | Где работает | Какие показатели | Важная оговорка |
|---|---|---|---|
| **[AI Engineering Fluency — Rob Bos](https://marketplace.visualstudio.com/items?itemName=robbos.ai-engineering-fluency)** | Расширение VS Code; читает логи нескольких IDE/CLI | Токены, оценочная стоимость, модели, режимы, tool/MCP usage, Fluency Score | Фактические токены при наличии, иначе оценка. JSON-экспорт; опциональная синхронизация в Azure.[^6] |
| **[Copilot Insight — nitta-a](https://marketplace.visualstudio.com/items?itemName=nitta-a.copilot-insight)** | VS Code и локальные записи Copilot CLI | Записанные показы/принятия completion, токены, AI credits, модели, история сессий | Локальная обработка, встроенный MCP. Completion-данные могут быть неполными; ROI и экономию времени больше не оценивает.[^7] |
| **[Copilot Insights — Emanuele Bartolesi](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-copilot-insights)** | VS Code; есть отдельное расширение Visual Studio | Квоты, остаток AI credits, расход, прогноз, история, приблизительная привязка к проектам | JSON/CSV; опрашивает внутренний GitHub endpoint. Это наблюдение баланса, не журнал отдельных запросов.[^8][^9] |
| **[Token Watch](https://marketplace.visualstudio.com/items?itemName=alvin0-dinhai.token-watch)** | VS Code; сессии Codex и Claude Code | Токены, оценочная стоимость, квоты | Локальные JSONL/SQLite; панели квот обращаются к провайдерам и могут обновлять OAuth credentials CLI.[^10] |

**Не перепутать названия:** `nitta-a.copilot-insight` и `emanuelebartolesi.vscode-copilot-insights` — разные расширения с разными источниками данных.[^7][^8]

## Время и вклад в код

| Инструмент | Что измеряет | Как подключается | Отличие от расхода токенов |
|---|---|---|---|
| **[WakaTime для Copilot CLI](https://github.com/wakatime/copilot-cli-wakatime)** | AI coding activity, время prompting, сгенерированные строки | Плагин Copilot CLI; отправляет heartbeats после prompts и file-edit events | Ориентирован на активность и время; данные доступны в WakaTime Dashboard.[^11][^12] |
| **[Git AI](https://github.com/git-ai-project/git-ai)** | AI-generated/committed строки, долю AI-кода, human overrides, разбивку по агенту и модели | Git-расширение с интеграциями агентов; `git ai stats --json` | Атрибуция на уровне строк и коммитов; это не счётчик принятия inline-подсказок. |

## Смежные решения

**[Copilot Metrics Viewer](https://github.com/marketplace/copilot-metrics-viewer)** — не IDE-плагин, а приложение поверх GitHub API: acceptance, пользователи, языки, agent/PR activity, seats; есть self-hosted и CSV.[^13]

**[Claude Code: встроенная телеметрия](https://code.claude.com/docs/it/monitoring-usage)** — отдельный плагин не обязателен: доступны OTel-счётчики сессий, токенов, стоимости, LOC, коммитов и PR.[^14]

## На что смотреть

Для собственного сборщика разумно начать с **opentelemetry-hooks** как межагентного источника lifecycle-событий и **felixti/opencode-otel-plugin** как примера явной схемы Metrics; это рекомендация по документированным интерфейсам, не результат эксплуатационного тестирования.[^1][^2]

Не смешивать **расход**, **активность**, **разрешение действия** и **сохранённый AI-код**: в найденных решениях это разные наблюдения, а не взаимозаменяемые метрики продуктивности.[^5][^7]

---

## References

1. [@thomasbonenfant/opencode-plugin-otel](https://www.npmjs.com/package/@thomasbonenfant%2Fopencode-plugin-otel) - ... opencode-plugin-otel`. There are no other projects in the npm registry ... opencode.token.usage,...

2. [github.com · felixti · opencode-otel-pluginGitHub - felixti/opencode-otel-plugin: OpenTelemetry...](https://github.com/felixti/opencode-otel-plugin) - |`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`|Metric temporality (`cumulative`, `delta`, `low...

3. [GitHub - gcornut/opencode-otel](https://github.com/gcornut/opencode-otel) - - Session count, active time, lines of code, tool decisions, commits, pull requests

4. [github.com › docs › claude-code-vs-opencode-otelclaude-code-vs-opencode-otel.md - GitHub](https://github.com/gcornut/opencode-otel/blob/master/docs/claude-code-vs-opencode-otel.md) - |Lines of code|Exact (git diff)|Approximate (from `file.edited` events + write/edit tool output line...

5. [git-ai/README.md at main · git-ai-project/git-ai · GitHub](https://github.com/git-ai-project/git-ai/blob/main/README.md) - Calculates % AI-code, AI-lines generated vs committed, accepted rates, human overrides broken down b...

6. [AI Engineering Fluency - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=robbos.ai-engineering-fluency) - Track your AI Engineering Fluency — daily and monthly token usage, cost estimates, and AI fluency in...

7. [Copilot Insight - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nitta-a.copilot-insight) - #### Metric and export changes in 1.1.14 The dashboard and Markdown reports no longer estimate devel...

8. [Copilot Insights](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-copilot-insights) - Install from the Visual Studio Marketplace: https://marketplace.visualstudio.com/items?itemName=eman...

9. [Copilot Insights - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscopilotinsight) - Copilot Insights gives you a fast, local view of the quota and entitlement data already associated w...

10. [Token Watch](https://marketplace.visualstudio.com/items?itemName=alvin0-dinhai.token-watch) - ... rotated tokens back to ~/.codex/auth.json or ~/.claude/.credentials.json (or ... Token Watch tod...

11. [WakaTime plugin for GitHub Copilot CLI](https://github.com/wakatime/copilot-cli-wakatime) - Install. copilot plugin marketplace add wakatime/copilot-cli-wakatime copilot plugin install copilot...

12. [Copilot CLI Time Tracking](https://wakatime.com/copilot-cli) - Installing · copilot plugin marketplace add wakatime/copilot-cli-wakatime · copilot plugin install c...

13. [Copilot Metrics Viewer · GitHub Marketplace](https://github.com/marketplace/copilot-metrics-viewer) - Copilot Metrics Viewer connects to the GitHub Copilot Usage Metrics API and presents your data throu...

14. [Monitoraggio - Claude Code Docs](https://code.claude.com/docs/it/monitoring-usage) - Traccia l’utilizzo di Claude Code, i costi e l’attività degli strumenti in tutta l’organizzazione es...

