import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Check, ChevronRight, Clock3,
  Download, FileText, History, LayoutDashboard, LoaderCircle, Pause, Play,
  RefreshCw, RotateCcw, Shield, Square, Workflow, X,
} from "lucide-react";
import { api, checkApiHealth } from "./api.js";

const SCENARIO_GROUPS = [
  ["Normal Execution", [
    ["happy_path", "Happy Path", "Every task succeeds through the master DAG."],
  ]],
  ["Task Failures", [
    ["temporary_failure", "Transient Failure", "The selected task fails once, then recovers on retry."],
    ["poison_task", "Poison / Permanent Failure", "Repeated failures exhaust the retry budget."],
    ["permanent_failure", "Permanent Failure", "The external fetch fails and downstream tasks are skipped."],
    ["independent_branch_failure", "Independent Branch Failure", "Health Check fails while main processing continues."],
  ]],
  ["Infrastructure Failures", [
    ["worker_crash", "Worker Crash", "Simulated interruption followed by worker recovery."],
    ["service_unavailable", "Service Unavailable", "Unavailable dependency fails requests before recovery."],
    ["circuit_breaker", "Circuit Breaker", "Observe CLOSED, OPEN, and HALF-OPEN transitions."],
  ]],
  ["Performance Issues", [
    ["slow_task", "Slow Task", "A task remains running while its timer progresses."],
    ["timeout", "Timeout", "Execution exceeds the configured task timeout."],
  ]],
  ["Advanced Recovery", [
    ["duplicate_delivery", "Duplicate Delivery / Idempotency", "Duplicate work is detected and suppressed."],
    ["replay_audit", "Replay Audit", "Replay a previous execution and compare outcomes."],
  ]],
];
const ALL_SCENARIOS = SCENARIO_GROUPS.flatMap(([, items]) => items);
const MASTER_NODES = [
  { id: "start", name: "START", x: 350, y: 30 },
  { id: "data-fetch", name: "DATA FETCH", x: 210, y: 125 },
  { id: "health-check", name: "HEALTH CHECK", x: 490, y: 125 },
  { id: "data-validation", name: "DATA VALIDATION", x: 210, y: 220 },
  { id: "data-processing", name: "DATA PROCESSING", x: 210, y: 315 },
  { id: "report-generation", name: "REPORT GENERATION", x: 210, y: 410 },
];
const EDGES = [
  ["start", "data-fetch"], ["start", "health-check"], ["data-fetch", "data-validation"],
  ["data-validation", "data-processing"], ["data-processing", "report-generation"],
];

const statusClass = (status = "PENDING") => status.toLowerCase().replaceAll("_", "-");
const formatDate = (value) => value ? new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", timeStyle: "medium",
}).format(new Date(value)) : "—";
const formatDuration = (milliseconds) => milliseconds == null ? "—"
  : milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
const durationFor = (execution) => execution?.durationMs ??
  (execution?.startedAt && execution?.endedAt
    ? Math.max(0, Date.parse(execution.endedAt) - Date.parse(execution.startedAt))
    : null);

function Status({ value }) {
  return <span className={`status-badge ${statusClass(value)}`}>
    <i />{(value ?? "PENDING").replaceAll("_", " ")}
  </span>;
}

function Stat({ label, value, icon: Icon, tone }) {
  return <article className="stat-card">
    <div className={`stat-icon ${tone}`}><Icon size={18} /></div>
    <div className="stat-label">{label}</div><div className="stat-value">{value ?? 0}</div>
  </article>;
}

function MasterDag({ tasks = [], onNode, selectedTaskId, large = false }) {
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  const nodePosition = (id) => MASTER_NODES.find((node) => node.id === id);
  return <div className={`master-dag ${large ? "master-dag-large" : ""}`} role="group" aria-label="Master resilience DAG">
    <svg className="dag-svg" viewBox="0 0 700 470" preserveAspectRatio="xMidYMin meet">
      {EDGES.map(([from, to]) => {
        const a = nodePosition(from);
        const b = nodePosition(to);
        const complete = ["SUCCESS", "FAILED", "TIMED_OUT", "SKIPPED"].includes(taskMap.get(from)?.status);
        return <line key={`${from}-${to}`} x1={a.x} y1={a.y + 38} x2={b.x} y2={b.y}
          className={`dag-edge ${complete ? "dag-edge-active" : ""}`} />;
      })}
    </svg>
    {MASTER_NODES.map((node) => {
      const task = taskMap.get(node.id);
      const status = task?.status ?? "PENDING";
      return <button
        key={node.id}
        className={`dag-node dag-${statusClass(status)} ${selectedTaskId === node.id ? "dag-node-selected" : ""}`}
        style={{ left: `calc(${node.x / 700 * 100}% - 82px)`, top: node.y }}
        onClick={() => onNode?.(node.id)}
        title={node.name}
      >
        <span className="dag-node-status"><i />{status}</span>
        <b>{node.name}</b>
        <small>Attempt {task?.attempts ?? 0} · {formatDuration(task?.durationMs)}</small>
        {task?.error && <span className="dag-error">!</span>}
      </button>;
    })}
  </div>;
}

export default function App() {
  const [section, setSection] = useState("simulator");
  const [apiStatus, setApiStatus] = useState("checking");
  const [templates, setTemplates] = useState([]);
  const [stats, setStats] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [logs, setLogs] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [scenario, setScenario] = useState("happy_path");
  const [targetTask, setTargetTask] = useState("data-fetch");
  const [config, setConfig] = useState({
    maxAttempts: 3, taskTimeoutMs: 1000, artificialDelayMs: 500, retryDelayMs: 25,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [csvInput, setCsvInput] = useState(null);
  const [textInput, setTextInput] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");
  const [logFilter, setLogFilter] = useState("ALL");

  const refresh = useCallback(async () => {
    try {
      await checkApiHealth();
      const [templateRows, dashboardStats, executionRows] = await Promise.all([
        api.get("/api/templates"), api.get("/api/dashboard/stats"),
        api.get("/api/executions?limit=100"),
      ]);
      setTemplates(templateRows); setStats(dashboardStats); setExecutions(executionRows);
      setApiStatus("connected");
    } catch (cause) {
      setApiStatus("disconnected");
      throw cause;
    }
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause.message));
    const timer = window.setInterval(() => refresh().catch(() => setApiStatus("disconnected")), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedExecutionId) {
      setDetail(null); setLogs([]); setAttempts([]); return;
    }
    let active = true;
    const load = async () => {
      try {
        const [execution, taskRows, executionLogs, attemptRows] = await Promise.all([
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}`),
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}/tasks`),
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}/logs`),
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}/attempts`),
        ]);
        if (active) {
          setDetail({ ...execution, tasks: taskRows });
          setLogs(executionLogs); setAttempts(attemptRows);
          setSelectedTaskId((current) => current || taskRows[0]?.taskId || "");
        }
      } catch (cause) {
        if (active) setError(cause.message);
      }
    };
    load();
    const timer = window.setInterval(load, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedExecutionId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedScenario = ALL_SCENARIOS.find(([, label]) => label) && ALL_SCENARIOS.find(([id]) => id === scenario);
  const selectedTask = detail?.tasks?.find((task) => task.taskId === selectedTaskId);
  const taskAttempts = attempts.filter((attempt) => attempt.taskId === selectedTaskId);
  const run = async () => {
    setBusy(true); setError("");
    try {
      const result = await api.post("/api/executions", {
        templateId: "resilience-recovery",
        parameters: { scenario, targetTask, failureProbability: 0,
          maxAttempts: config.maxAttempts, taskTimeoutMs: config.taskTimeoutMs,
          artificialDelayMs: config.artificialDelayMs,
        },
      });
      setSelectedExecutionId(result.executionId);
      setSelectedTaskId("");
      await refresh();
      setToast("Resilience execution started");
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!selectedExecutionId) return;
    try {
      await api.post(`/api/executions/${encodeURIComponent(selectedExecutionId)}/cancel`);
      setToast("Cancellation requested");
    } catch (cause) {
      setError(cause.message);
    }
  };
  const replay = async (executionId = selectedExecutionId) => {
    if (!executionId) return;
    try {
      const result = await api.post(`/api/executions/${encodeURIComponent(executionId)}/replay`);
      setSelectedExecutionId(result.executionId);
      setSection("simulator");
      setToast("Replay execution started");
    } catch (cause) {
      setError(cause.message);
    }
  };
  const reset = () => {
    setSelectedExecutionId(""); setDetail(null); setLogs([]); setAttempts([]); setSelectedTaskId("");
  };

  const nav = [
    ["dashboard", "Dashboard", LayoutDashboard],
    ["simulator", "Resilience Lab", Shield],
    ["history", "Execution History", History],
    ["analytics", "Execution Analytics", BarChart3],
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Workflow size={19} /></div><div><strong>ORBIT<span>.</span></strong><small>DAG CONTROL ROOM</small></div></div>
      <nav className="main-nav">
        {nav.map(([id, label, Icon]) => <button key={id} className={`nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span></button>)}
        <button className="nav-item" onClick={() => setSection("templates")}><FileText size={16} /><span>Templates</span></button>
      </nav>
      <div className="sidebar-bottom"><div className={`connection-indicator api-${apiStatus}`}><i className="live-dot" />API {apiStatus}</div></div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumb"><span>Orchestrator</span><ChevronRight size={14} /><strong>{nav.find(([id]) => id === section)?.[1] ?? "Templates"}</strong></div>
        <div className="topbar-actions"><span className="topbar-clock"><i className="live-dot" />Live updates</span><button className="icon-button" onClick={() => refresh().catch((cause) => setError(cause.message))} aria-label="Refresh"><RefreshCw size={17} /></button></div>
      </header>
      <div className="page-content">
        {error && <div className="alert-banner"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}
        {section === "simulator" && <Simulator
          scenario={scenario} setScenario={setScenario} targetTask={targetTask} setTargetTask={setTargetTask}
          config={config} setConfig={setConfig} detail={detail} logs={logs} selectedTaskId={selectedTaskId}
          setSelectedTaskId={setSelectedTaskId} selectedTask={selectedTask} taskAttempts={taskAttempts}
          logFilter={logFilter} setLogFilter={setLogFilter} run={run} cancel={cancel} reset={reset}
          replay={() => replay()} busy={busy}
        />}
        {section === "history" && <HistoryPage executions={executions} filter={historyFilter} setFilter={setHistoryFilter}
          open={(execution) => { setSelectedExecutionId(execution.id); setSection("simulator"); }}
          replay={replay} />}
        {section === "analytics" && <AnalyticsPage stats={stats} executions={executions} />}
        {section === "dashboard" && <DashboardPage stats={stats} executions={executions} setSection={setSection} />}
        {section === "templates" && <TemplatesPage templates={templates} csvInput={csvInput} setCsvInput={setCsvInput}
          textInput={textInput} setTextInput={setTextInput} setError={setError} refresh={refresh}
          setSelectedExecutionId={setSelectedExecutionId} setSection={setSection} />}
      </div>
    </main>
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function Simulator({ scenario, setScenario, targetTask, setTargetTask, config, setConfig, detail, logs,
  selectedTaskId, setSelectedTaskId, selectedTask, taskAttempts, logFilter, setLogFilter, run, cancel,
  reset, replay, busy }) {
  const scenarioInfo = ALL_SCENARIOS.find(([id]) => id === scenario);
  const showDelay = ["slow_task", "timeout"].includes(scenario);
  const showTimeout = ["slow_task", "timeout", "service_unavailable", "circuit_breaker"].includes(scenario);
  const showTarget = !["happy_path", "independent_branch_failure", "replay_audit"].includes(scenario);
  const filteredLogs = logs.filter((log) => logFilter === "ALL" || log.level === logFilter);
  return <section className="simulator-page">
    <div className="simulator-heading">
      <div><div className="eyebrow"><Shield size={13} /> RESILIENCE LAB</div><h1>Resilience Lab</h1></div>
      <div className="execution-controls">
        <button className="button button-primary" onClick={run} disabled={busy}><Play size={15} /> Run</button>
        <button className="button button-secondary" onClick={reset}><RotateCcw size={15} /> Reset</button>
        <button className="button button-danger" onClick={cancel} disabled={!detail || detail.status !== "RUNNING"}><Square size={14} /> Cancel</button>
        <button className="button button-secondary" onClick={replay} disabled={!detail}><RotateCcw size={15} /> Replay</button>
      </div>
    </div>
    <div className="simulator-layout">
      <aside className="scenario-library">
        <div className="area-title">SCENARIO LIBRARY</div>
        {SCENARIO_GROUPS.map(([category, items]) => <div className="scenario-group" key={category}>
          <h3>{category}</h3>
          {items.map(([id, label, description]) => <button key={id}
            className={`scenario-item ${scenario === id ? "scenario-active" : ""}`}
            onClick={() => setScenario(id)}>
            <b>{label}</b><small>{description}</small>
          </button>)}
        </div>)}
      </aside>
      <section className="dag-workspace">
        <div className="dag-toolbar">
          <div><span className="live-dot" /> MASTER DAG · FIXED TOPOLOGY</div>
          {detail && <Status value={detail.status} />}
        </div>
        <MasterDag tasks={detail?.tasks} onNode={setSelectedTaskId} selectedTaskId={selectedTaskId} large />
      </section>
      <aside className="configuration-panel">
        <div className="area-title">SCENARIO CONFIGURATION</div>
        <h2>{scenarioInfo?.[1]}</h2>
        <p>{scenarioInfo?.[2]}</p>
        {showTarget && <label className="field"><span>Target task</span><select value={targetTask} onChange={(event) => setTargetTask(event.target.value)}>
          {MASTER_NODES.filter((node) => node.id !== "start").map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}
        </select></label>}
        {scenario !== "slow_task" && scenario !== "timeout" && <label className="field"><span>Maximum attempts</span><input type="number" min="1" max="21" value={config.maxAttempts} onChange={(event) => setConfig({...config, maxAttempts: Number(event.target.value)})}/></label>}
        {showTimeout && <label className="field"><span>Task timeout (ms)</span><input type="number" min="1" max="2147483647" value={config.taskTimeoutMs} onChange={(event) => setConfig({...config, taskTimeoutMs: Number(event.target.value)})}/></label>}
        {showDelay && <label className="field"><span>Artificial delay (ms)</span><input type="number" min="0" value={config.artificialDelayMs} onChange={(event) => setConfig({...config, artificialDelayMs: Number(event.target.value)})}/></label>}
        {["temporary_failure", "service_unavailable", "poison_task", "permanent_failure", "worker_crash"].includes(scenario) && <label className="field"><span>Retry delay (ms)</span><input type="number" min="0" value={config.retryDelayMs} onChange={(event) => setConfig({...config, retryDelayMs: Number(event.target.value)})}/></label>}
        {scenario === "replay_audit" && <div className="config-note">Select Replay to compare a previous execution. Replay relationships are persisted.</div>}
      </aside>
    </div>
    <div className="console-grid">
      <section className="execution-console panel">
        <div className="panel-heading"><div><h2>Execution Console</h2><p>{detail ? `Execution ${detail.id.slice(0, 12)}` : "No active execution"}</p></div>
          <div className="log-filters">{["ALL", "INFO", "WARN", "ERROR"].map((level) => <button key={level} className={logFilter === level ? "active" : ""} onClick={() => setLogFilter(level)}>{level}</button>)}</div>
        </div>
        <div className="console-output">
          {filteredLogs.length === 0 ? <div className="inline-empty">Waiting for execution events.</div> :
            filteredLogs.map((log, index) => <div className={`console-line log-${log.level.toLower?.()}`} key={`${log.createdAt}-${index}`}>
              <time>{new Date(log.createdAt).toLocaleTimeString()}</time>
              <span className={`log-level ${log.level.toLowerCase()}`}>{log.level}</span>
              <b>{log.taskId ?? "WORKFLOW"}</b><span>{log.message}</span>
            </div>)}
        </div>
      </section>
      <section className="task-inspector panel">
        <div className="panel-heading"><div><h2>Task Inspector</h2><p>{selectedTaskId ? selectedTaskId.replaceAll("-", " ").toUpperCase() : "Select a node"}</p></div></div>
        {selectedTask ? <>
          <div className="inspector-status"><Status value={selectedTask.status}/><span>{formatDuration(selectedTask.durationMs)}</span></div>
          <dl>
            <dt>Started</dt><dd>{formatDate(selectedTask.startedAt)}</dd>
            <dt>Completed</dt><dd>{formatDate(selectedTask.endedAt)}</dd>
            <dt>Attempts</dt><dd>{selectedTask.attempts}</dd>
            <dt>Error</dt><dd className="task-error">{selectedTask.error ?? "None"}</dd>
          </dl>
          <h3>Attempt History</h3>
          <div className="attempt-history">{taskAttempts.length ? taskAttempts.map((attempt) => <div key={attempt.attempt}>
            <b>#{attempt.attempt}</b><Status value={attempt.status}/><span>{formatDuration(attempt.durationMs)}</span>
            {attempt.error && <small>{attempt.error}</small>}
          </div>) : <p className="muted">No attempts recorded.</p>}</div>
        </> : <div className="inline-empty">Select a DAG node to inspect task state.</div>}
      </section>
    </div>
  </section>;
}

function DashboardPage({ stats, executions, setSection }) {
  const partial = executions.filter((execution) => execution.status === "PARTIAL").length;
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><LayoutDashboard size={13}/> CONTROL ROOM</div><h1>Orchestration dashboard.</h1><p>Live execution health across all workflow templates.</p></div>
      <button className="button button-primary" onClick={() => setSection("simulator")}><Shield size={15}/> Open Simulator</button></div>
    <div className="stat-grid">
      <Stat label="Total executions" value={stats?.totalExecutions} icon={Activity} tone="violet"/>
      <Stat label="Successful" value={stats?.successfulExecutions} icon={Check} tone="green"/>
      <Stat label="Failed / Partial" value={(stats?.failedExecutions ?? 0) + partial} icon={AlertTriangle} tone="orange"/>
      <Stat label="Running" value={stats?.runningExecutions} icon={Clock3} tone="blue"/>
    </div>
    <section className="panel"><div className="panel-heading"><div><h2>Recent executions</h2><p>Persisted SQLite execution history</p></div></div>
      <ExecutionTable executions={executions.slice(0, 12)} onSelect={() => setSection("history")}/></section>
  </section>;
}

function ExecutionTable({ executions, onSelect, onReplay }) {
  if (!executions.length) return <div className="inline-empty"><History size={16}/> No executions recorded yet.</div>;
  return <div className="history-table">
    <div className="history-head"><span>Execution</span><span>Template</span><span>Scenario</span><span>Status</span><span>Duration</span><span>Retries</span><span></span></div>
    {executions.map((execution) => {
      const retryCount = execution.tasks?.reduce((sum, task) => sum + Math.max(0, (task.attempts ?? 0) - 1), 0) ?? 0;
      return <button className="history-row" key={execution.id} onClick={() => onSelect?.(execution)}>
        <span><b>{execution.id.slice(0, 8)}</b>{execution.replayed && <small>REPLAY</small>}</span>
        <span>{execution.templateName ?? execution.workflowName}</span>
        <span>{execution.scenarioName ?? "—"}</span>
        <span><Status value={execution.status}/></span>
        <span>{formatDuration(durationFor(execution))}</span>
        <span>{retryCount}</span>
        <span>{onReplay && <button className="row-replay" onClick={(event) => {event.stopPropagation(); onReplay(execution.id);}}><RotateCcw size={13}/> Replay</button>}</span>
      </button>;
    })}
  </div>;
}

function HistoryPage({ executions, filter, setFilter, open, replay }) {
  const filtered = executions.filter((execution) => filter === "all" ||
    (filter === "success" && execution.status === "SUCCESS") ||
    (filter === "failed" && ["FAILED", "PARTIAL", "TIMED_OUT"].includes(execution.status)));
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><History size={13}/> PERSISTENT RECORDS</div><h1>Execution history.</h1><p>Every run, attempt, output, and replay relationship.</p></div></div>
    <div className="history-filters">{["all","success","failed"].map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value}</button>)}</div>
    <section className="panel"><ExecutionTable executions={filtered} onSelect={open} onReplay={replay}/></section>
  </section>;
}

function AnalyticsPage({ stats, executions }) {
  const analytics = stats?.analytics;
  const total = stats?.totalExecutions ?? 0;
  const success = stats?.successfulExecutions ?? 0;
  const failed = stats?.failedExecutions ?? 0;
  const partial = executions.filter((execution) => execution.status === "PARTIAL").length;
  const timedOut = executions.filter((execution) => execution.status === "PARTIAL" &&
    execution.tasks?.some((task) => task.status === "TIMED_OUT")).length;
  const retries = executions.reduce((totalRetries, execution) =>
    totalRetries + (execution.tasks?.reduce((sum, task) => sum + Math.max(0, (task.attempts ?? 0) - 1), 0) ?? 0), 0);
  const avgDuration = executions.length ? executions.reduce((sum, execution) => sum + (durationFor(execution) ?? 0), 0) / executions.length : 0;
  const successRate = total ? Math.round(success / total * 100) : 0;
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><BarChart3 size={13}/> SQL-DERIVED METRICS</div><h1>Execution Analytics.</h1><p>Charts and summaries generated only from persisted execution data.</p></div></div>
    <div className="stat-grid">
      <Stat label="Success rate" value={`${successRate}%`} icon={Check} tone="green"/>
      <Stat label="Partial executions" value={partial} icon={Activity} tone="violet"/>
      <Stat label="Total retries" value={retries} icon={RotateCcw} tone="orange"/>
      <Stat label="Average duration" value={formatDuration(Math.round(avgDuration))} icon={Clock3} tone="blue"/>
    </div>
    <div className="analytics-grid">
      <ChartCard title="Success vs Failure" items={[
        {label:"Successful", value:success, tone:"green"}, {label:"Failed", value:failed, tone:"red"}
      ]}/>
      <ChartCard title="Executions by Template" items={(analytics?.executionsByTemplate ?? []).map((row) => ({label:row.template, value:row.count, tone:"violet"}))}/>
      <ChartCard title="Retry Analysis" items={(analytics?.retriesByScenario ?? []).map((row) => ({label:row.scenario, value:row.retries, tone:"orange"}))}/>
      <ChartCard title="Average Execution Duration" items={(analytics?.durationByTemplate ?? []).map((row) => ({label:row.template, value:Math.round(row.averageDurationMs), tone:"blue"}))}/>
      <ChartCard title="Scenario Outcome Distribution" items={(analytics?.outcomeDistribution ?? []).map((row) => ({label:row.outcome, value:row.count, tone:row.outcome === "success" ? "green" : "red"}))}/>
      <ChartCard title="Timed-out Executions" items={[{label:"Timeout outcomes", value:timedOut, tone:"orange"}]}/>
    </div>
  </section>;
}

function ChartCard({ title, items }) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return <section className="panel chart-card"><div className="panel-heading"><div><h2>{title}</h2></div></div>
    {items.length ? <div className="bar-chart">{items.map((item) => <div className="bar-row" key={item.label}>
      <span>{item.label}</span><div className="bar-track"><i className={`bar-${item.tone}`} style={{width:`${Math.max(4,item.value/max*100)}%`}} /></div><b>{item.value}</b>
    </div>)}</div> : <div className="inline-empty">No persisted data for this chart.</div>}
  </section>;
}

function TemplatesPage({ templates, csvInput, setCsvInput, textInput, setTextInput, setError, refresh,
  setSelectedExecutionId, setSection }) {
  const runTemplate = async (templateId) => {
    try {
      if (templateId === "text-analysis" && textInput.trim().length === 0) {
        setError("Enter text to run the Text Analysis Pipeline.");
        return;
      }
      const body = { templateId };
      if (templateId === "csv-processing" && csvInput) body.input = { csvContent: csvInput.content };
      if (templateId === "text-analysis") body.input = { text: textInput };
      const result = await api.post("/api/executions", body);
      setSelectedExecutionId(result.executionId);
      setSection("history");
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  };
  const readCsv = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Choose a .csv file."); return; }
    if (file.size > 512 * 1024) { setError("CSV uploads must be 512 KB or smaller."); return; }
    setCsvInput({ name:file.name, content:await file.text() });
  };
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><Workflow size={13}/> WORKFLOW TEMPLATES</div><h1>Preserved pipelines.</h1><p>Run the original CSV and Text Analysis templates alongside the resilience simulator.</p></div></div>
    <div className="template-grid">{templates.filter((template) => template.id !== "resilience-recovery").map((template) => <article className="panel template-card" key={template.id}>
      <div className="template-card-heading"><div className="stat-icon violet"><Workflow size={17}/></div><div><h2>{template.name}</h2><p>{template.description}</p></div></div>
      {template.id === "csv-processing" && <label className="field"><span>CSV upload</span><input type="file" accept=".csv,text/csv" onChange={(event) => readCsv(event.target.files?.[0])}/><small>{csvInput ? csvInput.name : "Sample CSV is used when no file is selected."}</small></label>}
      {template.id === "text-analysis" && <label className="field"><span>Text input</span><textarea rows="6" maxLength="100000" value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="Paste text to analyze…"/></label>}
      {template.id === "resilience-recovery" ? <button className="button button-primary" onClick={() => setSection("simulator")}>Open Simulator <ArrowRight size={14}/></button>
        : <button className="button button-primary" onClick={() => runTemplate(template.id)}>Run Pipeline <Play size={14}/></button>}
    </article>)}</div>
  </section>;
}
