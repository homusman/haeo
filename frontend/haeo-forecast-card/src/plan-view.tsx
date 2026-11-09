import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { observer } from "./mobx-observer";
import type { ForecastCardStore } from "./store";

interface Decision {
  reason: string;
  benefit: number | null;
}

interface PlanSummary {
  id: string;
  accepted_at?: string;
  decision: Decision;
}

export interface PlanDetail extends PlanSummary {
  series: Record<string, Record<string, [number, number][]>>;
}

export const PlanControls = observer(function PlanControls({
  store,
}: {
  store: ForecastCardStore;
}): JSX.Element | null {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  const request = useRef(0);
  const hub = store.config.hub_entry_id;
  const hass = store.hass;
  if (!hub || !hass?.callWS) return null;

  const message = { type: "haeo_homusman/plans", entry_id: hub };
  async function loadPlans(before?: string): Promise<void> {
    const sequence = ++request.current;
    try {
      const page = await hass?.callWS?.<{ plans: PlanSummary[]; decision: Decision }>({
        ...message,
        ...(before ? { before } : {}),
      });
      if (!page || request.current !== sequence || store.config.hub_entry_id !== hub) return;
      setPlans(before ? [...plans, ...page.plans] : page.plans);
      setMore(page.plans.length === 32);
      setDecision(page.decision);
      setError(false);
    } catch {
      if (request.current === sequence) setError(true);
    }
  }

  async function select(id: string): Promise<void> {
    const sequence = ++request.current;
    if (!id) {
      store.setPreviewPlan(null);
      setError(false);
      return;
    }
    try {
      const plan = await hass?.callWS?.<PlanDetail>({ ...message, plan_id: id });
      if (!plan || request.current !== sequence || store.config.hub_entry_id !== hub) return;
      store.setPreviewPlan(plan);
      setError(false);
    } catch {
      if (request.current === sequence) setError(true);
    }
  }

  const preview = store.previewPlan;
  const activeDecision = preview?.decision ?? decision;
  return (
    <div className="planControls">
      <label>
        Plan{" "}
        <select
          value={preview?.accepted_at ? preview.id : preview ? "candidate" : ""}
          onChange={(event) => void select(event.currentTarget.value)}
        >
          <option value="">Current accepted</option>
          <option value="candidate">Latest candidate (preview)</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {new Date(plan.id).toLocaleString()}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="button" onClick={() => void loadPlans()}>
        Load history
      </button>{" "}
      {more && (
        <button type="button" onClick={() => void loadPlans(plans.at(-1)?.id)}>
          Older plans
        </button>
      )}
      {activeDecision?.reason && (
        <div>
          {preview ? (preview.accepted_at ? "Archived plan" : "Candidate preview") : "Last decision"} ·{" "}
          {activeDecision.reason.replaceAll("_", " ")}
          {activeDecision.benefit != null && ` · modeled benefit ${activeDecision.benefit.toFixed(3)}`}
        </div>
      )}
      {error && <div role="status">Plan unavailable. History requires a Home Assistant administrator.</div>}
    </div>
  );
});
