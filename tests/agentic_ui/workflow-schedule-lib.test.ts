import { describe, expect, it } from "vitest";

import catalogJson from "./fixtures/workflow-catalog.json";
import scheduleKindJson from "./fixtures/workflow-catalog-schedule.json";
import type { WorkflowNodeKindInfo, WorkflowSchedule, WorkflowSpec } from "@/shared/lib/types";
import { createNode } from "@/features/workflows/lib/builder/draft";
import { specToFlow } from "@/features/workflows/lib/builder/flow";
import {
  MANUAL_TRIGGER_KIND,
  SCHEDULE_TRIGGER_KIND,
  defaultScheduleConfig,
  readScheduleConfig,
  scheduleConfigProblems,
  scheduleNodeSubtitle,
  withScheduleKind,
} from "@/features/workflows/lib/builder/schedule";
import { checkSpec, issueCountByNode } from "@/features/workflows/lib/builder/validate";
import { buildWorkflowFlow } from "@/features/workflows/lib/graph";
import { kindMeta } from "@/features/workflows/lib/kinds";
import { browserTimezone, formatNextRunShort } from "@/shared/lib/schedule";
import {
  optimisticSchedule,
  setSchedulePausedOptimistic,
  workflowScheduleSubtitle,
} from "@/shared/lib/workflowSchedule";

/**
 * The schedule trigger's pure half (plan 38, step 4 UI), against the
 * engine's real catalogue entry (`fixtures/workflow-catalog-schedule.json`,
 * dumped from `ScheduleTriggerNode.catalog_entry()`).
 *
 * Pinned: the client mirror of the engine's checks (interval floor, empty
 * cron, exactly one spec field, timezone, static inputs — required ones only
 * while enabled — and no template checks on a config that isn't templated),
 * placed on the node; Manual ↔ Schedule switching in place (id, position,
 * label and edges kept; a new schedule starts daily and on); the kind switch
 * keeps exactly one spec field; the trigger card's subtitle in both modes;
 * the optimistic pause / resume and its rollback.
 */

const scheduleKind = scheduleKindJson as unknown as WorkflowNodeKindInfo;
const catalog = [...(catalogJson as unknown as WorkflowNodeKindInfo[]), scheduleKind];

const scheduled = (
  config: Record<string, unknown>,
  inputs: WorkflowSpec["inputs"] = [],
): WorkflowSpec => ({
  version: 1,
  name: "Digest",
  description: "",
  inputs,
  state: [],
  nodes: [
    { id: "trigger", kind: SCHEDULE_TRIGGER_KIND, label: null, config, position: { x: 0, y: 0 } },
    { id: "end", kind: "end", label: null, config: {}, position: { x: 320, y: 0 } },
  ],
  edges: [{ id: "e1", source: "trigger", target: "end", branch: null }],
});

const onTrigger = (spec: WorkflowSpec) =>
  checkSpec(spec, catalog)
    .filter((issue) => issue.nodeId === "trigger")
    .map((issue) => [issue.field, issue.message]);

const schedule = (patch: Partial<WorkflowSchedule> = {}): WorkflowSchedule => ({
  status: "active",
  kind: "interval",
  spec: { interval_seconds: 86400 },
  timezone: null,
  nextRunAt: "2026-11-05T08:00:00Z",
  lastRunAt: null,
  lastRunStatus: null,
  ...patch,
});

describe("schedule trigger: client validation", () => {
  it("accepts the default config (daily, on) and gives the kind its own look", () => {
    expect(onTrigger(scheduled(defaultScheduleConfig()))).toEqual([]);
    expect(kindMeta(SCHEDULE_TRIGGER_KIND)).toMatchObject({
      category: "schedule",
      accent: "var(--info)",
    });
    expect(kindMeta(SCHEDULE_TRIGGER_KIND).icon).not.toBe(kindMeta(MANUAL_TRIGGER_KIND).icon);
  });

  it("refuses an interval under 5 minutes or over 366 days", () => {
    const short = { ...defaultScheduleConfig(), schedule_spec: { interval_seconds: 120 } };
    expect(onTrigger(scheduled(short))).toEqual([
      ["config.schedule_spec.interval_seconds", "The shortest interval is 5 minutes."],
    ]);
    const long = { ...defaultScheduleConfig(), schedule_spec: { interval_seconds: 31622401 } };
    expect(onTrigger(scheduled(long))[0][1]).toMatch(/366 days/);
    expect(onTrigger(scheduled({ ...short, schedule_spec: { interval_seconds: 300 } }))).toEqual(
      [],
    );
  });

  it("wants a cron expression, at most 120 characters, and a known timezone", () => {
    const cron = (expr: string, timezone: string | null = "UTC") => ({
      ...defaultScheduleConfig(),
      schedule_kind: "cron",
      schedule_spec: { cron_expr: expr },
      timezone,
    });
    expect(onTrigger(scheduled(cron("  ")))).toEqual([
      ["config.schedule_spec.cron_expr", "Enter a cron expression."],
    ]);
    expect(onTrigger(scheduled(cron(`0 8 * * ${"1,".repeat(60)}1`)))[0][1]).toMatch(/at most 120/);
    expect(onTrigger(scheduled(cron("0 8 * * *", "Mars/Olympus")))).toEqual([
      ["config.timezone", "Unknown timezone — use an IANA name like Europe/Athens."],
    ]);
    expect(onTrigger(scheduled(cron("0 8 * * *", "Europe/Athens")))).toEqual([]);
  });

  it("takes exactly the kind's one spec field", () => {
    const both = {
      ...defaultScheduleConfig(),
      schedule_spec: { interval_seconds: 600, cron_expr: "0 8 * * *" },
    };
    expect(onTrigger(scheduled(both))).toEqual([
      [
        "config.schedule_spec",
        "A repeating schedule takes only interval_seconds; remove cron_expr.",
      ],
    ]);
    const missing = { ...defaultScheduleConfig(), schedule_kind: "one_off", schedule_spec: {} };
    expect(onTrigger(scheduled(missing))).toEqual([
      ["config.schedule_spec.run_at", "Pick a date and time."],
    ]);
    const bad = { ...missing, schedule_spec: { run_at: "not a date" } };
    expect(onTrigger(scheduled(bad))[0][1]).toMatch(/valid date/);
    expect(scheduleConfigProblems({ ...missing, schedule_kind: "weekly" }, [])[0]).toEqual({
      field: "config.schedule_kind",
      message: "Pick when it runs: once, every…, or on a cron schedule.",
    });
  });

  it("checks static inputs: declared, typed, required ones set while enabled", () => {
    const inputs: WorkflowSpec["inputs"] = [
      { name: "topic", type: "string", required: true },
      { name: "limit", type: "number", required: true, default: 5 },
    ];
    const config = (patch: Record<string, unknown>) => ({ ...defaultScheduleConfig(), ...patch });
    // A required input without a default must be set while the schedule is on…
    expect(onTrigger(scheduled(config({ inputs: {} }), inputs))).toEqual([
      ["config.inputs.topic", "A scheduled run needs a value for the required input 'topic'."],
    ]);
    // …but not while it is off (it never fires; a manual run brings its own).
    expect(onTrigger(scheduled(config({ inputs: {}, enabled: false }), inputs))).toEqual([]);
    expect(
      onTrigger(scheduled(config({ inputs: { topic: "news", limit: "ten", extra: 1 } }), inputs)),
    ).toEqual([
      ["config.inputs.limit", "Input 'limit' must be of type number."],
      ["config.inputs.extra", "'extra' is not a declared input."],
    ]);
    // Not templated: a `{{` is text, never an undeclared reference.
    expect(onTrigger(scheduled(config({ inputs: { topic: "{{input.nope}}" } }), inputs))).toEqual(
      [],
    );
  });

  it("puts the issues on the node: its card's count", () => {
    const spec = scheduled({ ...defaultScheduleConfig(), schedule_spec: { interval_seconds: 60 } });
    expect(issueCountByNode(checkSpec(spec, catalog)).get("trigger")).toBe(1);
  });
});

describe("schedule trigger: kinds and switching", () => {
  it("starts a new schedule node daily and on", () => {
    const node = createNode(
      scheduled(defaultScheduleConfig()),
      SCHEDULE_TRIGGER_KIND,
      scheduleKind,
      { x: 5, y: 5 },
    );
    expect(node.config).toEqual({
      schedule_kind: "interval",
      schedule_spec: { interval_seconds: 86400 },
      timezone: null,
      inputs: {},
      enabled: true,
    });
  });

  it("keeps exactly one spec field across kind switches, a timezone for cron only", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    const once = withScheduleKind(defaultScheduleConfig(), "one_off", null, now);
    expect(once).toMatchObject({
      schedule_kind: "one_off",
      schedule_spec: { run_at: "2026-11-04T11:00:00.000Z" },
      timezone: null,
    });
    const cron = withScheduleKind(once, "cron", null, now);
    expect(cron).toMatchObject({
      schedule_spec: { cron_expr: "0 8 * * *" },
      timezone: browserTimezone(),
    });
    const remembered = withScheduleKind(
      cron,
      "interval",
      { spec: { interval_seconds: 3600 }, timezone: null },
      now,
    );
    expect(remembered).toMatchObject({
      schedule_spec: { interval_seconds: 3600 },
      timezone: null,
      enabled: true,
    });
    expect(readScheduleConfig({ schedule_kind: "bogus", enabled: "yes" })).toMatchObject({
      schedule_kind: "interval",
      enabled: true,
    });
  });
});

describe("schedule trigger: the card's subtitle", () => {
  const now = new Date("2026-11-04T06:00:00Z");

  it("edit mode reads the node's config: cadence, a cron's next run, Paused when off", () => {
    expect(scheduleNodeSubtitle(defaultScheduleConfig(), now)).toEqual({
      text: "Every day",
      paused: false,
    });
    expect(scheduleNodeSubtitle({ ...defaultScheduleConfig(), enabled: false }, now)).toEqual({
      text: "Paused",
      paused: true,
    });
    const cron = {
      ...defaultScheduleConfig(),
      schedule_kind: "cron",
      schedule_spec: { cron_expr: "0 8 * * *" },
      timezone: "UTC",
    };
    const next = new Date("2026-11-04T08:00:00Z");
    expect(scheduleNodeSubtitle(cron, now).text).toBe(
      `Every day at 08:00 · next ${formatNextRunShort(next, now)}`,
    );
  });

  it("edit mode shows the saved schedule's next run while the config still matches it", () => {
    const saved = schedule();
    const next = formatNextRunShort(new Date("2026-11-05T08:00:00Z"), now);
    expect(scheduleNodeSubtitle(defaultScheduleConfig(), now, saved).text).toBe(
      `Every day · next ${next}`,
    );
    // Edited since the save: the saved next run no longer applies.
    const edited = { ...defaultScheduleConfig(), schedule_spec: { interval_seconds: 3600 } };
    expect(scheduleNodeSubtitle(edited, now, saved).text).toBe("Every hour");
    expect(
      scheduleNodeSubtitle(defaultScheduleConfig(), now, schedule({ status: "paused" })).text,
    ).toBe("Paused");
  });

  it("view mode reads the workflow's live schedule", () => {
    expect(workflowScheduleSubtitle(schedule({ status: "finished" }), now)).toEqual({
      text: "Finished",
      paused: true,
    });
    const spec = scheduled(defaultScheduleConfig());
    const view = buildWorkflowFlow({
      spec,
      view: null,
      catalog,
      selectedNodeId: null,
      animate: false,
      schedule: schedule({ status: "paused" }),
      now,
    });
    expect(view.nodes[0].data).toMatchObject({ subtitle: "Paused", subtitlePaused: true });
    expect(view.nodes[1].data.subtitle).toBeUndefined();
    const edit = specToFlow(spec, { catalog, savedSchedule: schedule(), now });
    expect(edit.nodes[0].data.subtitle).toMatch(/^Every day · next /);
  });
});

describe("pause / resume, optimistically", () => {
  it("shows the expected state at once, then the server's answer", async () => {
    const applied: WorkflowSchedule[] = [];
    const answer = schedule({ status: "paused", nextRunAt: null });
    const result = await setSchedulePausedOptimistic({
      current: schedule(),
      paused: true,
      apply: (next) => applied.push(next),
      send: async () => answer,
    });
    expect(result).toBe(answer);
    expect(applied.map((entry) => entry.status)).toEqual(["paused", "paused"]);
    expect(applied[1]).toBe(answer);
  });

  it("rolls back when the server refuses, and leaves a finished schedule alone", async () => {
    const applied: WorkflowSchedule[] = [];
    const current = schedule({ status: "paused" });
    await expect(
      setSchedulePausedOptimistic({
        current,
        paused: false,
        apply: (next) => applied.push(next),
        send: async () => {
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("nope");
    expect(applied.map((entry) => entry.status)).toEqual(["active", "paused"]);
    expect(applied[1]).toBe(current);
    const finished = schedule({ status: "finished" });
    expect(optimisticSchedule(finished, true)).toBe(finished);
  });
});
