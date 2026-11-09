import type { JSX } from "preact";

import { HistoryLayer } from "./HistoryLayer";
import { AxesGrid } from "./AxesGrid";
import { OverlayLineLayer } from "./OverlayLineLayer";
import { PowerStackLayer } from "./PowerStackLayer";
import { windowBands } from "../window-bands";
import { observer } from "../mobx-observer";
import type { ForecastCardStore } from "../store";

interface ChartSvgProps {
  store: ForecastCardStore;
  comparison?: boolean;
  onPointerMove: (event: PointerEvent) => void;
  onPointerLeave: () => void;
}

const AxesLayer = observer(function AxesLayer(props: { store: ForecastCardStore }): JSX.Element {
  const { store } = props;
  return (
    <AxesGrid
      format={store.format}
      width={store.width}
      height={store.height}
      left={store.margins.left}
      right={store.margins.right}
      top={store.plotTop}
      bottom={store.plotBottom}
      xMin={store.xDomain.min}
      xMax={store.xDomain.max}
      xScale={(time) => store.xScale(time)}
      yScalePower={(value) => store.yScalePower(value)}
      powerMin={store.powerBounds.min}
      powerMax={store.powerBounds.max}
      priceMin={store.priceBounds.min}
      priceMax={store.priceBounds.max}
      yScalePrice={(value) => store.yScalePrice(value)}
    />
  );
});

// Height and gap of each window's strip along the top of the plot
const WINDOW_STRIP_HEIGHT = 4;
const WINDOW_STRIP_GAP = 1;

const WindowLayer = observer(function WindowLayer(props: {
  store: ForecastCardStore;
  comparison: boolean;
}): JSX.Element {
  const { store } = props;
  const height = store.plotBottom - store.plotTop;
  return (
    <g className="windowLayer">
      {(props.comparison
        ? windowBands(
            store.pinnedComparisonSeries.filter(({ lane }) => lane === "window"),
            (time) => store.xScale(time),
            store.xDomain.max
          )
        : store.windowBands
      ).map((band) => {
        const active = store.highlightedSeries === band.seriesKey || store.focusedLegendSeriesKeys.has(band.seriesKey);
        return (
          <g key={band.key} className={`windowBand ${active ? "active" : ""}`} style={{ color: band.color }}>
            <rect className="windowTint" x={band.x} y={store.plotTop} width={band.width} height={height} />
            <rect
              className="windowStrip"
              x={band.x}
              y={store.plotTop + band.row * (WINDOW_STRIP_HEIGHT + WINDOW_STRIP_GAP)}
              width={band.width}
              height={WINDOW_STRIP_HEIGHT}
            />
          </g>
        );
      })}
    </g>
  );
});

const PowerLayer = observer(function PowerLayer(props: {
  store: ForecastCardStore;
  paths: ForecastCardStore["plotPaths"];
}): JSX.Element {
  const { store } = props;
  return (
    <PowerStackLayer
      shapes={props.paths.powerShapes}
      highlightedSeries={store.highlightedSeries}
      hoveredSeriesKeys={store.hoveredPowerSeriesKeys}
      focusedSeriesKeys={store.focusedLegendSeriesKeys}
    />
  );
});

const OverlayLayers = observer(function OverlayLayers(props: {
  store: ForecastCardStore;
  paths: ForecastCardStore["plotPaths"];
}): JSX.Element {
  const { store } = props;
  return (
    <>
      <OverlayLineLayer
        paths={props.paths.pricePaths}
        highlightedSeries={store.highlightedSeries}
        focusedSeriesKeys={store.focusedLegendSeriesKeys}
        cssClass="priceLine"
      />

      <OverlayLineLayer
        paths={props.paths.socPaths}
        highlightedSeries={store.highlightedSeries}
        focusedSeriesKeys={store.focusedLegendSeriesKeys}
        cssClass="socLine"
      />
    </>
  );
});

const HoverOverlay = observer(function HoverOverlay(props: { store: ForecastCardStore }): JSX.Element | null {
  const { store } = props;
  const time = store.hoverTimeMs;
  if (time === null) {
    return null;
  }
  const x = store.xScale(time);
  return <line className="hoverLine" x1={x} y1={store.plotTop} x2={x} y2={store.plotBottom} />;
});

const PlotViewport = observer(function PlotViewport(props: {
  store: ForecastCardStore;
  comparison: boolean;
}): JSX.Element {
  const { store } = props;
  const paths = props.comparison ? store.pathsForSeries(store.pinnedComparisonSeries) : store.plotPaths;
  const clipId = `future-${store.instanceId}${props.comparison ? "-comparison" : ""}`;
  const plotWidth = store.width - store.margins.left - store.margins.right;
  const plotHeight = store.plotBottom - store.plotTop;
  return (
    <svg
      className="plotViewport"
      x={store.margins.left}
      y={store.plotTop}
      width={plotWidth}
      height={plotHeight}
      overflow="hidden"
    >
      <g transform={`translate(${-store.margins.left} ${-store.plotTop})`}>
        <defs>
          <clipPath id={clipId}>
            <rect
              x={!props.comparison && store.historyReady ? store.xScale(store.historyClock) : store.margins.left}
              y={store.plotTop}
              width={plotWidth}
              height={plotHeight}
            />
          </clipPath>
        </defs>
        <g clip-path={`url(#${clipId})`}>
          <WindowLayer store={store} comparison={props.comparison} />
          <PowerLayer store={store} paths={paths} />
          <OverlayLayers store={store} paths={paths} />
          {props.comparison &&
            store.comparisonPowerDifferences.map((difference, index) => (
              <path
                key={difference.key + difference.direction + index}
                className={"powerDifference " + difference.direction}
                d={difference.path}
                fill={difference.color}
                stroke={difference.color}
              />
            ))}
        </g>
        {!props.comparison && <HistoryLayer store={store} />}
        <HoverOverlay store={store} />
      </g>
    </svg>
  );
});

export const ChartSvg = observer(function ChartSvg(props: ChartSvgProps): JSX.Element {
  const { store } = props;

  return (
    <svg
      width={store.width}
      height={store.height}
      data-comparison={props.comparison ?? false}
      onPointerMove={(event) => props.onPointerMove(event as unknown as PointerEvent)}
      onPointerLeave={props.onPointerLeave}
      onContextMenu={(event) => {
        event.preventDefault();
        store.clearComparison();
      }}
      onClick={(event) => {
        if (props.comparison) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width && bounds.height) {
          store.setPointer(
            ((event.clientX - bounds.left) / bounds.width) * store.width,
            ((event.clientY - bounds.top) / bounds.height) * store.height
          );
        }
        void store.selectComparisonAtCursor();
      }}
    >
      <AxesLayer store={store} />
      <PlotViewport store={store} comparison={props.comparison ?? false} />
    </svg>
  );
});
