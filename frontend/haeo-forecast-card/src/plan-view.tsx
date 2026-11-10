import { downsampleRecorderStates } from "./actual-points";
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
  revision?: number;
  execution_until?: number | null;
  execution_truncated?: boolean;
  decision: {
    reason: string;
    benefit: number | null;
    candidate_cost?: number;
    incumbent_cost?: number | null;
    gate_incumbent_cost?: number | null;
    gate_candidate_cost?: number | null;
    benefit_drivers?: string | null;
    conflicts?: string | null;
    accepted?: boolean;
  };
}

export interface CurrentPlanMetadata {
  accepted_at: string;
  ends: number;
  rolling_cost?: number;
  revision?: number;
  correction_energy_used?: Record<string, number>;
  corrections?: Record<string, { power_kw: number; energy_kwh: number }> | null;
  decision: PlanSummary["decision"];
}

export interface PlanDetail extends PlanSummary {
  generated_at?: string;
  boundaries: number[];
  inputs?: Record<string, Record<string, [number, number][]>>;
  series: Record<string, Record<string, [number, number][]>>;
  execution_series?: Record<string, Record<string, [number, number][]>>;
  execution_inputs?: Record<string, Record<string, [number, number][]>>;
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
  latest_accepted?: PlanSummary | null;
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
          if (!before) store.setLatestAcceptedId(page.latest_accepted?.id ?? page.plans[0]?.id ?? null);
          store.setPowerMeasurements(page.measurements ?? {});
          plans.push(...page.plans);
          before =
            page.plans.length === PAGE && Date.parse(page.plans.at(-1)!.accepted_at) > cutoff
              ? page.plans.at(-1)!.id
              : undefined;
        } while (past && before && plans.length < 256);
        if (store.candidatePreview) void store.selectCandidate(true);
        const segments = past ? historicSegments(plans, now).filter((segment) => segment.end > cutoff) : [];
        store.setSegments(segments);
        const ids = segments.filter(({ plan }) => {
          const detail = store.historyDetails[plan.id];
          return !detail || (detail.execution_until ?? null) !== (plan.execution_until ?? null)
            || (detail.revision ?? 0) !== (plan.revision ?? 0);
        }).map(({ plan }) => plan.id);
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
        if (!cancelled && result) {
          store.setActuals(
            Object.fromEntries(
              Object.entries(result).map(([id, states]) => [id, downsampleRecorderStates(states, past * HOUR)])
            )
          );
        }
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
      store.setLatestAcceptedId(null);
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
        Optimiser {decision?.status ?? "pending"} · <BenefitHistory store={store} benefit={decision?.benefit} /> · Last run{" "}
        {decision?.last_run ? formatRunAge(clock - Date.parse(decision.last_run)) : "—"}
        {decision?.accepted !== undefined && (decision.accepted ? " · Accepted" : " · Not accepted")}
      </div>
      {(error || store.comparisonError) && <div role="status">{error || store.comparisonError}</div>}
    </div>
  );
});

function formatRunAge(milliseconds: number): string {
  return Number.isFinite(milliseconds) ? formatDuration(Math.max(0, milliseconds)) + " ago" : "—";
}

type Evaluation = [evaluated: number, accepted: number, benefit: number | null];

function BenefitHistory({ store, benefit }: { store: ForecastCardStore; benefit?: number | null | undefined }): JSX.Element {
  const hub = store.config.hub_entry_id;
  const [history, setHistory] = useState<{ hub: typeof hub; points: Evaluation[] }>();
  const [failed, setFailed] = useState(false);
  async function load(): Promise<void> {
    setFailed(false);
    try {
      const response = await store.hass?.callWS?.<{ evaluations: Evaluation[] }>({
        type: "haeo_homusman/plans", entry_id: hub, evaluations: true,
      });
      if (response) setHistory({ hub, points: response.evaluations });
    } catch {
      setFailed(true);
    }
  }
  const points = history?.hub === hub ? history?.points ?? [] : [];
  const numeric = points.flatMap(([evaluated, accepted, value]) =>
    value != null && Number.isFinite(value) ? [[Math.max(0, evaluated - accepted), value, accepted] as const] : []
  );
  const age = Math.max(1, ...numeric.map(([elapsed]) => elapsed));
  const low = Math.min(0, ...numeric.map(([, value]) => value));
  const high = Math.max(0.001, ...numeric.map(([, value]) => value));
  const latest = numeric.at(-1)?.[2];
  const mark = ([elapsed, value]: (typeof numeric)[number]): string =>
    `M ${12 + 248 * elapsed / age} ${85 - 72 * (value - low) / (high - low)} h 1`;
  const earlierMarks = numeric.filter(([, , accepted]) => accepted !== latest).map(mark).join(" ");
  const latestMarks = numeric.filter(([, , accepted]) => accepted === latest).map(mark).join(" ");
  return (
    <span className="benefitHistory" tabIndex={0} onMouseEnter={() => void load()} onFocus={() => void load()}>
      Benefit {benefit?.toFixed(3) ?? "—"}
      <span className="benefitHistoryPopup" role="tooltip">
        <strong>Candidate benefit by retained plan age</strong>
        {numeric.length ? (
          <>
            <svg viewBox="0 0 272 96" width="272" height="96" aria-label="Benefit versus time since acceptance">
              <path d="M 12 9 V 85 H 261" fill="none" stroke="currentColor" opacity={0.5} />
              <path d={earlierMarks} stroke="currentColor" opacity={0.25} stroke-width={2} />
              <path d={latestMarks} stroke="var(--primary-color, currentColor)" stroke-width={3} />
            </svg>
            <span>{low.toFixed(3)} to {high.toFixed(3)} · 0s to {formatDuration(age * 1000)}</span>
          </>
        ) : <span>{failed ? "Benefit history unavailable" : "No scored evaluations yet"}</span>}
        {points.length > numeric.length && <span>{points.length - numeric.length} evaluations without a score</span>}
      </span>
    </span>
  );
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
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
  const clear = selection && (store.candidatePreview || store.pinnedPlanId !== store.latestAcceptedId) ? (
    <button type="button" onClick={() => store.clearComparison(true)}>
      Clear comparison
    </button>
  ) : null;
  if (!segment || segment.plan.id === store.currentPlanMetadata?.accepted_at) {
    const candidate = store.candidatePreview;
    const current = store.currentPlanMetadata;
    const candidateOffset =
      Date.parse(candidate?.generated_at ?? "") - Date.parse(current?.accepted_at ?? "");
    return (
      <aside className="historicPlanInfo">
        <strong>{candidate ? "Candidate" : segment ? "Plan latest" : "Current plan"}</strong>
        {candidate ? (
          <>
            <div>Candidate cost {candidate.decision.candidate_cost?.toFixed(3) ?? "—"}</div>
            {Number.isFinite(candidateOffset) && candidateOffset >= 0 && (
              <div>
                {candidateOffset === 0
                  ? "Generated at the current plan’s acceptance time"
                  : `${formatDuration(candidateOffset)} after current plan acceptance`}
              </div>
            )}
            <div>
              {candidate.decision.accepted ? "Accepted" : "Not accepted"} ·{" "}
              {candidate.decision.reason.replaceAll("_", " ")}
            </div>
            <div>Benefit {candidate.decision.benefit?.toFixed(3) ?? "—"}</div>
            {candidate.decision.incumbent_cost != null && (
              <div>Retained plan repriced {candidate.decision.incumbent_cost.toFixed(3)}</div>
            )}
            <GateScores decision={candidate.decision} />
            {candidate.decision.benefit_drivers && <div>Largest cost changes {candidate.decision.benefit_drivers}</div>}
            {candidate.decision.conflicts && <div>Conflicting constraints: {candidate.decision.conflicts}</div>}
          </>
        ) : current ? (
          <>
            <div>Accepted {new Date(current.accepted_at).toLocaleString()}</div>
            <div>Horizon ends {new Date(current.ends * 1000).toLocaleString()}</div>
            <div>Rolling cost {current.rolling_cost?.toFixed(3) ?? "—"}</div>
            <div>Cost at acceptance {current.decision.candidate_cost?.toFixed(3) ?? "—"}</div>
            <div>Benefit at acceptance {current.decision.benefit?.toFixed(3) ?? "—"}</div>
            <GateScores decision={current.decision} />
            {current.decision.benefit_drivers && <div>Largest cost changes {current.decision.benefit_drivers}</div>}
            <div>Revision {current.revision ?? 0}</div>
            {Object.entries(current.correction_energy_used ?? {}).map(([name, energy]) => (
              <div key={name}>{name} elapsed correction {energy.toFixed(3)} kWh</div>
            ))}
            {Object.entries(current.corrections ?? {}).map(([name, correction]) => (
              <div key={name}>{name} correction {correction.power_kw.toFixed(3)} kW peak · {correction.energy_kwh.toFixed(3)} kWh total</div>
            ))}
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
    soc_limit_penalty:
      "The retained schedule incurs higher penalties for exceeding configured SoC limits. Reducing those penalties made the candidate clear the acceptance threshold.",
    acceptance_interval:
      "The candidate cleared the savings threshold before the minimum acceptance interval elapsed.",
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
      <div>{plan.revision ?? 0} schedule revisions · comparison shows original acceptance</div>
      {plan.execution_truncated && <div>Older revision trace points were pruned to bound archive storage.</div>}
      <div>{reasons[plan.decision.reason] ?? plan.decision.reason.replaceAll("_", " ")}</div>
      {plan.decision.conflicts && <div>Conflicting constraints: {plan.decision.conflicts}</div>}
      {nextCost !== undefined && <div>Saved plan cost {nextCost.toFixed(3)}</div>}
      {plan.decision.incumbent_cost != null && (
        <div>Previous plan repriced at acceptance {plan.decision.incumbent_cost.toFixed(3)}</div>
      )}
      <GateScores decision={plan.decision} />
      {plan.decision.benefit_drivers && <div>Largest cost changes {plan.decision.benefit_drivers}</div>}
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

function GateScores({ decision }: { decision: PlanSummary["decision"] }): JSX.Element | null {
  const { gate_incumbent_cost: retained, gate_candidate_cost: candidate } = decision;
  if (retained == null || candidate == null) return null;
  return <div>Discounted gate costs · retained {retained.toFixed(3)} · candidate {candidate.toFixed(3)}</div>;
}
