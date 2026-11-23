import { useState } from 'react';
import { useElementSize } from '../hooks/use-element-size.js';
import './charts.css';

/**
 * Small hand-drawn SVG charts. Marks follow one spec: 2px lines with a faint area wash, columns at
 * most 24px wide with a 4px rounded cap, a 2px gap between neighbouring columns, hairline grid
 * lines, and a hover tooltip on every chart.
 */
const MARGIN = { top: 12, right: 16, bottom: 26, left: 64 };
const MAX_COLUMN_WIDTH = 24;
const COLUMN_GAP = 2;

/** About `count` round tick values covering 0..max (or min..max). */
function niceTicks(min, max, count = 4) {
  if (max === min) return [min];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rawStep);
  const ticks = [];
  for (let tick = Math.floor(min / step) * step; tick <= max + step * 0.001; tick += step) ticks.push(tick);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

function ChartTooltip({ x, y, width, children }) {
  // Keep the tooltip inside the chart: flip it to the left of the pointer near the right edge.
  const isFlipped = x > width - 180;
  return (
    <div className="chart-tooltip" style={{ top: y, left: isFlipped ? undefined : x + 12, right: isFlipped ? width - x + 12 : undefined }}>
      {children}
    </div>
  );
}

/**
 * A single-series line over time.
 * @param {{ points: { time: number, value: number }[], formatValue: (value: number) => string, formatTime: (time: number) => string, height?: number, label: string }} props
 */
export function LineChart({ points, formatValue, formatTime, height = 220, label }) {
  const [containerRef, { width }] = useElementSize();
  const [hoverIndex, setHoverIndex] = useState(null);
  if (points.length === 0) return <div className="notice">No data yet.</div>;

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const minTime = points[0].time;
  const maxTime = points.at(-1).time;
  const yTicks = niceTicks(0, Math.max(...points.map((point) => point.value), 1));
  const yMax = yTicks.at(-1);
  const toX = (time) => MARGIN.left + (maxTime === minTime ? plotWidth / 2 : ((time - minTime) / (maxTime - minTime)) * plotWidth);
  const toY = (value) => MARGIN.top + plotHeight - (value / yMax) * plotHeight;
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${toX(point.time).toFixed(1)},${toY(point.value).toFixed(1)}`).join('');
  const areaPath = `${linePath}L${toX(maxTime).toFixed(1)},${toY(0)}L${toX(minTime).toFixed(1)},${toY(0)}Z`;
  const xTicks = niceTimeTicks(minTime, maxTime, Math.max(2, Math.floor(plotWidth / 110)));

  const handlePointer = (pointerEvent) => {
    const bounds = pointerEvent.currentTarget.getBoundingClientRect();
    const time = minTime + ((pointerEvent.clientX - bounds.left - MARGIN.left) / plotWidth) * (maxTime - minTime);
    let nearestIndex = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.time - time) < Math.abs(points[nearestIndex].time - time)) nearestIndex = index;
    });
    setHoverIndex(nearestIndex);
  };
  const hovered = hoverIndex === null ? null : points[hoverIndex];

  return (
    <div ref={containerRef} className="chart" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} onPointerMove={handlePointer} onPointerLeave={() => setHoverIndex(null)}>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={toY(tick)} y2={toY(tick)} />
              <text className="chart-axis-label" x={MARGIN.left - 8} y={toY(tick)} dy="0.32em" textAnchor="end">{formatValue(tick)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick.time} className="chart-axis-label" x={toX(tick.time)} y={height - 6} textAnchor="middle">{tick.label}</text>
          ))}
          <path className="chart-area" d={areaPath} />
          <path className="chart-line" d={linePath} />
          {hovered && (
            <g>
              <line className="chart-crosshair" x1={toX(hovered.time)} x2={toX(hovered.time)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />
              <circle className="chart-dot" cx={toX(hovered.time)} cy={toY(hovered.value)} r={5} />
            </g>
          )}
        </svg>
      )}
      {hovered && (
        <ChartTooltip x={toX(hovered.time)} y={Math.max(0, toY(hovered.value) - 40)} width={width}>
          <div className="muted">{formatTime(hovered.time)}</div>
          <strong>{formatValue(hovered.value, true)}</strong>
        </ChartTooltip>
      )}
    </div>
  );
}

/** Month/year ticks between two times, about `count` of them. */
function niceTimeTicks(minTime, maxTime, count) {
  const spanDays = (maxTime - minTime) / 86_400_000;
  const monthStep = spanDays > 365 * 2 ? 6 : spanDays > 365 ? 3 : spanDays > 120 ? 1 : 0;
  const ticks = [];
  if (monthStep === 0) {
    const step = (maxTime - minTime) / count;
    for (let index = 0; index <= count; index++) {
      const time = minTime + step * index;
      ticks.push({ time, label: new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
    }
    return ticks;
  }
  const start = new Date(minTime);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), Math.ceil(start.getUTCMonth() / monthStep) * monthStep, 1));
  while (cursor.getTime() <= maxTime) {
    ticks.push({ time: cursor.getTime(), label: cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' }) });
    cursor.setUTCMonth(cursor.getUTCMonth() + monthStep);
  }
  const maxTicks = Math.max(2, count);
  return ticks.length > maxTicks ? ticks.filter((tick, index) => index % Math.ceil(ticks.length / maxTicks) === 0) : ticks;
}

/**
 * Grouped columns: one group per category (e.g. month), one column per series. With isStacked,
 * one column per group with the series stacked bottom-up, a 2px gap between segments and only
 * the top one rounded; the tooltip adds the total.
 * @param {{ groups: { key: string, label: string, values: Record<string, number> }[], series: { key: string, label: string, className: string }[], formatValue: (value: number, isFull?: boolean) => string, height?: number, label: string, isStacked?: boolean }} props
 */
export function ColumnChart({ groups, series, formatValue, height = 240, label, isStacked = false }) {
  const [containerRef, { width }] = useElementSize();
  const [hoverIndex, setHoverIndex] = useState(null);
  if (groups.length === 0) return <div className="notice">No data yet.</div>;

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const groupTotal = (group) => series.reduce((total, item) => total + (group.values[item.key] ?? 0), 0);
  const yTicks = niceTicks(0, Math.max(...(isStacked
    ? groups.map(groupTotal)
    : groups.flatMap((group) => series.map((item) => group.values[item.key] ?? 0))), 1));
  const yMax = yTicks.at(-1);
  const toY = (value) => MARGIN.top + plotHeight - (value / yMax) * plotHeight;
  const bandWidth = plotWidth / groups.length;
  const columnsPerGroup = isStacked ? 1 : series.length;
  // Narrow bands (many groups) drop the gap between neighbouring columns rather than vanish.
  const bandGap = bandWidth < 6 ? 0 : COLUMN_GAP;
  const columnWidth = Math.max(1, Math.min(MAX_COLUMN_WIDTH, isStacked
    ? bandWidth - bandGap
    : (bandWidth * 0.7 - COLUMN_GAP * (series.length - 1)) / series.length));
  const groupWidth = columnWidth * columnsPerGroup + COLUMN_GAP * (columnsPerGroup - 1);
  const labelEvery = Math.max(1, Math.ceil(groups.length / Math.max(1, Math.floor(plotWidth / 56))));
  const hovered = hoverIndex === null ? null : groups[hoverIndex];

  return (
    <div className="chart-block">
      <div className="chart-legend">
        {series.map((item) => (
          <span key={item.key} className="chart-legend-item"><span className={`chart-swatch ${item.className}`} />{item.label}</span>
        ))}
      </div>
      <div ref={containerRef} className="chart" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setHoverIndex(null)}>
            {yTicks.map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={toY(tick)} y2={toY(tick)} />
                <text className="chart-axis-label" x={MARGIN.left - 8} y={toY(tick)} dy="0.32em" textAnchor="end">{formatValue(tick)}</text>
              </g>
            ))}
            {groups.map((group, groupIndex) => {
              const groupX = MARGIN.left + bandWidth * groupIndex + (bandWidth - groupWidth) / 2;
              return (
                <g key={group.key} onPointerEnter={() => setHoverIndex(groupIndex)}>
                  {/* A hit target the full height of the band, bigger than the columns. */}
                  <rect className={hoverIndex === groupIndex ? 'chart-band chart-band-hover' : 'chart-band'} x={MARGIN.left + bandWidth * groupIndex} y={MARGIN.top} width={bandWidth} height={plotHeight} />
                  {isStacked && stackedSegments(group, series, toY).map((segment) => (
                    <path
                      key={segment.key}
                      className={`chart-column ${segment.className}`}
                      d={segment.isTop
                        ? roundedTopColumn(groupX, segment.top, columnWidth, segment.bottom - segment.top)
                        : `M${groupX},${segment.bottom}V${segment.top}H${groupX + columnWidth}V${segment.bottom}Z`}
                    />
                  ))}
                  {!isStacked && series.map((item, seriesIndex) => {
                    const value = group.values[item.key] ?? 0;
                    const columnHeight = Math.max(0, toY(0) - toY(value));
                    return columnHeight > 0 && (
                      <path
                        key={item.key}
                        className={`chart-column ${item.className}`}
                        d={roundedTopColumn(groupX + seriesIndex * (columnWidth + COLUMN_GAP), toY(value), columnWidth, columnHeight)}
                      />
                    );
                  })}
                  {groupIndex % labelEvery === 0 && (
                    <text className="chart-axis-label" x={groupX + groupWidth / 2} y={height - 6} textAnchor="middle">{group.label}</text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hovered && (
          <ChartTooltip x={MARGIN.left + bandWidth * (hoverIndex + 0.5)} y={MARGIN.top} width={width}>
            <div className="muted">{hovered.fullLabel ?? hovered.label}</div>
            {(isStacked ? [...series].reverse() : series).map((item) => (
              <div key={item.key} className="chart-tooltip-row">
                <span className={`chart-swatch ${item.className}`} />{item.label}<strong>{formatValue(hovered.values[item.key] ?? 0, true)}</strong>
              </div>
            ))}
            {isStacked && (
              <div className="chart-tooltip-row chart-tooltip-total">Total<strong>{formatValue(groupTotal(hovered), true)}</strong></div>
            )}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

/** A column path with a 4px rounded top and a square base. */
function roundedTopColumn(x, y, width, height) {
  const radius = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

/**
 * A stacked column's segments, bottom-up in series order. Each segment but the top one stops
 * COLUMN_GAP short of the next, leaving a gap of chart surface between them.
 */
function stackedSegments(group, series, toY) {
  const nonEmpty = series.filter((item) => (group.values[item.key] ?? 0) > 0);
  let runningTotal = 0;
  return nonEmpty.map((item, index) => {
    const bottom = toY(runningTotal);
    runningTotal += group.values[item.key];
    const isTop = index === nonEmpty.length - 1;
    const top = toY(runningTotal) + (isTop ? 0 : COLUMN_GAP);
    return { key: item.key, className: item.className, isTop, top: Math.min(top, bottom), bottom };
  }).filter((segment) => segment.bottom - segment.top > 0.5);
}

const SCATTER_MARGIN = { top: 12, right: 16, bottom: 42, left: 64 };
const SCATTER_HIT_RADIUS = 14;

/**
 * Dots on two linear axes from zero, coloured by series (at most three plus "Other"; the page
 * folds the rest), each with a 2px ring of chart surface so overlapping dots stay apart.
 * Hovering finds the nearest dot within a hit radius bigger than the dot.
 * @param {{ points: { key: string|number, x: number, y: number, seriesKey: string }[], series: { key: string, label: string, className: string }[], formatX: (value: number) => string, formatY: (value: number) => string, xLabel: string, yLabel: string, renderTooltip: (point: object) => any, height?: number, label: string }} props
 */
export function ScatterChart({ points, series, formatX, formatY, xLabel, yLabel, renderTooltip, height = 300, label }) {
  const [containerRef, { width }] = useElementSize();
  const [hoverKey, setHoverKey] = useState(null);
  if (points.length === 0) return <div className="notice">No data yet.</div>;

  const plotWidth = Math.max(0, width - SCATTER_MARGIN.left - SCATTER_MARGIN.right);
  const plotHeight = height - SCATTER_MARGIN.top - SCATTER_MARGIN.bottom;
  const xTicks = niceTicks(0, Math.max(...points.map((point) => point.x), 1), Math.max(2, Math.floor(plotWidth / 90)));
  const yTicks = niceTicks(0, Math.max(...points.map((point) => point.y), 1));
  const toX = (value) => SCATTER_MARGIN.left + (value / xTicks.at(-1)) * plotWidth;
  const toY = (value) => SCATTER_MARGIN.top + plotHeight - (value / yTicks.at(-1)) * plotHeight;
  const seriesIndex = new Map(series.map((item, index) => [item.key, index]));
  const seriesByKey = new Map(series.map((item) => [item.key, item]));
  // The first series is drawn last, on top; "Other" (listed last) goes underneath.
  const drawOrder = [...points].sort((first, second) => (seriesIndex.get(second.seriesKey) ?? 99) - (seriesIndex.get(first.seriesKey) ?? 99));

  const handlePointer = (pointerEvent) => {
    const bounds = pointerEvent.currentTarget.getBoundingClientRect();
    const pointerX = pointerEvent.clientX - bounds.left;
    const pointerY = pointerEvent.clientY - bounds.top;
    let nearest = null;
    let nearestDistance = SCATTER_HIT_RADIUS;
    for (const point of points) {
      const distance = Math.hypot(toX(point.x) - pointerX, toY(point.y) - pointerY);
      if (distance <= nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    setHoverKey(nearest?.key ?? null);
  };
  const hovered = hoverKey === null ? null : points.find((point) => point.key === hoverKey);

  return (
    <div className="chart-block">
      <div className="chart-legend">
        {series.map((item) => (
          <span key={item.key} className="chart-legend-item"><span className={`chart-swatch chart-swatch-dot ${item.className}`} />{item.label}</span>
        ))}
      </div>
      <div ref={containerRef} className="chart" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={label} onPointerMove={handlePointer} onPointerLeave={() => setHoverKey(null)}>
            {yTicks.map((tick) => (
              <g key={`y${tick}`}>
                <line className="chart-grid" x1={SCATTER_MARGIN.left} x2={width - SCATTER_MARGIN.right} y1={toY(tick)} y2={toY(tick)} />
                <text className="chart-axis-label" x={SCATTER_MARGIN.left - 8} y={toY(tick)} dy="0.32em" textAnchor="end">{formatY(tick)}</text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <text key={`x${tick}`} className="chart-axis-label" x={toX(tick)} y={SCATTER_MARGIN.top + plotHeight + 16} textAnchor="middle">{formatX(tick)}</text>
            ))}
            <text className="chart-axis-title" x={SCATTER_MARGIN.left + plotWidth / 2} y={height - 4} textAnchor="middle">{xLabel}</text>
            <text className="chart-axis-title" transform={`translate(12 ${SCATTER_MARGIN.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
            {drawOrder.map((point) => (
              <circle
                key={point.key}
                className={`chart-point ${seriesByKey.get(point.seriesKey)?.className ?? ''}`}
                cx={toX(point.x)}
                cy={toY(point.y)}
                r={point.key === hoverKey ? 6 : 4}
              />
            ))}
          </svg>
        )}
        {hovered && (
          <ChartTooltip x={toX(hovered.x)} y={Math.max(0, toY(hovered.y) - 50)} width={width}>
            {renderTooltip(hovered)}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

// Sequential blue for the dark surface: more is lighter, in five steps, the darkest still clear
// of the surface.
const HEATMAP_STEPS = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'];
const HEATMAP_LABEL_WIDTH = 40;
const HEATMAP_CELL_GAP = 2;

/**
 * A grid of rows by columns, each cell shaded by its value in five steps of one hue (empty cells
 * are left as the raised surface). Hovering a cell shows its tooltip.
 * @param {{ rows: { key: string|number, label: string }[], columns: { key: string|number, label: string|null }[], getValue: (rowKey, columnKey) => number, renderTooltip: (rowKey, columnKey, value: number) => any, formatValue: (value: number) => string, label: string }} props
 */
export function HeatmapChart({ rows, columns, getValue, renderTooltip, formatValue, label }) {
  const [containerRef, { width }] = useElementSize();
  const [hovered, setHovered] = useState(null);
  const maxValue = Math.max(0, ...rows.flatMap((row) => columns.map((column) => getValue(row.key, column.key))));

  const cellWidth = Math.max(4, (width - HEATMAP_LABEL_WIDTH) / columns.length);
  const cellHeight = Math.min(26, Math.max(14, cellWidth * 0.8));
  const height = rows.length * cellHeight + 22;
  const stepOf = (value) => Math.min(HEATMAP_STEPS.length - 1, Math.floor((value / maxValue) * HEATMAP_STEPS.length));

  if (maxValue === 0) return <div className="notice">No data yet.</div>;
  return (
    <div className="chart-block">
      <div ref={containerRef} className="chart" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setHovered(null)}>
            {rows.map((row, rowIndex) => (
              <g key={row.key}>
                <text className="chart-axis-label" x={0} y={rowIndex * cellHeight + cellHeight / 2} dy="0.32em">{row.label}</text>
                {columns.map((column, columnIndex) => {
                  const value = getValue(row.key, column.key);
                  const isHovered = hovered?.rowKey === row.key && hovered?.columnKey === column.key;
                  return (
                    <rect
                      key={column.key}
                      className={value > 0 ? 'chart-heat-cell' : 'chart-heat-cell chart-heat-empty'}
                      style={value > 0 ? { fill: HEATMAP_STEPS[stepOf(value)] } : undefined}
                      x={HEATMAP_LABEL_WIDTH + columnIndex * cellWidth}
                      y={rowIndex * cellHeight}
                      width={Math.max(1, cellWidth - HEATMAP_CELL_GAP)}
                      height={cellHeight - HEATMAP_CELL_GAP}
                      rx={2}
                      strokeWidth={isHovered ? 2 : 0}
                      onPointerEnter={() => setHovered({ rowKey: row.key, columnKey: column.key, value, x: HEATMAP_LABEL_WIDTH + (columnIndex + 0.5) * cellWidth, y: rowIndex * cellHeight })}
                    />
                  );
                })}
              </g>
            ))}
            {columns.map((column, columnIndex) => column.label !== null && (
              <text key={column.key} className="chart-axis-label" x={HEATMAP_LABEL_WIDTH + columnIndex * cellWidth} y={height - 6}>{column.label}</text>
            ))}
          </svg>
        )}
        {hovered && (
          <ChartTooltip x={hovered.x} y={Math.max(0, hovered.y - 46)} width={width}>
            {renderTooltip(hovered.rowKey, hovered.columnKey, hovered.value)}
          </ChartTooltip>
        )}
      </div>
      <div className="chart-scale" aria-hidden="true">
        <span>{formatValue(0)}</span>
        {HEATMAP_STEPS.map((color) => <span key={color} className="chart-scale-step" style={{ background: color }} />)}
        <span>{formatValue(maxValue)}</span>
      </div>
    </div>
  );
}
