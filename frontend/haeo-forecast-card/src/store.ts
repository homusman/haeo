import { actualPoints, measuredAt } from "./actual-points";
import { archivedSeries } from "./archived-series";
import { discoverActualSources, type PowerMeasurement } from "./actual-sources";
import { computed, makeAutoObservable, observable } from "mobx";

import { clamp, linearScale } from "./geometry";
import { computeHoverIndices, sharedTimeline } from "./hover";
import { calculatePowerBounds, powerValueForDisplay } from "./power-display";
import { classifyPowerSeries, isPowerPotentialSeries, powerPairKey } from "./power-series-classification";
import { normalizeSeries } from "./series";
import { type WindowBand, windowBands } from "./window-bands";
import type { HassLike } from "./series";
import type { PlanDetail, PlanSegment, RecorderState } from "./plan-view";
import type { LineSvgPath, PowerShape } from "./store-paths";
import { computeHoveredPowerKeys, computePowerShapes, computePricePaths, computeSocPaths } from "./store-paths";
import { buildTooltipRows, type TooltipSectionId } from "./tooltip-helpers";
import { clampHorizonToOptions, horizonPresetToDuration, type HorizonOption } from "./horizon-config";
import { displayFormat, type DisplayFormat } from "./locale-format";
import type { ChartMargins, ForecastCardConfig, ForecastSeries, LaneBounds, PowerDisplayMode } from "./types";

const DEFAULT_HEIGHT = 360;
const VISIBLE_LANES = new Set(["power", "price", "soc", "window"]);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HORIZON_ANIMATION_MS = 220;
const BASE_HORIZON_OPTIONS_MS = [
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  8 * HOUR_MS,
  12 * HOUR_MS,
] as const;

function between(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type { HorizonOption } from "./horizon-config";

export function formatHorizonDuration(durationMs: number): string {
  if (durationMs < HOUR_MS) {
    return `${Math.round(durationMs / MINUTE_MS)}m`;
  }
  if (durationMs < DAY_MS) {
    return `${Math.round(durationMs / HOUR_MS)}h`;
  }
  const days = durationMs / DAY_MS;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

interface Domain {
  min: number;
  max: number;
  step: number;
}

interface HorizonAnimation {
  from: Domain;
  to: Domain;
  startMs: number;
}

interface PlotPaths {
  powerShapes: PowerShape[];
  pricePaths: LineSvgPath[];
  socPaths: LineSvgPath[];
}

export class ForecastCardStore {
  hass: HassLike | null = null;
  config: ForecastCardConfig = { type: "custom:haeo-homusman-forecast-card" };
  pastHours = 0;
  powerRange: number | null = 15;
  priceRange: number | null = 2;
  pinnedPlanId: string | null = null;
  historyClock = Date.now();
  historyReady = false;
  candidatePreview: PlanDetail | null = null;
  segments: PlanSegment[] = [];
  historyDetails: Record<string, PlanDetail> = {};
  powerMeasurements: Record<string, PowerMeasurement> = {};
  actuals: Record<string, RecorderState[]> = {};
  normalizedSeriesCache: ForecastSeries[] = [];
  powerBoundsCache: LaneBounds = { min: -1, max: 1 };
  cardWidth = 640;
  width = 640;
  height = DEFAULT_HEIGHT;
  pointerX: number | null = null;
  pointerY: number | null = null;
  highlightedSeries: string | null = null;
  highlightedSeriesGroupKeys = new Set<string>();
  hoveredLegendElement: string | null = null;
  hiddenSeriesKeys = new Set<string>();
  forcedVisibleSeriesKeys = new Set<string>();
  visibilityRevision = 0;
  seriesDataRevision = 0;
  powerDisplayModeOverride: PowerDisplayMode | null = null;
  horizonDurationMs: HorizonOption = null;
  horizonRevision = 0;
  horizonAnimation: HorizonAnimation | null = null;
  horizonAnimationNowMs = 0;
  horizonAnimationFrame = 0;
  tooltipVisible = true;
  readonly instanceId: number;
  plotPathsSnapshot: PlotPaths | null = null;
  plotPathsSnapshotKey = "";

  constructor(instanceId = 0) {
    this.instanceId = instanceId;
    makeAutoObservable(this, {
      // Both are replaced wholesale and never mutated in place. Deep-observing
      // Home Assistant's whole state tree on every update blocks the main thread.
      hass: observable.ref,
      segments: observable.ref,
      actualSources: computed.struct,
      candidatePreview: observable.ref,
      historyDetails: observable.ref,
      actuals: observable.ref,
      powerMeasurements: observable.ref,
      normalizedSeriesCache: observable.ref,
      instanceId: false,
      plotPathsSnapshot: false,
      plotPathsSnapshotKey: false,
      margins: computed.struct,
      normalizedSeries: computed.struct,
      visibleSeries: computed.struct,
      powerBounds: computed.struct,
      priceBounds: computed.struct,
      socBounds: computed.struct,
      tooltipRows: computed.struct,
      format: computed.struct,
      cachedXScale: computed,
    });
  }

  // --- Mutations ---

  setHass(hass: HassLike): void {
    this.hass = hass;
    this.refreshNormalizedSeries();
  }

  setPastHours(hours: number): void {
    this.pastHours = Math.min(this.historyLimitHours, Math.max(0, hours));
  }

  setHistoryClock(now: number): void {
    this.historyClock = now;
    this.historyReady = true;
  }

  setCandidatePreview(plan: PlanDetail | null): void {
    this.candidatePreview = plan;
    this.seriesDataRevision += 1;
    this.recomputePowerBounds();
  }

  setSegments(segments: PlanSegment[]): void {
    this.segments = segments;
    if (this.pinnedPlanId && !segments.some(({ plan }) => plan.id === this.pinnedPlanId)) this.pinnedPlanId = null;
    const ids = new Set(segments.map((segment) => segment.plan.id));
    this.historyDetails = Object.fromEntries(Object.entries(this.historyDetails).filter(([id]) => ids.has(id)));
  }

  addHistoryDetail(detail: PlanDetail): void {
    this.historyDetails = { ...this.historyDetails, [detail.id]: detail };
  }

  get actualSources(): Record<string, string> {
    return discoverActualSources(this.hass, this.config, this.normalizedSeriesCache, this.powerMeasurements);
  }

  setPowerMeasurements(measurements: Record<string, PowerMeasurement>): void {
    this.powerMeasurements = measurements;
  }

  get pinnedComparisonSeries(): ForecastSeries[] {
    const detail = this.pinnedPlanId && this.historyDetails[this.pinnedPlanId];
    return detail ? archivedSeries(this.visibleSeries, this.hass, detail) : [];
  }

  setActuals(actuals: Record<string, RecorderState[]>): void {
    this.actuals = actuals;
  }

  setConfig(config: ForecastCardConfig): void {
    if (this.config.hub_entry_id !== config.hub_entry_id) {
      this.setSegments([]);
      this.setCandidatePreview(null);
      this.setActuals({});
      this.setPowerMeasurements({});
    }
    this.config = config;
    this.applyConfigDefaults();
    this.refreshNormalizedSeries();
  }

  setSize(width: number, height: number, cardWidth = width): void {
    this.cardWidth = Math.max(240, cardWidth);
    this.width = Math.max(240, width);
    this.height = Math.max(220, height);
  }

  responsiveHeight(width: number): number {
    if (width <= 640) {
      return 680;
    }
    return Math.max(260, Math.min(520, Math.round(width * 0.52)));
  }

  setPointer(x: number | null, y: number | null): void {
    this.pointerX = x;
    this.pointerY = y;
  }

  setHighlightedSeries(key: string | null): void {
    this.highlightedSeries = key;
  }

  setHighlightedSeriesGroup(keys: string[] | null): void {
    this.highlightedSeriesGroupKeys = new Set(keys ?? []);
  }

  setHoveredLegendElement(elementName: string | null): void {
    this.hoveredLegendElement = elementName;
  }

  toggleSeriesVisibility(key: string): void {
    const keys = this.visibilityGroupKeys(key);
    const allHidden = keys.every((seriesKey) => this.hiddenSeriesKeys.has(seriesKey));
    for (const seriesKey of keys) {
      if (allHidden) {
        this.hiddenSeriesKeys.delete(seriesKey);
        this.forcedVisibleSeriesKeys.add(seriesKey);
      } else {
        this.hiddenSeriesKeys.add(seriesKey);
        this.forcedVisibleSeriesKeys.delete(seriesKey);
      }
    }
    this.visibilityRevision += 1;
    this.recomputePowerBounds();
    if (this.highlightedSeries !== null && keys.includes(this.highlightedSeries)) {
      this.highlightedSeries = null;
    }
  }

  toggleElementVisibility(elementName: string): void {
    const keys = this.normalizedSeries
      .filter((s) => VISIBLE_LANES.has(s.lane) && s.elementName === elementName)
      .map((s) => s.key);
    if (keys.length === 0) {
      return;
    }
    const allHidden = keys.every((key) => this.hiddenSeriesKeys.has(key));
    if (allHidden) {
      for (const key of keys) {
        this.hiddenSeriesKeys.delete(key);
        this.forcedVisibleSeriesKeys.add(key);
      }
    } else {
      for (const key of keys) {
        this.hiddenSeriesKeys.add(key);
        this.forcedVisibleSeriesKeys.delete(key);
        if (this.highlightedSeries === key) {
          this.highlightedSeries = null;
        }
      }
    }
    this.visibilityRevision += 1;
    this.recomputePowerBounds();
  }

  togglePowerDisplayMode(): void {
    this.powerDisplayModeOverride = this.powerDisplayMode === "opposed" ? "overlay" : "opposed";
    this.recomputePowerBounds();
  }

  toggleTooltipVisibility(): void {
    this.tooltipVisible = !this.tooltipVisible;
  }

  setHorizon(durationMs: HorizonOption): void {
    if (this.horizonDurationMs === durationMs) {
      return;
    }
    const from = this.xDomain;
    this.horizonDurationMs = durationMs;
    this.horizonRevision += 1;
    const to = this.selectedXDomain;
    this.startHorizonAnimation(from, to);
    this.recomputePowerBounds();
  }

  // --- Computed: config-derived ---

  get powerDisplayMode(): PowerDisplayMode {
    return this.powerDisplayModeOverride ?? this.config.power_display_mode ?? "opposed";
  }

  get locale(): string {
    return this.hass?.language ?? this.hass?.locale?.language ?? "en";
  }

  /** How dates, times and numbers are shown, following the localization settings in the user profile. */
  get format(): DisplayFormat {
    return displayFormat(this.locale, this.hass?.locale, this.hass?.config?.time_zone);
  }

  // --- Computed: layout ---

  get margins(): ChartMargins {
    const compact = this.width < 420;
    const left = between(compact ? 56 : 72, this.width * 0.075, 92);
    const right = between(compact ? 64 : 84, this.width * 0.085, 112);
    return {
      top: compact ? 20 : 26,
      right: Math.round(right),
      bottom: compact ? 42 : 50,
      left: Math.round(left),
    };
  }

  get plotTop(): number {
    return this.margins.top;
  }

  get plotBottom(): number {
    return this.height - this.margins.bottom;
  }

  // --- Computed: series filtering ---

  get normalizedSeries(): ForecastSeries[] {
    return this.normalizedSeriesCache;
  }

  get pairedPowerPotentialKeys(): Set<string> {
    const utilizationPairs = new Set(
      this.normalizedSeries
        .filter((series) => series.lane === "power" && series.sourceRole === "output")
        .map((series) => powerPairKey(series))
    );
    return new Set(
      this.normalizedSeries
        .filter((series) => isPowerPotentialSeries(series) && utilizationPairs.has(powerPairKey(series)))
        .map((series) => series.key)
    );
  }

  get legendSeries(): ForecastSeries[] {
    const pairedPotentials = this.pairedPowerPotentialKeys;
    return this.normalizedSeries.filter((s) => VISIBLE_LANES.has(s.lane) && !pairedPotentials.has(s.key));
  }

  get visibleSeries(): ForecastSeries[] {
    return this.normalizedSeries.filter((s) => VISIBLE_LANES.has(s.lane) && !this.hiddenSeriesKeys.has(s.key));
  }

  get plottedSeries(): ForecastSeries[] {
    const candidate = this.candidatePreview;
    if (!candidate) return this.visibleSeries;
    const candidateSeries = new Map(
      archivedSeries(this.visibleSeries, this.hass, candidate).map((item) => [item.key, item])
    );
    return this.visibleSeries.flatMap((item) => {
      const replacement = candidateSeries.get(item.key);
      return replacement ? [replacement] : item.sourceRole !== "output" ? [item] : [];
    });
  }

  get powerSeries(): ForecastSeries[] {
    return this.plottedSeries.filter((s) => s.lane === "power" && s.sourceRole !== "limit");
  }

  get orderedPowerSeries(): ForecastSeries[] {
    return this.sortPowerSeries(this.powerSeries);
  }

  private sortPowerSeries(series: ForecastSeries[]): ForecastSeries[] {
    return [...series].sort((a, b) => {
      // Primary sort: optimizer priority from the backend determines stack order.
      const aPriority = a.priority ?? Number.POSITIVE_INFINITY;
      const bPriority = b.priority ?? Number.POSITIVE_INFINITY;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.label.localeCompare(b.label);
    });
  }

  get priceSeries(): ForecastSeries[] {
    return this.plottedSeries.filter((s) => s.lane === "price");
  }

  get windowSeries(): ForecastSeries[] {
    return this.plottedSeries.filter((s) => s.lane === "window");
  }

  get windowBands(): WindowBand[] {
    return windowBands(this.windowSeries, (time) => this.xScale(time), this.fullXDomain.max);
  }

  get socSeries(): ForecastSeries[] {
    return this.plottedSeries.filter((s) => s.lane === "soc");
  }

  get hasData(): boolean {
    return this.legendSeries.length > 0;
  }

  get hasPlottedData(): boolean {
    return this.visibleSeries.length > 0;
  }

  // --- Computed: focus/highlight ---

  get focusedElementSeriesKeys(): Set<string> {
    if (this.hoveredLegendElement === null) {
      return new Set();
    }
    const focused = new Set<string>();
    for (const series of this.visibleSeries) {
      if (series.elementName === this.hoveredLegendElement) {
        focused.add(series.key);
      }
    }
    return focused;
  }

  get focusedLegendSeriesKeys(): Set<string> {
    if (this.highlightedSeriesGroupKeys.size > 0) {
      return new Set(this.highlightedSeriesGroupKeys);
    }
    if (this.highlightedSeries !== null) {
      return new Set([this.highlightedSeries]);
    }
    return this.focusedElementSeriesKeys;
  }

  // --- Computed: x-axis / animation ---

  get fullXDomain(): Domain {
    if (!this.hasPlottedData) {
      const now = Date.now();
      return { min: now, max: now + 60_000, step: 60_000 };
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let step = Number.POSITIVE_INFINITY;
    for (const item of this.visibleSeries) {
      if (item.times.length < 2) continue;
      const first = item.times[0];
      const second = item.times[1];
      const last = item.times[item.times.length - 1];
      if (first === undefined || second === undefined || last === undefined) continue;
      min = Math.min(min, first);
      max = Math.max(max, last);
      step = Math.min(step, Math.max(1, second - first));
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
      const now = Date.now();
      return { min: now, max: now + 60_000, step: 60_000 };
    }
    return { min, max, step };
  }

  get selectedXDomain(): Domain {
    const domain = this.fullXDomain;
    if (this.historyReady) {
      const now = this.historyClock;
      return {
        min: now - this.pastHours * HOUR_MS,
        max: this.horizonDurationMs === null ? Math.max(now + MINUTE_MS, domain.max) : now + this.horizonDurationMs,
        step: domain.step,
      };
    }
    if (this.horizonDurationMs === null) {
      return domain;
    }
    const horizonMax = domain.min + this.horizonDurationMs;
    return {
      min: domain.min,
      max: Math.min(domain.max, horizonMax),
      step: domain.step,
    };
  }

  get pastOptions(): number[] {
    const limit = this.historyLimitHours;
    return [
      0,
      ...BASE_HORIZON_OPTIONS_MS.map((duration) => duration / HOUR_MS).filter((hours) => hours < limit),
      ...[24, 48, 72, 96, 120, 144].filter((hours) => hours < limit),
      limit,
    ];
  }

  get historyLimitHours(): number {
    const domain = this.fullXDomain;
    return Math.max(1, Math.min(168, Math.ceil((domain.max - domain.min) / HOUR_MS)));
  }

  toggleComparisonPin(): void {
    this.pinnedPlanId = this.pinnedPlanId === null ? (this.hoveredPlan?.plan.id ?? null) : null;
  }

  setAxisRange(axis: "power" | "price", value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    if (axis === "power") this.powerRange = value;
    else this.priceRange = value;
  }

  get hoveredPlan(): PlanSegment | null {
    if (this.pinnedPlanId) return this.segments.find(({ plan }) => plan.id === this.pinnedPlanId) ?? null;
    if (
      !this.pastHours ||
      this.pointerX === null ||
      this.pointerY === null ||
      this.pointerY < this.plotTop ||
      this.pointerY > this.plotBottom
    )
      return null;
    const width = this.width - this.margins.left - this.margins.right;
    const ratio = (this.pointerX - this.margins.left) / width;
    if (ratio < 0 || ratio > 1) return null;
    const domain = this.xDomain;
    const time = domain.min + ratio * (domain.max - domain.min);
    return this.segments.find((segment) => segment.start <= time && time < segment.end) ?? null;
  }

  get xDomain(): Domain {
    const animation = this.horizonAnimation;
    if (animation === null) {
      return this.selectedXDomain;
    }
    const elapsed = this.horizonAnimationNowMs - animation.startMs;
    const progress = clamp(elapsed / HORIZON_ANIMATION_MS, 0, 1);
    const eased = 1 - (1 - progress) ** 3;
    return {
      min: animation.from.min + (animation.to.min - animation.from.min) * eased,
      max: animation.from.max + (animation.to.max - animation.from.max) * eased,
      step: animation.to.step,
    };
  }

  get horizonOptions(): HorizonOption[] {
    const fullDuration = this.fullXDomain.max - this.fullXDomain.min;
    const options = BASE_HORIZON_OPTIONS_MS.filter((duration) => duration < fullDuration);
    const maxWholeDays = Math.max(0, Math.floor(fullDuration / DAY_MS));
    for (let day = 1; day < maxWholeDays; day += 1) {
      const duration = day * DAY_MS;
      if (duration > (options[options.length - 1] ?? 0) && duration < fullDuration) {
        options.push(duration);
      }
    }
    return [...options, null];
  }

  /** Cached x-scale function reused by plotPaths and hover mapping. */
  get cachedXScale(): (time: number) => number {
    const { min, max } = this.xDomain;
    const innerWidth = this.width - this.margins.left - this.margins.right;
    const left = this.margins.left;
    return (time: number) => linearScale(time, min, max, left, left + innerWidth);
  }

  xScale(time: number): number {
    return this.cachedXScale(time);
  }

  // --- Computed: y-axis bounds ---

  private _bounds(seriesList: ForecastSeries[], fallback: LaneBounds): LaneBounds {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const series of seriesList) {
      for (const value of series.values) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return fallback;
    }
    min = Math.min(min, 0);
    max = Math.max(max, 0);
    if (min === max) {
      const delta = Math.max(1, Math.abs(min) * 0.15);
      return { min: min - delta, max: max + delta };
    }
    const padding = Math.max(0.1, (max - min) * 0.08);
    return { min: min - padding, max: max + padding };
  }

  get powerBounds(): LaneBounds {
    return this.powerRange === null ? this.powerBoundsCache : { min: -this.powerRange, max: this.powerRange };
  }

  get priceBounds(): LaneBounds {
    return this.priceRange === null
      ? this._bounds(this.priceSeries, { min: 0, max: 1 })
      : { min: -this.priceRange, max: this.priceRange };
  }

  get socBounds(): LaneBounds {
    return { min: 0, max: 100 };
  }

  // --- Computed: y-scale functions ---

  yScalePower(value: number): number {
    return linearScale(value, this.powerBounds.min, this.powerBounds.max, this.plotBottom, this.plotTop);
  }

  yScalePrice(value: number): number {
    const zeroY = this.yScalePower(0);
    if (value >= 0) {
      const positiveMax = Math.max(this.priceBounds.max, 0.001);
      return linearScale(value, 0, positiveMax, zeroY, this.plotTop);
    }
    const negativeMin = Math.min(this.priceBounds.min, -0.001);
    return linearScale(value, negativeMin, 0, this.plotBottom, zeroY);
  }

  yScaleSoc(value: number): number {
    const zeroY = this.yScalePower(0);
    return linearScale(value, this.socBounds.min, this.socBounds.max, zeroY, this.plotTop);
  }

  // --- Computed: hover ---

  get isHoverInPlot(): boolean {
    if (this.pointerX === null || this.pointerY === null) {
      return false;
    }
    return (
      this.pointerX >= this.margins.left &&
      this.pointerX <= this.width - this.margins.right &&
      this.pointerY >= this.plotTop &&
      this.pointerY <= this.plotBottom
    );
  }

  get hoverTimeMs(): number | null {
    if (this.pointerX === null) {
      return null;
    }
    const x = clamp(this.pointerX, this.margins.left, this.width - this.margins.right);
    const { min, max } = this.xDomain;
    const innerWidth = this.width - this.margins.left - this.margins.right;
    const ratio = innerWidth > 0 ? (x - this.margins.left) / innerWidth : 0;
    const time = min + ratio * (max - min);
    return time;
  }

  get panelTimeMs(): number {
    return this.hoverTimeMs ?? (this.historyReady ? this.historyClock : this.xDomain.min);
  }

  get hoverX(): number | null {
    const time = this.hoverTimeMs;
    return time === null ? null : this.xScale(time);
  }

  get hoverIndices(): Map<string, number> {
    const time = this.hoverTimeMs;
    if (time === null) {
      return new Map();
    }
    return computeHoverIndices(this.plottedSeries, time);
  }

  get panelIndices(): Map<string, number> {
    return computeHoverIndices(this.plottedSeries, this.panelTimeMs);
  }

  get sharedTimeline(): Float64Array | null {
    return sharedTimeline(this.plottedSeries);
  }

  // --- Computed: SVG paths ---

  private plotPathsCacheKey(): string {
    const { min, max } = this.xDomain;
    return [
      this.seriesDataRevision,
      this.visibilityRevision,
      this.powerDisplayMode,
      this.width,
      this.height,
      this.horizonDurationMs,
      min,
      max,
      this.horizonAnimationNowMs,
      this.powerBounds.min,
      this.powerBounds.max,
      this.priceBounds.min,
      this.priceBounds.max,
    ].join("\0");
  }

  get plotPaths(): PlotPaths {
    const key = this.plotPathsCacheKey();
    if (this.plotPathsSnapshot !== null && this.plotPathsSnapshotKey === key) {
      return this.plotPathsSnapshot;
    }
    const snapshot = this.pathsForSeries(this.plottedSeries);
    this.plotPathsSnapshotKey = key;
    this.plotPathsSnapshot = snapshot;
    return snapshot;
  }

  pathsForSeries(series: ForecastSeries[]): PlotPaths {
    const xScale = this.cachedXScale;
    return {
      powerShapes: computePowerShapes(
        this.sortPowerSeries(series.filter((item) => item.lane === "power" && item.sourceRole !== "limit")),
        this.powerBounds,
        this.powerDisplayMode,
        this.plotTop,
        this.plotBottom,
        xScale
      ),
      pricePaths: computePricePaths(
        series.filter((item) => item.lane === "price"),
        this.powerBounds,
        this.priceBounds,
        this.plotTop,
        this.plotBottom,
        xScale
      ),
      socPaths: computeSocPaths(
        series.filter((item) => item.lane === "soc"),
        this.powerBounds,
        this.socBounds,
        this.plotTop,
        this.plotBottom,
        xScale
      ),
    };
  }

  get powerShapes(): PowerShape[] {
    return this.plotPaths.powerShapes;
  }

  get hoveredPowerSeriesKeys(): Set<string> {
    if (!this.isHoverInPlot || this.pointerY === null) {
      return new Set();
    }
    const time = this.hoverTimeMs;
    if (time === null) {
      return new Set();
    }
    return computeHoveredPowerKeys(
      this.orderedPowerSeries,
      this.hoverIndices,
      this.powerDisplayMode,
      this.powerBounds,
      this.plotTop,
      this.plotBottom,
      this.pointerY
    );
  }

  get pricePaths(): LineSvgPath[] {
    return this.plotPaths.pricePaths;
  }

  get socPaths(): LineSvgPath[] {
    return this.plotPaths.socPaths;
  }

  // --- Computed: tooltip ---

  private powerValueForDisplayBound(series: ForecastSeries, value: number): number {
    return powerValueForDisplay(series, value, this.powerDisplayMode);
  }

  get tooltipRows(): Array<{
    key: string;
    possibleKey?: string;
    label: string;
    value: number;
    comparison?: { current: number | undefined; historical: number | undefined; measured: number | undefined };
    possibleValue?: number;
    unit: string;
    color: string;
    lane: TooltipSectionId;
  }> {
    const rows = buildTooltipRows(
      this.plottedSeries,
      this.panelIndices,
      this.normalizedSeries,
      computeHoverIndices(this.normalizedSeries, this.panelTimeMs),
      (series, value) => this.powerValueForDisplayBound(series, value)
    );
    const detail = this.pinnedPlanId && this.historyDetails[this.pinnedPlanId];
    if (!detail && !this.pastHours) return rows;
    const current = this.visibleSeries;
    const historic = detail ? archivedSeries(this.visibleSeries, this.hass, detail) : [];
    const time = this.panelTimeMs;
    const sample = (series: ForecastSeries | undefined): number | undefined => {
      if (!series || time < series.times[0]! || time > series.times.at(-1)!) return undefined;
      const idx = computeHoverIndices([series], time).get(series.key);
      const value = idx === undefined ? undefined : series.values[idx];
      return value === undefined ? undefined : this.powerValueForDisplayBound(series, value);
    };
    return rows.map((row) => ({
      ...row,
      comparison: {
        current: sample(current.find((item) => item.key === row.key)),
        historical: sample(historic.find((item) => item.key === row.key)),
        measured: (() => {
          const series = this.visibleSeries.find((item) => item.key === row.key);
          if (!series) return undefined;
          const value = measuredAt(actualPoints(this, series), time);
          return value === undefined ? undefined : this.powerValueForDisplayBound(series, value);
        })(),
      },
    }));
  }

  get tooltipEmphasisKeys(): Set<string> {
    const keys = new Set<string>();
    for (const key of this.hoveredPowerSeriesKeys) {
      keys.add(key);
    }
    for (const key of this.highlightedSeriesGroupKeys) {
      keys.add(key);
    }
    if (this.highlightedSeries !== null) {
      keys.add(this.highlightedSeries);
    }
    return keys;
  }

  // --- Internal ---

  private visibilityGroupKeys(key: string): string[] {
    const series = this.normalizedSeries.find((item) => item.key === key);
    if (series?.lane !== "power" || series.sourceRole !== "output") {
      return [key];
    }
    const pairKey = powerPairKey(series);
    return this.normalizedSeries
      .filter((item) => item.key === key || (isPowerPotentialSeries(item) && powerPairKey(item) === pairKey))
      .map((item) => item.key);
  }

  private applyDefaultHiddenSeries(): void {
    let hiddenChanged = false;
    const directionalByElement = new Map<string, { hasProd: boolean; hasCons: boolean }>();
    for (const series of this.normalizedSeries) {
      if (series.lane !== "power") continue;
      const category = classifyPowerSeries(series);
      const existing = directionalByElement.get(series.elementName) ?? { hasProd: false, hasCons: false };
      if (category.group === "production" && category.subgroup === "utilization") {
        existing.hasProd = true;
      }
      if (category.group === "consumption" && category.subgroup === "utilization") {
        existing.hasCons = true;
      }
      directionalByElement.set(series.elementName, existing);
    }
    for (const series of this.normalizedSeries) {
      if (this.forcedVisibleSeriesKeys.has(series.key)) {
        continue;
      }

      // Hide all policy element series and load price outputs (summary marginal prices) by default.
      const isLoadPriceOutput =
        series.elementType === "load" && series.sourceRole === "output" && series.outputType === "price";
      if (series.elementType === "policy" || isLoadPriceOutput) {
        const before = this.hiddenSeriesKeys.size;
        this.hiddenSeriesKeys.add(series.key);
        hiddenChanged ||= this.hiddenSeriesKeys.size !== before;
        continue;
      }

      if (series.lane !== "power") continue;
      const isGrid = series.elementName.toLowerCase().includes("grid");
      const category = classifyPowerSeries(series);
      const output = series.outputName.toLowerCase();
      const pair = directionalByElement.get(series.elementName);

      const hideByDefault =
        (isGrid && category.subgroup === "potential") ||
        ((output.includes("active") || output.includes("balance")) &&
          pair !== undefined &&
          pair.hasProd &&
          pair.hasCons);
      if (hideByDefault) {
        const before = this.hiddenSeriesKeys.size;
        this.hiddenSeriesKeys.add(series.key);
        hiddenChanged ||= this.hiddenSeriesKeys.size !== before;
      }
    }
    if (hiddenChanged) {
      this.visibilityRevision += 1;
    }
  }

  private refreshNormalizedSeries(): void {
    const nextSeries = normalizeSeries(this.hass, this.config);

    this.normalizedSeriesCache = nextSeries;
    this.seriesDataRevision += 1;

    const seriesKeys = new Set(nextSeries.map((s) => s.key));
    this.hiddenSeriesKeys = new Set([...this.hiddenSeriesKeys].filter((key) => seriesKeys.has(key)));
    this.forcedVisibleSeriesKeys = new Set([...this.forcedVisibleSeriesKeys].filter((key) => seriesKeys.has(key)));
    if (this.highlightedSeries !== null && !seriesKeys.has(this.highlightedSeries)) {
      this.highlightedSeries = null;
    }
    this.highlightedSeriesGroupKeys = new Set(
      [...this.highlightedSeriesGroupKeys].filter((key) => seriesKeys.has(key))
    );
    if (this.hoveredLegendElement !== null) {
      const hasHoveredElement = nextSeries.some((s) => s.elementName === this.hoveredLegendElement);
      if (!hasHoveredElement) {
        this.hoveredLegendElement = null;
      }
    }

    this.applyDefaultHiddenSeries();
    this.recomputePowerBounds();
    this.clampHorizonToAvailableOptions();
  }

  private applyConfigDefaults(): void {
    this.powerDisplayModeOverride = null;
    this.tooltipVisible = this.config.tooltip_visible ?? true;
    const nextHorizon = horizonPresetToDuration(this.config.default_horizon);
    if (this.horizonDurationMs !== nextHorizon) {
      this.horizonDurationMs = nextHorizon;
      this.horizonRevision += 1;
    }
  }

  private clampHorizonToAvailableOptions(): void {
    if (!this.hasData) {
      return;
    }
    const clamped = clampHorizonToOptions(this.horizonDurationMs, this.horizonOptions);
    if (clamped === this.horizonDurationMs) {
      return;
    }
    this.horizonDurationMs = clamped;
    this.horizonRevision += 1;
  }

  private startHorizonAnimation(from: Domain, to: Domain): void {
    if (this.horizonAnimationFrame !== 0) {
      cancelAnimationFrame(this.horizonAnimationFrame);
      this.horizonAnimationFrame = 0;
    }
    const startMs = globalThis.performance.now();
    this.horizonAnimation = { from, to, startMs };
    this.horizonAnimationNowMs = startMs;
    const tick = (nowMs: number): void => {
      this.horizonAnimationNowMs = nowMs;
      if (nowMs - startMs >= HORIZON_ANIMATION_MS) {
        this.horizonAnimation = null;
        this.horizonAnimationFrame = 0;
        return;
      }
      this.horizonAnimationFrame = requestAnimationFrame(tick);
    };
    this.horizonAnimationFrame = requestAnimationFrame(tick);
  }

  private recomputePowerBounds(): void {
    this.powerBoundsCache = calculatePowerBounds(this.orderedPowerSeries, this.powerDisplayMode);
  }
}
