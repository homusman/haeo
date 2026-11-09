import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { observer } from "./mobx-observer";
import type { PowerMeasurement } from "./actual-sources";
import type { ForecastCardStore } from "./store";

const HOUR = 3_600_000;
const PAGE = 32;

export interface PlanSummary {
  id: string;
  accepted_at: string;
  ended_at: string | null;
  ends: number;
  decision: {
    reason: string;
    benefit: number | null;
    candidate_cost?: number;
    conflicts?: string | null;
    accepted?: boolean;
  };
}

export interface CurrentPlanMetadata {
  accepted_at: string;
  ends: number;
  rolling_cost?: number;
  decision: PlanSummary["decision"];
}

export interface PlanDetail extends PlanSummary {
  boundaries: number[];
  inputs?: Record<string, Record<string, [number, number][]>>;
  series: Record<string, Record<string, [number, number][]>>;
}

export interface PlanSegment {
  plan: PlanSummary;
  start: number;
  end: number;
  index: number;
  previousIndex: number | null;
  previousCost?: number | undefined;
}

export interface RecorderState {
  s: string;
  lu?: number;
  lc?: number;
}

interface ArchivePage {
  plans: PlanSummary[];
  current_plan?: CurrentPlanMetadata | null;
  measurements?: Record<string, PowerMeasurement>;
  decision?: { status?: string; last_run?: string; benefit?: number | null; accepted?: boolean };
  archive: { plans: number; bytes: number };
}

export function historicSegments(plans: PlanSummary[], now: number): PlanSegment[] {
  const ordered = [...plans].sort((a, b) => Date.parse(a.accepted_at) - Date.parse(b.accepted_at));
  return ordered.flatMap((plan, index) => {
    const start = Date.parse(plan.accepted_at);
    const next = ordered[index + 1];
    const end = Math.min(
      now,
      plan.ends * 1000,
      next ? Date.parse(next.accepted_at) : now,
      plan.ended_at ? Date.parse(plan.ended_at) : now
    );
    return plan.decision.reason === "gate_disabled" || !(start < end)
      ? []
      : [
          {
            plan,
            start,
            end,
            index: index - ordered.length + 1,
            previousCost: ordered[index - 1]?.decision.candidate_cost,
            previousIndex:
              index > 0 && ordered[index - 1]?.decision.reason !== "gate_disabled" ? index - ordered.length : null,
          },
        ];
  });
}

export const PlanControls = observer(function PlanControls({
  store,
}: {
  store: ForecastCardStore;
}): JSX.Element | null {
  const [decision, setDecision] = useState<ArchivePage["decision"]>();
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [archive, setArchive] = useState<ArchivePage["archive"] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const latestHass = useRef(store.hass);
  latestHass.current = store.hass;
  const hub = store.config.hub_entry_id;
  const enabled = !!store.hass?.callWS && !!hub;
  const past = store.pastHours;
  const measurements = store.actualSources;

  useEffect(() => {
    if (!enabled || busy) return;
    let cancelled = false;
    let refreshing = false;
    const message = { type: "haeo_homusman/plans", entry_id: hub };
    async function refresh(): Promise<void> {
      if (refreshing) return;
      refreshing = true;
      try {
        const hass = latestHass.current;
        if (!hass?.callWS) return;
        const now = Date.now();
        const cutoff = now - past * HOUR;
        store.setHistoryClock(now);
        const plans: PlanSummary[] = [];
        let before: string | undefined;
        do {
          const page = await hass.callWS<ArchivePage>({ ...message, ...(before ? { before } : {}) });
          if (cancelled) return;
          setArchive(page.archive);
          setDecision(page.decision);
          store.setCurrentPlanMetadata(page.current_plan ?? null);
          store.setPowerMeasurements(page.measurements ?? {});
          plans.push(...page.plans);
          before =
            page.plans.length === PAGE && Date.parse(page.plans.at(-1)!.accepted_at) > cutoff
              ? page.plans.at(-1)!.id
              : undefined;
        } while (past && before && plans.length < 256);
        const segments = past ? historicSegments(plans, now).filter((segment) => segment.end > cutoff) : [];
        store.setSegments(segments);
        const ids = segments.map((segment) => segment.plan.id).filter((id) => !store.historyDetails[id]);
        for (let start = 0; start < ids.length && !cancelled; start += 4) {
          const details = await Promise.allSettled(
            ids.slice(start, start + 4).map((id) => hass.callWS!<PlanDetail>({ ...message, plan_id: id }))
          );
          if (cancelled) return;
          for (const detail of details) if (detail.status === "fulfilled") store.addHistoryDetail(detail.value);
        }
        setError("");
      } catch {
        if (!cancelled) setError("Plan archive unavailable. Home Assistant administrator access is required.");
      } finally {
        refreshing = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, hub, past, revision, store, busy]);

  useEffect(() => {
    const ids = [...new Set(Object.values(measurements ?? {}))].slice(0, 16);
    if (!enabled || !past || !ids.length) {
      store.setActuals({});
      return;
    }
    let cancelled = false;
    async function loadActuals(): Promise<void> {
      const now = Date.now();
      try {
        const result = await latestHass.current?.callWS?.<Record<string, RecorderState[]>>({
          type: "history/history_during_period",
          entity_ids: ids,
          start_time: new Date(now - past * HOUR).toISOString(),
          end_time: new Date(now).toISOString(),
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        });
        if (!cancelled && result) store.setActuals(result);
      } catch {
        if (!cancelled) store.setActuals({});
      }
    }
    void loadActuals();
    const timer = window.setInterval(() => void loadActuals(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, hub, past, measurements, store]);

  async function purge(): Promise<void> {
    if (!window.confirm("Permanently delete this hub’s saved plans?")) return;
    setBusy(true);
    try {
      const page = await latestHass.current?.callWS?.<ArchivePage>({
        type: "haeo_homusman/plans",
        entry_id: hub,
        purge: true,
      });
      if (page) setArchive(page.archive);
      if (store.pinnedPlanId) store.clearComparison();
      store.setSegments([]);
      setRevision((value) => value + 1);
      setError("");
    } catch {
      setError("Could not purge the plan archive.");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <div className="planControls">
      {archive && (
        <span>
          {archive.plans} saved · {(archive.bytes / 1024).toFixed(1)} KiB{" "}
          <button type="button" disabled={busy || !archive.plans} onClick={() => void purge()}>
            Purge plan archive
          </button>
        </span>
      )}
      {past > 0 && (
        <div>
          Accepted history ·{" "}
          {Object.keys(measurements).length ? "solid measurement traces" : "no matching measurement inputs"}
        </div>
      )}
      <div className="optimizerSummary">
        Optimiser {decision?.status ?? "pending"} · Benefit {decision?.benefit?.toFixed(3) ?? "—"} · Last run{" "}
        {decision?.last_run ? formatRunAge(clock - Date.parse(decision.last_run)) : "—"}
        {decision?.accepted !== undefined && (decision.accepted ? " · Accepted" : " · Not accepted")}
      </div>
      {(error || store.comparisonError) && <div role="status">{error || store.comparisonError}</div>}
    </div>
  );
});

function formatRunAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s ago";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m ago";
}

export const HistoricPlanInfo = observer(function HistoricPlanInfo({
  store,
}: {
  store: ForecastCardStore;
}): JSX.Element | null {
  const segment = store.candidatePreview
    ? null
    : (store.hoveredPlan ?? store.segments.find(({ plan }) => plan.id === store.pinnedPlanId) ?? store.pinnedSegment);
  const selection = store.pinnedPlanId || store.candidatePreview;
  const clear = selection ? (
    <button type="button" onClick={() => store.clearComparison()}>
      Clear comparison
    </button>
  ) : null;
  if (!segment) {
    const candidate = store.candidatePreview;
    const current = store.currentPlanMetadata;
    return (
      <aside className="historicPlanInfo">
        <strong>{candidate ? "Candidate" : "Current plan"}</strong>
        {candidate ? (
          <>
            <div>Candidate cost {candidate.decision.candidate_cost?.toFixed(3) ?? "—"}</div>
            <div>
              {candidate.decision.accepted ? "Accepted" : "Not accepted"} ·{" "}
              {candidate.decision.reason.replaceAll("_", " ")}
            </div>
            <div>Benefit {candidate.decision.benefit?.toFixed(3) ?? "—"}</div>
            {candidate.decision.conflicts && <div>Conflicting constraints: {candidate.decision.conflicts}</div>}
          </>
        ) : current ? (
          <>
            <div>Accepted {new Date(current.accepted_at).toLocaleString()}</div>
            <div>Horizon ends {new Date(current.ends * 1000).toLocaleString()}</div>
            <div>Rolling cost {current.rolling_cost?.toFixed(3) ?? "—"}</div>
            <div>{current.decision.reason.replaceAll("_", " ")}</div>
            {current.decision.conflicts && <div>Conflicting constraints: {current.decision.conflicts}</div>}
          </>
        ) : (
          <div>Waiting for the first accepted plan.</div>
        )}
        {clear}
      </aside>
    );
  }
  const { plan, index, previousIndex, previousCost, start, end } = segment;
  const nextCost = plan.decision.candidate_cost;
  const comparisonCost =
    previousIndex !== null && previousCost !== undefined && nextCost !== undefined ? previousCost - nextCost : null;
  const reasons: Record<string, string> = {
    bootstrap:
      "There was no eligible active plan to continue, so the optimizer accepted this plan as its starting point.",
    accepted:
      "The candidate beat the cost of retaining the previous schedule and extending its tail by more than the configured threshold.",
    expired:
      "The preceding plan could no longer cover the next dispatch interval, so the optimizer accepted a fresh plan.",
    incumbent_infeasible:
      "The retained schedule and its extension could not satisfy the updated constraints. The optimizer accepted a feasible replacement.",
    commitment_boundary:
      "The next optimization interval crossed an action change in the preceding plan. The optimizer accepted a plan aligned to the new interval.",
  };
  return (
    <aside className="historicPlanInfo">
      <strong>Plan {index === 0 ? "latest" : index}</strong>
      <div>{new Date(start).toLocaleString()}</div>
      <div>In action {Math.round((end - start) / 60_000)} min</div>
      <div>{reasons[plan.decision.reason] ?? plan.decision.reason.replaceAll("_", " ")}</div>
      {plan.decision.conflicts && <div>Conflicting constraints: {plan.decision.conflicts}</div>}
      {nextCost !== undefined && <div>Saved plan cost {nextCost.toFixed(3)}</div>}
      {comparisonCost !== null && (
        <div>
          Plan {previousIndex} cost {previousCost?.toFixed(3)} · saved cost difference {comparisonCost.toFixed(3)}
        </div>
      )}
      <div>
        Same-input benefit vs {previousIndex === null ? "previous plan" : "plan " + previousIndex}{" "}
        {plan.decision.benefit == null ? "unavailable" : plan.decision.benefit.toFixed(3)}
      </div>
      {clear}
    </aside>
  );
});
