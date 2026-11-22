import { useEffect, useRef, useState } from 'react';

/**
 * Small hand-drawn SVG charts. Marks follow one spec: 2px lines with a faint area wash, columns at
 * most 24px wide with a 4px rounded cap, a 2px gap between neighbouring columns, hairline grid
 * lines, and a hover tooltip on every chart.
 */
const MARGIN = { top: 12, right: 16, bottom: 26, left: 64 };
const MAX_COLUMN_WIDTH = 24;
const COLUMN_GAP = 2;

/** The rendered width of an element, kept up to date as it resizes. */
function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

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
  const [containerRef, width] = useElementWidth();
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
 * Grouped columns: one group per category (e.g. month), one column per series.
 * @param {{ groups: { key: string, label: string, values: Record<string, number> }[], series: { key: string, label: string, className: string }[], formatValue: (value: number, isFull?: boolean) => string, height?: number, label: string }} props
 */
export function ColumnChart({ groups, series, formatValue, height = 240, label }) {
  const [containerRef, width] = useElementWidth();
  const [hoverIndex, setHoverIndex] = useState(null);
  if (groups.length === 0) return <div className="notice">No data yet.</div>;

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const yTicks = niceTicks(0, Math.max(...groups.flatMap((group) => series.map((item) => group.values[item.key] ?? 0)), 1));
  const yMax = yTicks.at(-1);
  const toY = (value) => MARGIN.top + plotHeight - (value / yMax) * plotHeight;
  const bandWidth = plotWidth / groups.length;
  const columnWidth = Math.max(2, Math.min(MAX_COLUMN_WIDTH, (bandWidth * 0.7 - COLUMN_GAP * (series.length - 1)) / series.length));
  const groupWidth = columnWidth * series.length + COLUMN_GAP * (series.length - 1);
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
                  {series.map((item, seriesIndex) => {
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
            {series.map((item) => (
              <div key={item.key} className="chart-tooltip-row">
                <span className={`chart-swatch ${item.className}`} />{item.label}<strong>{formatValue(hovered.values[item.key] ?? 0, true)}</strong>
              </div>
            ))}
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
