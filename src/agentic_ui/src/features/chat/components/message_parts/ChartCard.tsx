import { useCallback, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { BarChart3, Download, Loader2 } from "lucide-react";
import type { ChartBlock, ChartSeries } from "@/shared/lib/types";
import { downloadChartPng } from "@/features/chat/lib/chartExport";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/shared/ui/chart";

type ChartCardProps = {
  block: ChartBlock;
};

// The theme's chart palette, referenced by index. The agent never sends a
// color: it sends data, and the viewer's theme decides how that data looks —
// which is what keeps a chart readable in both modes and satisfies the
// no-raw-hex rule. Wrapping past five series is safe because the tool caps
// series at six and adjacent hues stay distinguishable.
const PALETTE_SIZE = 5;
const seriesColor = (index: number) => `hsl(var(--chart-${(index % PALETTE_SIZE) + 1}))`;

// The donut centre has room for a number, not a sentence — 1.2M reads where
// 1204893 does not. Locale-aware so a Greek viewer sees Greek grouping.
const formatCompact = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);

/**
 * Render a chart the agent drew via `render_chart`, inline in the run timeline.
 *
 * Purely presentational: every value shown — title, subtitle, axis, series and
 * points — arrives on the block, already validated, numerically coerced, and
 * reconciled against the chart type by the agents service. This component
 * decides only how it looks, never what it says, so there is no place for a
 * rendering bug to invent or drop a number.
 */
export function ChartCard({ block }: ChartCardProps) {
  const figureRef = useRef<HTMLElement>(null);
  const [exporting, setExporting] = useState(false);
  const isMobile = useIsMobile();
  const { toast } = useToast();

  // The export reads the *rendered* SVG, so it has to run against the live DOM
  // rather than the block alone — hence the ref instead of a pure helper call.
  const exportPng = useCallback(async () => {
    const figure = figureRef.current;
    if (!figure || exporting) return;
    setExporting(true);
    try {
      await downloadChartPng(figure, block);
    } catch (error) {
      toastError(toast, "Could not save the chart", error);
    } finally {
      setExporting(false);
    }
  }, [block, exporting, toast]);

  // Pie and radial colour per ROW, and their legend/tooltip look entries up by
  // CATEGORY name (`nameKey`), not by series key. Keying the config by series
  // there leaves `itemConfig?.label` undefined and the legend renders bare
  // swatches with no text. Colour is omitted for that shape on purpose: the
  // marks already carry it via <Cell>, and a config colour would emit an
  // invalid `--color-Organic Search` custom property from a spaced label.
  const perRowLegend = block.chartType === "pie" || block.chartType === "radial";
  const config = useMemo<ChartConfig>(() => {
    if (perRowLegend) {
      return Object.fromEntries(
        block.data.map((row) => {
          const name = String(row[block.xKey] ?? "");
          return [name, { label: name }];
        }),
      );
    }
    // ChartContainer keys its CSS variables off the config, so
    // `var(--color-<key>)` resolves per series without touching a raw hex.
    return Object.fromEntries(
      block.series.map((s, i) => [s.key, { label: s.label, color: seriesColor(i) }]),
    );
  }, [perRowLegend, block.series, block.data, block.xKey]);

  // A single-measure pie reads best with its total in the middle — that is
  // usually the number the reader wants, and the slices answer "of what".
  const total = useMemo(() => {
    if (block.chartType !== "pie" || block.series.length !== 1) return null;
    const key = block.series[0].key;
    return block.data.reduce<number>((sum, row) => {
      const v = row[key];
      return typeof v === "number" ? sum + v : sum;
    }, 0);
  }, [block.chartType, block.series, block.data]);

  const axisProps = {
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    className: "text-[10px] fill-muted-foreground",
  } as const;

  const grid = (
    <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
  );
  const legend = block.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null;
  // Only meaningful where the tool allows it; `stacked` arrives already
  // reconciled against the type, so trusting it here is safe.
  const stackId = block.stacked ? "stack" : undefined;

  const valueLabels = (key: string) =>
    block.showValues ? (
      <LabelList dataKey={key} position="top" className="fill-muted-foreground text-[10px]" />
    ) : null;

  // Composed charts let each series pick its own mark and y-axis; every other
  // type draws all series the same way.
  const drawSeries = (s: ChartSeries, kind: "bar" | "line" | "area") => {
    const color = `var(--color-${s.key})`;
    const yAxisId = block.chartType === "composed" ? (s.axis ?? "left") : undefined;
    if (kind === "line") {
      return (
        <Line
          key={s.key}
          yAxisId={yAxisId}
          dataKey={s.key}
          type="monotone"
          stroke={color}
          strokeWidth={2}
          dot={false}
          // A null measure is a real gap in the data, so leave the line broken
          // rather than interpolating a value the agent never gave.
          connectNulls={false}
        >
          {valueLabels(s.key)}
        </Line>
      );
    }
    if (kind === "area") {
      return (
        <Area
          key={s.key}
          yAxisId={yAxisId}
          dataKey={s.key}
          type="monotone"
          stackId={stackId}
          stroke={color}
          fill={color}
          fillOpacity={0.18}
          strokeWidth={2}
          connectNulls={false}
        >
          {valueLabels(s.key)}
        </Area>
      );
    }
    return (
      <Bar
        key={s.key}
        yAxisId={yAxisId}
        dataKey={s.key}
        stackId={stackId}
        fill={color}
        radius={block.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
      >
        {valueLabels(s.key)}
      </Bar>
    );
  };

  const body = () => {
    switch (block.chartType) {
      case "pie":
        return (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey={block.xKey} />} />
            <Pie
              data={block.data}
              dataKey={block.series[0].key}
              nameKey={block.xKey}
              innerRadius="50%"
            >
              {block.data.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
              {total !== null ? (
                <Label
                  position="center"
                  className="fill-foreground text-lg font-semibold"
                  value={formatCompact(total)}
                />
              ) : null}
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey={block.xKey} />} />
          </PieChart>
        );

      case "radial":
        return (
          <RadialBarChart data={block.data} innerRadius="25%" outerRadius="95%">
            <ChartTooltip content={<ChartTooltipContent nameKey={block.xKey} />} />
            <RadialBar dataKey={block.series[0].key} background cornerRadius={4}>
              {block.data.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
            </RadialBar>
            <ChartLegend content={<ChartLegendContent nameKey={block.xKey} />} />
          </RadialBarChart>
        );

      case "radar":
        return (
          <RadarChart data={block.data}>
            <ChartTooltip content={<ChartTooltipContent />} />
            <PolarGrid className="stroke-border/60" />
            <PolarAngleAxis dataKey={block.xKey} className="text-[10px] fill-muted-foreground" />
            {block.series.map((s) => (
              <Radar
                key={s.key}
                dataKey={s.key}
                stroke={`var(--color-${s.key})`}
                fill={`var(--color-${s.key})`}
                fillOpacity={0.2}
                strokeWidth={2}
              />
            ))}
            {legend}
          </RadarChart>
        );

      case "scatter":
        return (
          <ScatterChart data={block.data} margin={{ left: 4, right: 8 }}>
            {grid}
            {/* x is numeric here, unlike every other type where it's a label. */}
            <XAxis type="number" dataKey={block.xKey} name={block.xKey} {...axisProps} />
            <YAxis type="number" {...axisProps} width={40} />
            <ZAxis range={[60, 60]} />
            <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<ChartTooltipContent />} />
            {block.series.map((s) => (
              <Scatter key={s.key} name={s.label} dataKey={s.key} fill={`var(--color-${s.key})`} />
            ))}
            {legend}
          </ScatterChart>
        );

      case "composed":
        return (
          <ComposedChart data={block.data} margin={{ left: 4, right: 8 }}>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis yAxisId="left" {...axisProps} width={40} />
            {/* Only mounted when a series actually asked for it, so a
                single-scale composed chart doesn't grow a dead axis. */}
            {block.series.some((s) => s.axis === "right") ? (
              <YAxis yAxisId="right" orientation="right" {...axisProps} width={40} />
            ) : null}
            <ChartTooltip content={<ChartTooltipContent />} />
            {block.series.map((s) => drawSeries(s, s.type ?? "bar"))}
            {legend}
          </ComposedChart>
        );

      case "line":
        return (
          <LineChart data={block.data} margin={{ left: 4, right: 8 }}>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis {...axisProps} width={40} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {block.series.map((s) => drawSeries(s, "line"))}
            {legend}
          </LineChart>
        );

      case "area":
        return (
          <AreaChart data={block.data} margin={{ left: 4, right: 8 }}>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis {...axisProps} width={40} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {block.series.map((s) => drawSeries(s, "area"))}
            {legend}
          </AreaChart>
        );

      default:
        return (
          <BarChart
            data={block.data}
            layout={block.horizontal ? "vertical" : "horizontal"}
            margin={{ left: 4, right: 8 }}
          >
            <CartesianGrid
              vertical={Boolean(block.horizontal)}
              horizontal={!block.horizontal}
              strokeDasharray="3 3"
              className="stroke-border/50"
            />
            {/* Horizontal bars swap the axis roles: the category moves to y and
                the measure to x, which is the whole point of the layout. */}
            {block.horizontal ? (
              <>
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey={block.xKey} width={96} {...axisProps} />
              </>
            ) : (
              <>
                <XAxis dataKey={block.xKey} {...axisProps} />
                <YAxis {...axisProps} width={40} />
              </>
            )}
            <ChartTooltip content={<ChartTooltipContent />} />
            {block.series.map((s) => drawSeries(s, "bar"))}
            {legend}
          </BarChart>
        );
    }
  };

  return (
    <div className="w-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
      <figure
        ref={figureRef}
        className="group/chart relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-muted/40 to-muted/5 p-3.5"
      >
        {/* Mirrors ArtifactCard: revealed on hover or keyboard focus so a long
            conversation isn't peppered with buttons. Mobile has no hover, so
            the action stays visible there instead of being unreachable. */}
        <div
          className={`absolute right-2.5 top-2.5 z-10 transition-opacity duration-200 ${
            isMobile
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover/chart:pointer-events-auto group-hover/chart:opacity-100 group-focus-within/chart:pointer-events-auto group-focus-within/chart:opacity-100"
          }`}
        >
          <button
            type="button"
            onClick={exportPng}
            disabled={exporting}
            aria-label={`Download ${block.title} as an image`}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border/50 bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition hover:scale-105 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Download size={14} aria-hidden="true" />
            )}
          </button>
        </div>

        <figcaption className="mb-2 pr-9">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary/70">
            <BarChart3 size={11} aria-hidden="true" />
            <span>Chart</span>
          </div>
          <div className="mt-1.5 truncate text-sm font-semibold text-foreground">{block.title}</div>
          {block.subtitle ? (
            <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
              {block.subtitle}
            </div>
          ) : null}
        </figcaption>
        <ChartContainer
          config={config}
          className="aspect-auto h-56 w-full"
          // The visual is decorative to a screen reader — the surrounding
          // assistant text describes the finding, and the tool prompts the
          // agent to do exactly that. The title still names it.
          role="img"
          aria-label={block.subtitle ? `${block.title}. ${block.subtitle}` : block.title}
        >
          {body()}
        </ChartContainer>
      </figure>
    </div>
  );
}
