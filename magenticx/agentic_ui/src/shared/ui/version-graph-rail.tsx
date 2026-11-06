import { cn } from "@/shared/lib/utils";
import { LANE_WIDTH, NODE_Y, railWidth, type GraphRow } from "@/shared/lib/versionHistory";

// One colour per lane, cycling; lane 0 is the primary line.
const LANE_STROKES = [
  "stroke-primary/60",
  "stroke-sky-500/60",
  "stroke-amber-500/70",
  "stroke-emerald-500/60",
  "stroke-rose-500/60",
];
const LANE_FILLS = ["bg-primary", "bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-rose-500"];

const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
const stroke = (lane: number) => LANE_STROKES[lane % LANE_STROKES.length];

/**
 * One row's slice of the version graph, filling the row's height: lanes that
 * pass by, lanes that end in this version's dot (curving in from their own
 * column when it is another branch), and the line down to the version it was
 * saved on top of. The lines run to the row's bottom edge, so they continue
 * through an opened row into the next.
 */
export function VersionGraphRail({
  row,
  lanes,
  current,
}: {
  row: GraphRow;
  lanes: number;
  current: boolean;
}) {
  const width = railWidth(lanes);
  const x = laneX(row.lane);
  return (
    <span className="pointer-events-none absolute inset-y-0 left-3" style={{ width }} aria-hidden>
      <svg width={width} height="100%" className="absolute inset-0 overflow-visible" fill="none">
        {row.through.map((lane) => (
          <line
            key={`t${lane}`}
            x1={laneX(lane)}
            x2={laneX(lane)}
            y1={0}
            y2="100%"
            strokeWidth={1.5}
            className={stroke(lane)}
          />
        ))}
        {row.joins.map((lane) => {
          const from = laneX(lane);
          return (
            <path
              key={`j${lane}`}
              d={
                from === x
                  ? `M ${x} 0 L ${x} ${NODE_Y}`
                  : `M ${from} 0 C ${from} ${NODE_Y * 0.7}, ${x} ${NODE_Y * 0.3}, ${x} ${NODE_Y}`
              }
              strokeWidth={1.5}
              className={stroke(lane)}
            />
          );
        })}
        {row.down ? (
          <line
            x1={x}
            x2={x}
            y1={NODE_Y}
            y2="100%"
            strokeWidth={1.5}
            className={stroke(row.lane)}
          />
        ) : null}
      </svg>
      <span
        className={cn(
          "absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2",
          current ? "ring-primary/30" : "ring-background",
          LANE_FILLS[row.lane % LANE_FILLS.length],
          !current && "opacity-80",
        )}
        style={{ left: x, top: NODE_Y }}
      />
    </span>
  );
}
