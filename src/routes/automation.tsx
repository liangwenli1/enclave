import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Empty, Field, Input, PageHeader, Panel, PanelHeader, Select } from "@/components/ui";
import { t } from "@/lib/i18n";
import { newWorkflow, type OnFail, type Workflow, type WorkflowStep, type WorkflowStepDef } from "@/lib/schema";
import { canEdit } from "@/lib/session";
import { useEnclave } from "@/lib/store";

/* 自动化：一串步骤，选一批环境批量跑。
   编辑器就是一张可增删上下移的步骤表——不做画布、不做拖拽、不做录制。
   循环节点放在循环体之后：走到它就回头，范围必须整个在它前面。 */

export const Route = createFileRoute("/automation")({ component: AutomationPage });

const STEP_TYPES: { type: WorkflowStep["type"]; label: string }[] = [
  { type: "open", label: "打开网页" },
  { type: "click", label: "点击" },
  { type: "type", label: "输入" },
  { type: "press", label: "按键" },
  { type: "scroll", label: "滚动" },
  { type: "waitFor", label: "等待元素出现" },
  { type: "sleep", label: "等待" },
  { type: "extract", label: "提取文本" },
  { type: "if", label: "条件跳转" },
  { type: "loop", label: "循环" },
];

function stepLabel(type: WorkflowStep["type"]): string {
  return STEP_TYPES.find((s) => s.type === type)?.label ?? type;
}

function blank(type: WorkflowStep["type"]): WorkflowStep {
  switch (type) {
    case "open":
      return { type, url: "https://" };
    case "click":
      return { type, selector: "" };
    case "type":
      return { type, selector: "", text: "" };
    case "press":
      return { type, key: "Enter" };
    case "scroll":
      return { type, selector: "", dy: 600 };
    case "waitFor":
      return { type, selector: "", timeoutMs: 10000 };
    case "sleep":
      return { type, ms: 1000 };
    case "extract":
      return { type, selector: "", var: "text" };
    case "if":
      return { type, var: "text", op: "contains", value: "", goto: 0 };
    case "loop":
      return { type, from: 1, to: 1, times: 2 };
  }
}

/** 一句话说清这一步在干什么，列表里看。 */
function stepSummary(s: WorkflowStep): string {
  switch (s.type) {
    case "open":
      return s.url;
    case "click":
      return s.selector;
    case "type":
      return `${s.selector} ← ${s.text}`;
    case "press":
      return s.key;
    case "scroll":
      return s.selector ? `滚到 ${s.selector}` : `${s.dy} 像素`;
    case "waitFor":
      return `${s.selector}，最多 ${Math.round(s.timeoutMs / 1000)} 秒`;
    case "sleep":
      return `${s.ms} 毫秒`;
    case "extract":
      return `${s.selector} → {{${s.var}}}`;
    case "if":
      return `{{${s.var}}} ${s.op === "contains" ? "包含" : s.op === "equals" ? "等于" : "非空"}${s.op === "notEmpty" ? "" : ` "${s.value}"`} → ${s.goto === 0 ? "结束" : `第 ${s.goto} 步`}`;
    case "loop":
      return `第 ${s.from}–${s.to} 步 × ${s.times}`;
  }
}

function AutomationPage() {
  const workflows = useEnclave((s) => s.workflows);
  const role = useEnclave((s) => s.session.role);
  const putWorkflow = useEnclave((s) => s.putWorkflow);
  const removeWorkflow = useEnclave((s) => s.removeWorkflow);
  const mayEdit = canEdit(role);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [naming, setNaming] = useState("");

  const picked = workflows.find((w) => w.id === pickedId) ?? null;

  const save = (wf: Workflow) => putWorkflow({ ...wf, updatedAt: Date.now() });

  return (
    <div className="p-6 md:p-8">
      <PageHeader title={t("navAutomation")} status={mayEdit ? undefined : "当前角色为操作员，可运行、不可修改"} />
      <p className="mb-6 max-w-[720px] text-[13px] leading-relaxed text-subtle">{t("automationIntro")}</p>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <Panel>
          <PanelHeader title={t("workflows")} />
          <div className="grid gap-1 p-2">
            {workflows.length === 0 ? (
              <p className="p-3 text-[13px] text-subtle">{t("workflowEmpty")}</p>
            ) : (
              workflows.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setPickedId(w.id)}
                  className={`rounded-md px-3 py-2 text-left text-sm ${
                    w.id === pickedId ? "bg-raised text-ink" : "text-muted hover:bg-raised hover:text-ink"
                  }`}
                >
                  <div className="font-medium">{w.name}</div>
                  <div className="text-[13px] text-subtle">{w.steps.length} 步</div>
                </button>
              ))
            )}
          </div>
          {mayEdit ? (
            <div className="grid gap-2 border-t border-line p-3">
              <Input
                value={naming}
                maxLength={60}
                placeholder={t("workflowNamePlaceholder")}
                onChange={(e) => setNaming(e.target.value)}
              />
              <Button
                variant="primary"
                disabled={!naming.trim()}
                onClick={() => {
                  const wf = newWorkflow(naming.trim());
                  save(wf);
                  setPickedId(wf.id);
                  setNaming("");
                }}
              >
                <Plus className="size-3.5" />
                {t("workflowNew")}
              </Button>
            </div>
          ) : null}
        </Panel>

        {picked ? (
          <Editor
            key={picked.id}
            wf={picked}
            mayEdit={mayEdit}
            onChange={save}
            onDelete={() => {
              if (!confirm(`删除流程「${picked.name}」？`)) return;
              removeWorkflow(picked.id);
              setPickedId(null);
            }}
          />
        ) : (
          <Empty title={t("workflowPick")} body={t("workflowPickHint")} />
        )}
      </div>
    </div>
  );
}

function Editor({
  wf,
  mayEdit,
  onChange,
  onDelete,
}: {
  wf: Workflow;
  mayEdit: boolean;
  onChange: (wf: Workflow) => void;
  onDelete: () => void;
}) {
  const [adding, setAdding] = useState<WorkflowStep["type"]>("open");
  const steps = wf.steps;

  const setSteps = (next: WorkflowStepDef[]) => onChange({ ...wf, steps: next });
  const patchStep = (i: number, s: WorkflowStepDef) => setSteps(steps.map((x, k) => (k === i ? s : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSteps(next);
  };

  return (
    <Panel>
      <PanelHeader
        title={wf.name}
        actions={
          mayEdit ? (
            <div className="flex gap-2">
              <Input
                className="max-w-[220px]"
                value={wf.name}
                maxLength={60}
                onChange={(e) => onChange({ ...wf, name: e.target.value })}
              />
              <Button variant="ghost" className="text-bad" onClick={onDelete}>
                <Trash2 className="size-3.5" />
                {t("delete")}
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="grid gap-3 p-4">
        {steps.length === 0 ? <p className="text-[13px] text-subtle">{t("workflowNoSteps")}</p> : null}
        {steps.map((s, i) => (
          <div key={i} className="grid gap-3 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="www-mono w-8 text-[13px] text-subtle">{i + 1}</span>
              <span className="text-sm font-semibold text-ink">{stepLabel(s.type)}</span>
              <span className="flex-1 truncate text-[13px] text-subtle">{stepSummary(s)}</span>
              {mayEdit ? (
                <>
                  <Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移">
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="下移">
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button variant="ghost" className="text-bad" onClick={() => setSteps(steps.filter((_, k) => k !== i))} aria-label="删除这一步">
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              ) : null}
            </div>
            {mayEdit ? <StepForm step={s} onChange={(next) => patchStep(i, next)} count={steps.length} /> : null}
          </div>
        ))}

        {mayEdit ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <Field label={t("workflowAddStep")}>
              <Select value={adding} onChange={(e) => setAdding(e.target.value as WorkflowStep["type"])}>
                {STEP_TYPES.map((x) => (
                  <option key={x.type} value={x.type}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={() => setSteps([...steps, { ...blank(adding), onFail: { mode: "stop" } }])}>
              <Plus className="size-3.5" />
              {t("workflowAdd")}
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function StepForm({
  step,
  onChange,
  count,
}: {
  step: WorkflowStepDef;
  onChange: (s: WorkflowStepDef) => void;
  count: number;
}) {
  const set = (patch: Partial<WorkflowStep>) => onChange({ ...step, ...patch } as WorkflowStepDef);
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {"url" in step ? (
        <Field label="网址" hint={t("workflowVarHint")}>
          <Input value={step.url} onChange={(e) => set({ url: e.target.value })} />
        </Field>
      ) : null}
      {"selector" in step ? (
        <Field label="元素（CSS 选择器）" hint={step.type === "scroll" ? "留空则按像素滚动页面" : undefined}>
          <Input value={step.selector} placeholder="#login, .btn-primary" onChange={(e) => set({ selector: e.target.value })} />
        </Field>
      ) : null}
      {step.type === "type" ? (
        <Field label="内容" hint={t("workflowVarHint")}>
          <Input value={step.text} onChange={(e) => set({ text: e.target.value })} />
        </Field>
      ) : null}
      {step.type === "press" ? (
        <Field label="按键">
          <Select value={step.key} onChange={(e) => set({ key: e.target.value as "Enter" | "Tab" | "Escape" })}>
            <option value="Enter">Enter</option>
            <option value="Tab">Tab</option>
            <option value="Escape">Escape</option>
          </Select>
        </Field>
      ) : null}
      {step.type === "scroll" ? (
        <Field label="像素">
          <Input type="number" value={step.dy} onChange={(e) => set({ dy: num(e.target.value, 600) })} />
        </Field>
      ) : null}
      {step.type === "waitFor" ? (
        <Field label="最多等待（秒）">
          <Input type="number" min={1} max={120} value={Math.round(step.timeoutMs / 1000)} onChange={(e) => set({ timeoutMs: num(e.target.value, 10) * 1000 })} />
        </Field>
      ) : null}
      {step.type === "sleep" ? (
        <Field label="毫秒">
          <Input type="number" min={0} max={600000} value={step.ms} onChange={(e) => set({ ms: num(e.target.value, 1000) })} />
        </Field>
      ) : null}
      {step.type === "extract" ? (
        <Field label="存到变量" hint="之后的步骤里用 {{变量}} 引用">
          <Input value={step.var} onChange={(e) => set({ var: e.target.value.replace(/[^\w]/g, "") })} />
        </Field>
      ) : null}
      {step.type === "if" ? (
        <>
          <Field label="变量">
            <Input value={step.var} onChange={(e) => set({ var: e.target.value.replace(/[^\w]/g, "") })} />
          </Field>
          <Field label="条件">
            <Select value={step.op} onChange={(e) => set({ op: e.target.value as "contains" | "equals" | "notEmpty" })}>
              <option value="contains">包含</option>
              <option value="equals">等于</option>
              <option value="notEmpty">非空</option>
            </Select>
          </Field>
          {step.op !== "notEmpty" ? (
            <Field label="值">
              <Input value={step.value} onChange={(e) => set({ value: e.target.value })} />
            </Field>
          ) : null}
          <Field label="成立时跳到第几步" hint="0 表示结束流程">
            <Input type="number" min={0} max={count} value={step.goto} onChange={(e) => set({ goto: num(e.target.value, 0) })} />
          </Field>
        </>
      ) : null}
      {step.type === "loop" ? (
        <>
          <Field label="从第几步" hint={t("workflowLoopHint")}>
            <Input type="number" min={1} max={count} value={step.from} onChange={(e) => set({ from: num(e.target.value, 1) })} />
          </Field>
          <Field label="到第几步">
            <Input type="number" min={1} max={count} value={step.to} onChange={(e) => set({ to: num(e.target.value, 1) })} />
          </Field>
          <Field label="重复次数">
            <Input type="number" min={1} max={1000} value={step.times} onChange={(e) => set({ times: num(e.target.value, 2) })} />
          </Field>
        </>
      ) : null}
      {step.type !== "if" && step.type !== "loop" ? (
        <Field label={t("workflowOnFail")}>
          <Select
            value={step.onFail.mode === "retry" ? `retry:${step.onFail.times}` : step.onFail.mode}
            onChange={(e) => {
              const v = e.target.value;
              const onFail: OnFail = v.startsWith("retry:") ? { mode: "retry", times: Number(v.slice(6)) } : { mode: v as "skip" | "stop" };
              onChange({ ...step, onFail });
            }}
          >
            <option value="stop">终止流程</option>
            <option value="skip">跳过这一步</option>
            <option value="retry:1">重试 1 次</option>
            <option value="retry:3">重试 3 次</option>
            <option value="retry:5">重试 5 次</option>
          </Select>
        </Field>
      ) : null}
    </div>
  );
}
