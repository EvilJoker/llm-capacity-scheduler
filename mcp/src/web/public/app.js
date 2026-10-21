/* 容量调度控制台前端：原生 JS，无构建步骤。 */

const state = {
  status: null,
  tasks: [],
  config: null,
  samples: [],
  selectedTaskId: null,
  lastErrorAt: 0,
};

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const message = data && data.error ? data.error : `HTTP ${resp.status}`;
    throw new Error(message);
  }
  return data;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 4200);
}

function fail(error) {
  const now = Date.now();
  if (now - state.lastErrorAt < 2500) return;
  state.lastErrorAt = now;
  toast(String(error && error.message ? error.message : error), true);
}

function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined) return "不可知";
  if (minutes < 0) return "已过期";
  if (minutes < 60) return `${minutes.toFixed(0)} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

const STATE_LABEL = {
  submitted: "已提交",
  queued: "排队中",
  deferred: "等待时机",
  admitted: "已准入",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
};
const STATE_CLASS = {
  submitted: "blue",
  queued: "blue",
  deferred: "warn",
  admitted: "blue",
  running: "warn",
  succeeded: "green",
  failed: "red",
  cancelled: "",
  expired: "",
};

const REASON_LABEL = {
  admit: "准入",
  work_hours_wait: "工作时段，等尾段",
  reserve: "余量到 reserve，停",
  slots: "并发槽位已满",
  window_too_short: "窗口装不下",
  self_busy: "检测到自用，让路",
  unknown: "观测不可信，不烧",
  unlimited: "无限额度不调度",
  no_bucket: "无匹配容量",
  no_model: "无匹配模型",
  no_runner: "无可用执行器",
  not_worth_cost: "付费不划算",
  balance: "余额不足",
  no_cost_estimate: "缺成本估算",
  burn_lead: "尾段开烧",
  idle_time: "空闲时段",
  opportunistic: "工作时段机会模式",
};

// --------------------------------------------------------------------- 状态

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
    renderStatus();
  } catch (error) {
    fail(error);
  }
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const sched = status.scheduler;
  $("scheduler-dot").className = `dot ${sched.started && !sched.paused ? "on" : "paused"}`;
  $("scheduler-text").textContent = sched.paused
    ? `暂停 · tick #${sched.tickCount}`
    : sched.started
      ? `调度中 · tick #${sched.tickCount}`
      : "已停止";
  $("btn-pause").textContent = sched.paused ? "恢复调度" : "暂停调度";
  $("clock").textContent = fmtTime(status.now);

  renderBucketCards($("bucket-cards"), status.buckets);
  renderCounts(status.taskCounts || {});
  renderRunning(status.running || []);
  renderDecisions(status.recentDecisions || []);
  renderEngineInfo(status);
  renderCapacityBuckets($("capacity-buckets"), status.buckets);
}

function renderBucketCards(target, buckets) {
  if (!target) return;
  if (!buckets || buckets.length === 0) {
    target.innerHTML = `<div class="panel empty">暂无容量桶：检查配置里的 providers 与 API Key。</div>`;
    return;
  }
  target.innerHTML = buckets
    .map((b) => {
      const remaining = b.unlimited ? "∞" : b.remaining === null ? "?" : `${b.remaining.toFixed(0)}%`;
      const pct = b.remaining === null ? 0 : Math.max(0, Math.min(100, b.remaining));
      const reservePct = Math.max(0, Math.min(100, b.reservePct || 0));
      const badge = b.unlimited ? "unlimited" : b.paid ? "付费" : b.perishable ? "易逝" : "—";
      const badgeClass = b.unlimited ? "blue" : b.paid ? "red" : b.perishable ? "green" : "";
      const source = b.source === "api" ? "api" : b.source;
      return `
      <div class="bucket">
        <div class="bhead">
          <div class="name">${esc(b.shortKey)}</div>
          <span class="badge ${badgeClass}">${badge}</span>
        </div>
        <div class="value">${remaining}<small>${b.unit === "pct" ? "剩余" : b.unit}</small></div>
        <div class="bar">
          <div class="fill" style="width:${pct}%"></div>
          <div class="reserve" style="left:${reservePct}%" title="reserve=${b.reservePct}%"></div>
        </div>
        <div class="meta">
          <span>窗口 ${b.windowStartMs ? fmtTime(b.windowStartMs).slice(6) : "?"} → ${b.windowEndMs ? fmtTime(b.windowEndMs).slice(6) : "?"}</span>
          <span>${b.minutesToEnd === null ? "" : "剩 " + fmtDuration(b.minutesToEnd)}</span>
        </div>
        <div class="meta" style="margin-top:6px">
          <span>src=${esc(source)} · ${esc(b.lifecycle)}</span>
          <span title="策略要求保留的余量">reserve ${b.reservePct}%</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderCounts(counts) {
  const order = ["running", "deferred", "queued", "submitted", "succeeded", "failed", "expired", "cancelled"];
  const entries = order.filter((k) => counts[k]).map((k) => [k, counts[k]]);
  $("counts").innerHTML = entries.length
    ? entries.map(([k, v]) => `<span class="chip">${STATE_LABEL[k] || k} <b>${v}</b></span>`).join("")
    : `<span class="empty">队列为空</span>`;
}

function renderRunning(runs) {
  if (!runs.length) {
    $("running").innerHTML = `<div class="empty">没有正在执行的 run</div>`;
    return;
  }
  $("running").innerHTML = `
    <table>
      <thead><tr><th>run</th><th>任务</th><th>provider / model</th><th>est</th><th>开始</th></tr></thead>
      <tbody>
        ${runs
          .map(
            (r) => `<tr>
              <td class="mono">${esc(r.id.slice(-6))}</td>
              <td class="mono">${esc(r.taskId.slice(-8))}</td>
              <td class="mono">${esc(r.provider)} / ${esc(r.model)}<br><span class="hint">${esc(r.runner)}</span></td>
              <td class="mono">${Number(r.est).toFixed(2)}</td>
              <td class="mono">${fmtTime(r.startedAt)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderDecisions(decisions) {
  if (!decisions.length) {
    $("decisions").innerHTML = `<div class="empty">还没有决策记录（先跑一次 tick）</div>`;
    return;
  }
  $("decisions").innerHTML = `
    <table>
      <thead><tr><th>时间</th><th>任务</th><th>桶</th><th>决策</th><th>remaining / reserve / est</th></tr></thead>
      <tbody>
        ${decisions
          .slice(0, 40)
          .map((d) => {
            const label = REASON_LABEL[d.reason] || d.reason;
            return `<tr>
              <td class="mono">${fmtTime(d.now)}</td>
              <td class="mono">${esc(String(d.taskId).slice(-8))}</td>
              <td class="mono">${esc(d.bucket)}</td>
              <td><span class="reason ${d.admit ? "ok" : "no"}">${esc(label)}</span></td>
              <td class="mono">${d.remaining === null ? "?" : Number(d.remaining).toFixed(1)} / ${Number(d.reserve).toFixed(1)} / ${Number(d.est).toFixed(1)}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

function renderEngineInfo(status) {
  const sched = status.scheduler;
  const policy = status.policy;
  const info = [
    ["tick", `${sched.tickSeconds}s · #${sched.tickCount}`],
    ["上次 tick", sched.lastTickAt ? fmtTime(sched.lastTickAt) : "从未"],
    ["下次 tick", sched.nextTickAt ? fmtTime(sched.nextTickAt) : "-"],
    ["策略", policy.name],
    ["工作时段", `${policy.usage.workStart}–${policy.usage.workEnd}`],
    ["自用速率", `工作 ${policy.usage.workRatePctPerHour}%/h · 空闲 ${policy.usage.offhoursRatePctPerHour}%/h`],
    ["尾段阈值", `${policy.burnLeadMinutes} 分钟`],
    ["reserve 下限", `${policy.minReservePct}%`],
    ["最大并发", `全局 ${status.policy.maxParallel} · 默认 ${status.runners.default}`],
    ["执行器", (status.runners.available || []).join(" / ")],
    ["队列", `${(status.queue || []).length} 个等待中`],
  ];
  $("engine-info").innerHTML = info
    .map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join("");
  const last = status.lastTick;
  $("engine-hint").textContent = last
    ? `最近 tick：spawn ${last.spawned} · reap ${last.reaped} · 抢占 ${last.interrupted} · 过期 ${last.expired}`
    : "";
}

// --------------------------------------------------------------------- 任务

async function refreshTasks() {
  try {
    const filter = $("task-filter").value;
    const query = filter ? `?state=${encodeURIComponent(filter)}&limit=100` : "?limit=100";
    state.tasks = await api(`/api/tasks${query}`);
    renderTaskTable();
    if (state.selectedTaskId) await renderTaskDetail(state.selectedTaskId);
  } catch (error) {
    fail(error);
  }
}

function renderTaskTable() {
  const tasks = state.tasks || [];
  if (!tasks.length) {
    $("task-table").innerHTML = `<div class="empty">还没有任务</div>`;
    return;
  }
  $("task-table").innerHTML = `
    <table>
      <thead><tr><th>状态</th><th>任务</th><th>内容</th><th>值</th><th>尝试</th><th>创建</th><th></th></tr></thead>
      <tbody>
        ${tasks
          .map((t) => {
            const cls = STATE_CLASS[t.state] || "";
            const content = t.cmd ? `$ ${esc((t.cmd || []).join(" "))}` : esc(t.prompt || "");
            const active = state.selectedTaskId === t.id ? ' style="background:rgba(79,209,197,.06)"' : "";
            const canCancel = ["submitted", "queued", "deferred", "admitted"].includes(t.state);
            return `<tr${active}>
              <td><span class="badge ${cls}">${STATE_LABEL[t.state] || t.state}</span></td>
              <td class="mono">${esc(t.id.slice(-8))}<br><span class="hint">${esc(t.task_class || "")} ${t.has_checkpoint ? "· cp" : ""}</span></td>
              <td><div class="task-cmd" title="${esc(content)}">${content}</div></td>
              <td class="mono">${t.value}</td>
              <td class="mono">${t.attempts}</td>
              <td class="mono">${fmtTime(t.createdAt)}</td>
              <td class="row-actions">
                <button class="btn ghost" data-detail="${esc(t.id)}">详情</button>
                ${canCancel ? `<button class="btn danger" data-cancel="${esc(t.id)}">取消</button>` : ""}
              </td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  $("task-table")
    .querySelectorAll("[data-detail]")
    .forEach((el) => el.addEventListener("click", () => renderTaskDetail(el.dataset.detail)));
  $("task-table")
    .querySelectorAll("[data-cancel]")
    .forEach((el) =>
      el.addEventListener("click", async () => {
        try {
          await api(`/api/tasks/${encodeURIComponent(el.dataset.cancel)}/cancel`, { method: "POST" });
          toast("任务已取消");
          await refreshTasks();
          await refreshStatus();
        } catch (error) {
          fail(error);
        }
      }),
    );
}

async function renderTaskDetail(taskId) {
  state.selectedTaskId = taskId;
  try {
    const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    const runs = task.runs || [];
    const rows = runs.length
      ? runs
          .map((run) => {
            const artifacts = (run.artifacts || [])
              .map(
                (name) =>
                  `<a href="/api/tasks/${encodeURIComponent(taskId)}/artifact?run=${encodeURIComponent(
                    run.id,
                  )}&name=${encodeURIComponent(name)}" target="_blank">${esc(name)}</a>`,
              )
              .join(" ");
            return `<tr>
              <td class="mono">${esc(run.id.slice(-8))}</td>
              <td><span class="badge ${run.status === "succeeded" ? "green" : run.status === "running" ? "warn" : "red"}">${esc(run.status)}</span></td>
              <td class="mono">${esc(run.provider)} / ${esc(run.model)}</td>
              <td class="mono">est ${Number(run.est).toFixed(2)}${run.quotaDelta !== null ? ` · Δ${Number(run.quotaDelta).toFixed(1)}` : ""}</td>
              <td class="mono">${fmtTime(run.started_at)} → ${fmtTime(run.ended_at)}</td>
              <td class="artifacts">${artifacts || '<span class="hint">无产物</span>'}</td>
              <td class="mono">${run.error ? esc(run.error) : ""}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="empty">还没有执行记录（可能仍在等待时机）</td></tr>`;
    $("task-detail").innerHTML = `
      <div class="run-box">
        <div class="panel-head"><h2>任务详情 ${esc(task.id)}</h2>
          <span class="hint">${STATE_LABEL[task.state] || task.state} · 尝试 ${task.attempts} · 价值 ${task.value}${task.error ? " · 错误: " + esc(task.error) : ""}</span>
        </div>
        <table>
          <thead><tr><th>run</th><th>状态</th><th>provider / model</th><th>est / Δ</th><th>时间</th><th>产物</th><th>错误</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (error) {
    fail(error);
  }
}

function parseCmdInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fallthrough */
    }
  }
  return trimmed.split(/\s+/);
}

function parseDeadlineInput(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function submitTask(event) {
  event.preventDefault();
  const runner = $("f-runner").value;
  const body = {
    runner,
    value: Number($("f-value").value || 50),
    task_class: $("f-class").value || "default",
  };
  if (runner === "shell") {
    body.cmd = parseCmdInput($("f-cmd").value);
  } else {
    body.prompt = $("f-prompt").value.trim();
  }
  if ($("f-tokens").value) body.tokens = Number($("f-tokens").value);
  if ($("f-estpct").value) body.est_pct = Number($("f-estpct").value);
  if ($("f-deadline").value) body.deadline = parseDeadlineInput($("f-deadline").value);
  if ($("f-idem").value.trim()) body.idempotency_key = $("f-idem").value.trim();
  const artifacts = $("f-artifacts").value.trim();
  if (artifacts) body.expect_artifacts = artifacts.split(",").map((s) => s.trim()).filter(Boolean);
  const verify = $("f-verify").value.trim();
  if (verify) body.verify_cmd = parseCmdInput(verify);
  try {
    const result = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    toast(`已提交 ${result.task_id}\n当前状态: ${STATE_LABEL[result.state] || result.state}（等待时机是正常的）`);
    await refreshTasks();
    await refreshStatus();
  } catch (error) {
    fail(error);
  }
}

// --------------------------------------------------------------------- 容量

function renderCapacityBuckets(target, buckets) {
  if (!target) return;
  if (!buckets || !buckets.length) {
    target.innerHTML = `<div class="empty">暂无容量桶</div>`;
    return;
  }
  target.innerHTML = `
    <table>
      <thead><tr><th>桶</th><th>生命周期</th><th>余量</th><th>窗口</th><th>剩余</th><th>reserve</th><th>来源</th></tr></thead>
      <tbody>
        ${buckets
          .map(
            (b) => `<tr>
              <td class="mono">${esc(b.shortKey)}</td>
              <td class="mono">${esc(b.lifecycle)}${b.unlimited ? " (∞)" : ""}</td>
              <td class="mono">${b.remaining === null ? "?" : Number(b.remaining).toFixed(1)} ${esc(b.unit)}</td>
              <td class="mono">${b.windowStartMs ? fmtTime(b.windowStartMs) : "?"} → ${b.windowEndMs ? fmtTime(b.windowEndMs) : "?"}</td>
              <td class="mono">${fmtDuration(b.minutesToEnd)}</td>
              <td class="mono">${Number(b.reservePct).toFixed(1)}%</td>
              <td class="mono">${esc(b.source)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

async function refreshSamples() {
  try {
    state.samples = await api("/api/samples?limit=200");
    const rows = state.samples
      .slice()
      .reverse()
      .map(
        (s) => `<tr>
          <td class="mono">${fmtTime(s.ts)}</td>
          <td class="mono">${esc(s.provider)}/${esc(s.modelFamily)}/${esc(s.resourceKind)}</td>
          <td class="mono">${s.remaining === null ? "?" : Number(s.remaining).toFixed(1)}</td>
          <td class="mono">${esc(s.source)}</td>
        </tr>`,
      )
      .join("");
    $("samples").innerHTML = state.samples.length
      ? `<table><thead><tr><th>时间</th><th>桶</th><th>余量</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">暂无采样</div>`;
  } catch (error) {
    fail(error);
  }
}

// --------------------------------------------------------------------- 配置

function cfgPath(path, label, type = "text", options = {}) {
  const { step = "", placeholder = "", span = "" } = options;
  const cls = span ? ` class="${span}"` : "";
  return `<label${cls}>${esc(label)}<input name="${path}" data-path="${path}" data-type="${type}" type="${type === "number" ? "number" : type === "password" ? "password" : "text"}" ${step ? `step="${step}"` : ""} placeholder="${esc(placeholder)}" /></label>`;
}

function cfgCheck(path, label) {
  return `<label><span class="check-line"><input name="${path}" data-path="${path}" data-type="bool" type="checkbox" /> ${esc(label)}</span></label>`;
}

function cfgSelect(path, label, pairs) {
  return `<label>${esc(label)}<select name="${path}" data-path="${path}" data-type="text">${pairs
    .map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`)
    .join("")}</select></label>`;
}

function renderConfigForm() {
  const config = state.config;
  if (!config) return;
  const providerBlocks = (config.providers || [])
    .map((provider, index) => {
      const base = `providers.${index}`;
      let extra = "";
      if (provider.kind === "minimax") {
        extra = `
          ${cfgPath(`${base}.options.apiKey`, "API Key", "password", { placeholder: "*** 或留空使用 env/file" })}
          ${cfgPath(`${base}.options.apiKeyEnv`, "API Key 环境变量")}
          ${cfgPath(`${base}.options.apiKeyFile`, "API Key 文件")}
          ${cfgPath(`${base}.options.families`, "families（逗号分隔）")}
          ${cfgPath(`${base}.options.textTokensPerPct`, "每 1% ≈ token 数", "number")}`;
      } else if (provider.kind === "payg") {
        extra = `
          ${cfgPath(`${base}.options.stateFile`, "余额状态文件")}
          ${cfgPath(`${base}.options.unitPricePer1kTokens`, "单价 / 1k token", "number", { step: "0.0001" })}`;
      }
      return `
        <div class="span3" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">
          <div class="panel-head"><h2>Provider: ${esc(provider.name)} <span class="hint">${esc(provider.kind)}</span></h2></div>
        </div>
        ${cfgCheck(`${base}.enabled`, "启用")}
        ${cfgPath(`${base}.name`, "名称")}
        ${cfgPath(`${base}.kind`, "kind（minimax/payg/mock）")}
        ${extra}`;
    })
    .join("");

  $("config-form").innerHTML = `
    <div class="span3"><h2>引擎</h2></div>
    ${cfgPath("engine.tickSeconds", "tick 间隔（秒）", "number")}
    ${cfgPath("engine.maxParallel", "全局最大并发", "number")}
    ${cfgPath("engine.web.port", "Web 端口（改动需重启）", "number")}
    ${cfgPath("engine.stateFile", "状态文件", "text", { span: "span2" })}
    ${cfgPath("engine.artifactsDir", "产物目录")}

    <div class="span3" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px"><h2>策略</h2></div>
    ${cfgPath("policy.burnLeadMinutes", "尾段阈值（分钟）", "number")}
    ${cfgPath("policy.minReservePct", "reserve 下限 %", "number", { step: "0.1" })}
    ${cfgPath("policy.safetyFactor", "安全系数", "number", { step: "0.1" })}
    ${cfgPath("policy.defaultEstPct", "默认单任务消耗 %", "number", { step: "0.1" })}
    ${cfgPath("policy.maxConcurrentPerBucket", "单桶并发上限", "number")}
    ${cfgPath("policy.maxAttempts", "最大尝试次数", "number")}
    ${cfgPath("policy.usage.workStart", "工作开始 HH:MM")}
    ${cfgPath("policy.usage.workEnd", "工作结束 HH:MM")}
    ${cfgPath("policy.usage.workdays", "工作日（1=周一，逗号）")}
    ${cfgPath("policy.usage.workRatePctPerHour", "工作时段自用 %/h", "number", { step: "0.5" })}
    ${cfgPath("policy.usage.offhoursRatePctPerHour", "空闲时段自用 %/h", "number", { step: "0.1" })}
    ${cfgCheck("policy.workHoursOpportunistic", "工作时段也允许机会式开烧（谨慎）")}

    <div class="span3" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px"><h2>执行器</h2></div>
    ${cfgSelect("runners.default", "默认执行器", [["shell", "shell"], ["dsh", "dsh headless"]])}
    ${cfgCheck("runners.shell.enabled", "启用 shell")}
    ${cfgCheck("runners.dsh.enabled", "启用 dsh headless")}
    ${cfgPath("runners.dsh.command", "dsh 命令")}
    ${cfgPath("runners.dsh.profile", "dsh profile")}

    <div class="span3" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px"><h2>Provider</h2></div>
    ${providerBlocks}
  `;
  // 回填
  for (const el of $("config-form").querySelectorAll("[data-path]")) {
    const value = getByPath(config, el.dataset.path);
    if (el.dataset.type === "bool") el.checked = Boolean(value);
    else if (el.dataset.type === "numlist") el.value = Array.isArray(value) ? value.join(",") : String(value ?? "");
    else if (Array.isArray(value)) el.value = value.join(",");
    else if (value !== undefined && value !== null) el.value = String(value);
  }
  $("config-json").value = JSON.stringify(config, null, 2);
}

function getByPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function collectConfigForm() {
  const config = structuredClone(state.config);
  for (const el of $("config-form").querySelectorAll("[data-path]")) {
    const path = el.dataset.path;
    const type = el.dataset.type;
    let value;
    if (type === "bool") value = el.checked;
    else if (type === "number") value = el.value === "" ? undefined : Number(el.value);
    else if (type === "numlist") value = el.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else {
      const raw = el.value;
      // families / workdays 这类数组字段用逗号分隔
      if (["providers", "models"].some((prefix) => path.startsWith(prefix)) && /\.(families|modalities)$/.test(path)) {
        value = raw.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        value = raw;
      }
    }
    if (value !== undefined) setByPath(config, path, value);
  }
  return config;
}

async function loadConfig() {
  try {
    state.config = await api("/api/config");
    renderConfigForm();
  } catch (error) {
    fail(error);
  }
}

async function saveConfig(config) {
  try {
    const result = await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
    state.config = result.config;
    renderConfigForm();
    toast("配置已保存并热加载");
    await refreshStatus();
  } catch (error) {
    fail(error);
  }
}

// --------------------------------------------------------------------- 初始化

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${name}`));
  if (name === "tasks") void refreshTasks();
  if (name === "capacity") void refreshSamples();
  if (name === "config") void loadConfig();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));

  $("btn-tick").addEventListener("click", async () => {
    $("btn-tick").disabled = true;
    try {
      const report = await api("/api/tick", { method: "POST" });
      toast(
        `tick #${report.tick_id}：spawn ${report.spawned.length} · reap ${report.reaped.length} · 抢占 ${report.interrupted.length}` +
          (report.decisions.length ? `\n${report.decisions[0].task_id.slice(-8)} → ${REASON_LABEL[report.decisions[0].reason] || report.decisions[0].reason}` : ""),
      );
      await refreshStatus();
      await refreshTasks();
    } catch (error) {
      fail(error);
    } finally {
      $("btn-tick").disabled = false;
    }
  });

  $("btn-pause").addEventListener("click", async () => {
    const paused = state.status?.scheduler?.paused;
    try {
      await api(`/api/scheduler/${paused ? "resume" : "pause"}`, { method: "POST" });
      await refreshStatus();
    } catch (error) {
      fail(error);
    }
  });

  $("f-runner").addEventListener("change", () => {
    const isShell = $("f-runner").value === "shell";
    $("f-cmd-wrap").classList.toggle("hidden", !isShell);
    $("f-prompt-wrap").classList.toggle("hidden", isShell);
  });
  $("task-form").addEventListener("submit", submitTask);
  $("btn-refresh-tasks").addEventListener("click", () => void refreshTasks());
  $("task-filter").addEventListener("change", () => void refreshTasks());

  $("btn-observe").addEventListener("click", async () => {
    try {
      await api("/api/observe", { method: "POST" });
      toast("已观测一次容量");
      await refreshStatus();
      await refreshSamples();
    } catch (error) {
      fail(error);
    }
  });
  $("btn-refresh-samples").addEventListener("click", () => void refreshSamples());

  $("btn-save-config").addEventListener("click", () => void saveConfig(collectConfigForm()));
  $("btn-reload-config").addEventListener("click", () => void loadConfig());
  $("btn-sync-json").addEventListener("click", () => {
    try {
      state.config = JSON.parse($("config-json").value);
      renderConfigForm();
      toast("已从 JSON 同步到表单");
    } catch (error) {
      fail(error);
    }
  });
  $("btn-save-json").addEventListener("click", () => {
    try {
      void saveConfig(JSON.parse($("config-json").value));
    } catch (error) {
      fail(error);
    }
  });
}

async function bootstrap() {
  bindEvents();
  await loadConfig();
  await refreshStatus();
  await refreshTasks();
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshStatus();
  }, 3000);
  setInterval(() => {
    if (document.visibilityState === "visible" && document.getElementById("tab-tasks").classList.contains("active")) {
      void refreshTasks();
    }
  }, 4000);
  setInterval(() => {
    if (state.status) $("clock").textContent = fmtTime(state.status.now);
  }, 1000);
}

void bootstrap();
