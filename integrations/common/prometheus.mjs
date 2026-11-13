// Prometheus text rendering shared by every runtime adapter. One TYPE line
// per metric family; token/tool kinds become extra labels.

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderPrometheus({
  labels = {},
  tokens = {},
  tools = {},
  toolDurationMs = {},
  edits = {},
  permissions = {},
  contextMax = 0,
  durationSeconds = 0,
}) {
  const labelStr = Object.entries(labels).map(([k, v]) => `${esc(k)}="${esc(v)}"`).join(",");
  const withLabels = (extra) => `{${labelStr ? labelStr + "," : ""}${extra}}`;
  const bare = labelStr ? `{${labelStr}}` : "";
  const lines = [];

  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length) {
    lines.push("# TYPE agent_tokens_total counter");
    for (const [kind, value] of tokenEntries) {
      lines.push(`agent_tokens_total${withLabels(`kind="${esc(kind)}"`)} ${value}`);
    }
  }

  const toolEntries = Object.entries(tools);
  if (toolEntries.length) {
    lines.push("# TYPE agent_tool_calls_total counter");
    for (const [tool, value] of toolEntries) {
      lines.push(`agent_tool_calls_total${withLabels(`tool="${esc(tool)}"`)} ${value}`);
    }
  }

  const editEntries = Object.entries(edits).filter(([, value]) => value > 0);
  if (editEntries.length) {
    lines.push("# TYPE agent_file_edits_total counter");
    for (const [kind, value] of editEntries) {
      lines.push(`agent_file_edits_total${withLabels(`kind="${esc(kind)}"`)} ${value}`);
    }
  }

  const permissionEntries = Object.entries(permissions).filter(([, value]) => value > 0);
  if (permissionEntries.length) {
    lines.push("# TYPE agent_permission_decisions_total counter");
    for (const [decision, value] of permissionEntries) {
      lines.push(`agent_permission_decisions_total${withLabels(`decision="${esc(decision)}"`)} ${value}`);
    }
  }

  const durationEntries = Object.entries(toolDurationMs).filter(([, value]) => value > 0);
  if (durationEntries.length) {
    lines.push("# TYPE agent_tool_duration_seconds_total counter");
    for (const [tool, value] of durationEntries) {
      const seconds = Math.round((value / 1000) * 1000) / 1000;
      lines.push(`agent_tool_duration_seconds_total${withLabels(`tool="${esc(tool)}"`)} ${seconds}`);
    }
  }

  lines.push(`# TYPE agent_context_max_tokens gauge`);
  lines.push(`agent_context_max_tokens${bare} ${contextMax}`);
  lines.push(`# TYPE agent_run_duration_seconds gauge`);
  lines.push(`agent_run_duration_seconds${bare} ${durationSeconds}`);
  return lines.join("\n") + "\n";
}
